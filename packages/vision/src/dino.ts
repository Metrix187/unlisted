import * as tf from "@tensorflow/tfjs-core";
// core alone ships without method chaining or gradients. we want both
import "@tensorflow/tfjs-core/dist/public/chained_ops/register_all_chained_ops";
import "@tensorflow/tfjs-core/dist/register_all_gradients";

// dinov2-small, hand-ported to tfjs so we get real input gradients. transformers.js / onnxruntime-web
// can only run models forward, and you can't do fgsm without a backward pass. weights come straight
// from facebook/dinov2-small's safetensors, same numbers the python side uses.

export const DIM = 384;
const HEADS = 6;
const LAYERS = 12;
const PATCH = 14;
export const SIZE = 224;
const GRID = SIZE / PATCH; // 16
const SRC_GRID = 37; // 518 / 14, what the checkpoint was trained at
const EPS = 1e-6;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

type Raw = { shape: number[]; data: Float32Array };

export function parseSafetensors(buf: Uint8Array): Map<string, Raw> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = Number(view.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + headerLen))) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const base = 8 + headerLen;
  const out = new Map<string, Raw>();
  for (const [name, meta] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    if (meta.dtype !== "F32") throw new Error(`expected f32 weights, got ${meta.dtype} for ${name}`);
    const [s, e] = meta.data_offsets;
    // slice() copies, which also fixes alignment (the data block isn't guaranteed 4-byte aligned)
    const bytes = buf.slice(base + s, base + e);
    out.set(name, { shape: meta.shape, data: new Float32Array(bytes.buffer, bytes.byteOffset, (e - s) / 4) });
  }
  return out;
}

// torch's F.interpolate(mode="bicubic", align_corners=False), no antialias, a = -0.75. that's exactly
// what hf's dinov2 does to squash the 37x37 position grid down to 16x16, so we copy it tap for tap
function cubic(x: number) {
  const a = -0.75;
  const t = Math.abs(x);
  if (t <= 1) return ((a + 2) * t - (a + 3)) * t * t + 1;
  if (t < 2) return (((t - 5) * t + 8) * t - 4) * a;
  return 0;
}

function bicubicTaps(inSize: number, outSize: number) {
  const scale = inSize / outSize;
  const res: { idx: number[]; w: number[] }[] = [];
  for (let i = 0; i < outSize; i++) {
    const src = (i + 0.5) * scale - 0.5;
    const f = Math.floor(src);
    const t = src - f;
    const idx: number[] = [];
    const w: number[] = [];
    for (let k = -1; k <= 2; k++) {
      idx.push(Math.min(inSize - 1, Math.max(0, f + k)));
      w.push(cubic(k - t));
    }
    res.push({ idx, w });
  }
  return res;
}

export function interpolatePosEmbed(
  pos: Float32Array,
  srcGrid = SRC_GRID,
  dstGrid = GRID,
  dim = DIM,
): Float32Array {
  // pos is [1 + src*src, dim]; first row is the cls slot and passes through untouched
  const taps = bicubicTaps(srcGrid, dstGrid);
  const tmp = new Float32Array(srcGrid * dstGrid * dim); // rows: src y, cols: dst x
  for (let y = 0; y < srcGrid; y++)
    for (let x = 0; x < dstGrid; x++) {
      const { idx, w } = taps[x];
      const o = (y * dstGrid + x) * dim;
      for (let k = 0; k < 4; k++) {
        const s = (1 + y * srcGrid + idx[k]) * dim;
        for (let c = 0; c < dim; c++) tmp[o + c] += pos[s + c] * w[k];
      }
    }
  const out = new Float32Array((1 + dstGrid * dstGrid) * dim);
  out.set(pos.subarray(0, dim), 0);
  for (let y = 0; y < dstGrid; y++) {
    const { idx, w } = taps[y];
    for (let x = 0; x < dstGrid; x++) {
      const o = (1 + y * dstGrid + x) * dim;
      for (let k = 0; k < 4; k++) {
        const s = (idx[k] * dstGrid + x) * dim;
        for (let c = 0; c < dim; c++) out[o + c] += tmp[s + c] * w[k];
      }
    }
  }
  return out;
}

type Layer = {
  n1g: tf.Tensor;
  n1b: tf.Tensor;
  q: [tf.Tensor, tf.Tensor];
  k: [tf.Tensor, tf.Tensor];
  v: [tf.Tensor, tf.Tensor];
  o: [tf.Tensor, tf.Tensor];
  ls1: tf.Tensor;
  n2g: tf.Tensor;
  n2b: tf.Tensor;
  fc1: [tf.Tensor, tf.Tensor];
  fc2: [tf.Tensor, tf.Tensor];
  ls2: tf.Tensor;
};

export class Dino {
  private patchW: tf.Tensor;
  private patchB: tf.Tensor;
  private cls: tf.Tensor;
  private pos: tf.Tensor;
  private layers: Layer[] = [];
  private lnG: tf.Tensor;
  private lnB: tf.Tensor;
  private mean: tf.Tensor;
  private std: tf.Tensor;

  constructor(raw: Map<string, Raw>) {
    const t = (name: string, shape?: number[]) => {
      const r = raw.get(name);
      if (!r) throw new Error(`missing weight ${name}`);
      return tf.tensor(r.data, shape ?? r.shape);
    };
    const lin = (p: string): [tf.Tensor, tf.Tensor] => [t(`${p}.weight`), t(`${p}.bias`)];
    const pe = "embeddings.patch_embeddings.projection";
    // conv weight [384, 3, 14, 14] -> [384, 588], matches the (c, kh, kw) patch flattening below
    this.patchW = t(`${pe}.weight`, [DIM, 3 * PATCH * PATCH]);
    this.patchB = t(`${pe}.bias`);
    this.cls = t("embeddings.cls_token", [1, 1, DIM]);
    const pos = raw.get("embeddings.position_embeddings")!;
    this.pos = tf.tensor(interpolatePosEmbed(pos.data), [1, 1 + GRID * GRID, DIM]);
    for (let i = 0; i < LAYERS; i++) {
      const p = `encoder.layer.${i}`;
      this.layers.push({
        n1g: t(`${p}.norm1.weight`),
        n1b: t(`${p}.norm1.bias`),
        q: lin(`${p}.attention.attention.query`),
        k: lin(`${p}.attention.attention.key`),
        v: lin(`${p}.attention.attention.value`),
        o: lin(`${p}.attention.output.dense`),
        ls1: t(`${p}.layer_scale1.lambda1`),
        n2g: t(`${p}.norm2.weight`),
        n2b: t(`${p}.norm2.bias`),
        fc1: lin(`${p}.mlp.fc1`),
        fc2: lin(`${p}.mlp.fc2`),
        ls2: t(`${p}.layer_scale2.lambda1`),
      });
    }
    this.lnG = t("layernorm.weight");
    this.lnB = t("layernorm.bias");
    this.mean = tf.tensor(MEAN, [1, 1, 1, 3]);
    this.std = tf.tensor(STD, [1, 1, 1, 3]);
  }

  private ln(x: tf.Tensor, g: tf.Tensor, b: tf.Tensor) {
    const { mean, variance } = tf.moments(x, -1, true);
    return x
      .sub(mean)
      .mul(tf.rsqrt(variance.add(EPS)))
      .mul(g)
      .add(b);
  }

  private linear(x2d: tf.Tensor, [w, b]: [tf.Tensor, tf.Tensor]) {
    return tf.matMul(x2d, w, false, true).add(b);
  }

  // x: [B, 224, 224, 3] in 0..1. returns the l2-normalized cls embedding [B, 384]
  embed(x: tf.Tensor): tf.Tensor {
    const B = x.shape[0]!;
    const T = 1 + GRID * GRID;
    const norm = x.sub(this.mean).div(this.std);
    const patches = norm
      .reshape([B, GRID, PATCH, GRID, PATCH, 3])
      .transpose([0, 1, 3, 5, 2, 4])
      .reshape([B * GRID * GRID, 3 * PATCH * PATCH]);
    let h = this.linear(patches, [this.patchW, this.patchB]).reshape([B, GRID * GRID, DIM]);
    h = tf.concat([tf.tile(this.cls, [B, 1, 1]), h], 1).add(this.pos);

    const hd = DIM / HEADS;
    const scale = 1 / Math.sqrt(hd);
    const heads = (z: tf.Tensor) =>
      z
        .reshape([B, T, HEADS, hd])
        .transpose([0, 2, 1, 3])
        .reshape([B * HEADS, T, hd]);
    for (const L of this.layers) {
      const a = this.ln(h, L.n1g, L.n1b).reshape([B * T, DIM]);
      const q = heads(this.linear(a, L.q));
      const k = heads(this.linear(a, L.k));
      const v = heads(this.linear(a, L.v));
      const attn = tf.softmax(tf.matMul(q, k, false, true).mul(scale));
      const ctx = tf
        .matMul(attn, v)
        .reshape([B, HEADS, T, hd])
        .transpose([0, 2, 1, 3])
        .reshape([B * T, DIM]);
      h = h.add(this.linear(ctx, L.o).reshape([B, T, DIM]).mul(L.ls1));
      const m = this.ln(h, L.n2g, L.n2b).reshape([B * T, DIM]);
      const f1 = this.linear(m, L.fc1);
      // exact gelu, same as torch's default
      const g = f1.mul(0.5).mul(tf.erf(f1.mul(Math.SQRT1_2)).add(1));
      h = h.add(this.linear(g, L.fc2).reshape([B, T, DIM]).mul(L.ls2));
    }
    const out = this.ln(h, this.lnG, this.lnB);
    const clsTok = out.slice([0, 0, 0], [B, 1, DIM]).reshape([B, DIM]);
    return clsTok.div(tf.norm(clsTok, 2, -1, true));
  }
}

export type NoiseOpts = {
  eps?: number;
  steps?: number;
  alpha?: number;
  // the perturbation lives on a coarser grid and gets upsampled. smoother noise survives the attacker's
  // own resize/crop much better than per-pixel speckle does
  paramRes?: number;
  onStep?: (step: number, steps: number, sim: number) => void;
};

// iterative fgsm (basically pgd with sign steps). pushes the image's embedding away from where it started.
// x224 is [224*224*3] floats in 0..1. returns the 224x224 delta to upsample onto the full image
export async function matchingNoise(dino: Dino, x224: Float32Array, opts: NoiseOpts = {}) {
  const eps = opts.eps ?? 4 / 255;
  const steps = opts.steps ?? 10;
  const alpha = opts.alpha ?? 1 / 255;
  const R = opts.paramRes ?? 112;
  const x = tf.tensor4d(x224, [1, SIZE, SIZE, 3]);
  const target = tf.tidy(() => dino.embed(x));
  let dp = tf.zeros([1, R, R, 3]) as tf.Tensor4D;

  const simOf = (d: tf.Tensor4D) => {
    const up = tf.image.resizeBilinear(d, [SIZE, SIZE]);
    const e = dino.embed(tf.clipByValue(x.add(up), 0, 1));
    return tf.sum(e.mul(target));
  };
  const grad = tf.grad((d: tf.Tensor) => simOf(d as tf.Tensor4D));

  let sim = 1;
  for (let s = 0; s < steps; s++) {
    const g = grad(dp);
    const next = tf.tidy(() => tf.clipByValue(dp.sub(tf.sign(g).mul(alpha)), -eps, eps)) as tf.Tensor4D;
    g.dispose();
    dp.dispose();
    dp = next;
    const simT = tf.tidy(() => simOf(dp));
    sim = (await simT.data())[0];
    simT.dispose();
    opts.onStep?.(s + 1, steps, sim);
  }
  const delta = tf.tidy(() => tf.image.resizeBilinear(dp, [SIZE, SIZE]).reshape([SIZE * SIZE * 3]));
  const out = (await delta.data()) as Float32Array;
  delta.dispose();
  dp.dispose();
  x.dispose();
  target.dispose();
  return { delta: out, sim };
}

export async function similarity(dino: Dino, a224: Float32Array, b224: Float32Array) {
  const s = tf.tidy(() => {
    const ea = dino.embed(tf.tensor4d(a224, [1, SIZE, SIZE, 3]));
    const eb = dino.embed(tf.tensor4d(b224, [1, SIZE, SIZE, 3]));
    return tf.sum(ea.mul(eb));
  });
  const v = (await s.data())[0];
  s.dispose();
  return v;
}

export class NoGpuError extends Error {}

// webgpu or bust, unless the caller explicitly says slow is fine. on wasm a 10-step attack takes minutes,
// which is a bad trade to make for someone without telling them
export async function pickBackend(wasmBase: string, allowSlow = false): Promise<string> {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  if (nav?.gpu) {
    try {
      await import("@tensorflow/tfjs-backend-webgpu");
      if (await tf.setBackend("webgpu")) {
        await tf.ready();
        return "webgpu";
      }
    } catch {
      // adapter missing or blocklisted. fall through
    }
  }
  if (!allowSlow) throw new NoGpuError("no webgpu");
  try {
    const wasm = await import("@tensorflow/tfjs-backend-wasm");
    wasm.setWasmPaths(wasmBase);
    if (await tf.setBackend("wasm")) {
      await tf.ready();
      return "wasm";
    }
  } catch {
    // no wasm either. cpu is the "it technically runs" option
  }
  await import("@tensorflow/tfjs-backend-cpu");
  await tf.setBackend("cpu");
  await tf.ready();
  return "cpu";
}
