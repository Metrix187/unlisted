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

// hf's dinov2 processor resizes the short edge to 256 and center-crops 224. callers hand matchingNoise the
// photo already at that short edge, so the attacker's view is a straight slice instead of a guess
export const WORK = 256;

// the size to hand matchingNoise: short edge WORK, long edge snapped to a multiple of 32 (capped) so the
// gpu only ever sees a handful of shapes. the delta gets stretched back over the real aspect anyway
export function workSize(width: number, height: number) {
  const long = Math.min(
    2 * WORK,
    Math.max(WORK, Math.round((Math.max(width, height) * WORK) / Math.min(width, height) / 32) * 32),
  );
  return width >= height ? { width: long, height: WORK } : { width: WORK, height: long };
}

// rgb, 0..1, row-major hwc
export type Planar = { data: Float32Array; width: number; height: number };

export type NoiseOpts = {
  eps?: number;
  steps?: number;
  alpha?: number;
  // the perturbation lives on a coarser grid (this many cells along the short edge) and gets upsampled.
  // smoother noise survives the attacker's own resize/crop much better than per-pixel speckle does
  paramRes?: number;
  // views per step, run in pairs. the first two are always the dino + clip crops
  views?: number;
  momentum?: number;
  onStep?: (step: number, steps: number, sim: number) => void;
};

// blur: 0 = none, otherwise squeeze to blur×blur and back up to 224
type View = { y: number; x: number; h: number; w: number; blur: number };

// center square covering `frac` of the short edge. frac 224/256 = dino's crop, 1 = clip's
function centerView(W: number, H: number, frac: number): View {
  const s = Math.round(Math.min(W, H) * frac);
  return { y: (H - s) >> 1, x: (W - s) >> 1, h: s, w: s, blur: 0 };
}

// sizes come from a short fixed list on purpose. webgpu builds a pipeline per tensor shape, so random sizes
// every step would mean shader compiles every step. boring, cacheable shapes only
const CROPS = [160, 192, 224, 256];
const BLURS = [112, 160];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

// everything we can't predict about the other end: a different crop, someone cropping before they post,
// the whole frame squashed, jpeg eating the fine detail. doesn't need to be exact, just varied enough
// that the noise stops leaning on one particular pixel grid
function randomView(W: number, H: number): View {
  let v: View;
  const short = Math.min(W, H);
  const crops = CROPS.filter((c) => c <= short);
  if (Math.random() < 0.2 || !crops.length) v = { y: 0, x: 0, h: H, w: W, blur: 0 };
  else {
    const s = pick(crops);
    v = {
      y: Math.floor(Math.random() * (H - s + 1)),
      x: Math.floor(Math.random() * (W - s + 1)),
      h: s,
      w: s,
      blur: 0,
    };
  }
  // down-and-back-up is a cheap differentiable stand-in for jpeg / a soft resampler
  if (Math.random() < 0.5) v.blur = pick(BLURS);
  return v;
}

function render(img: tf.Tensor4D, v: View): tf.Tensor4D {
  const [, H, W] = img.shape;
  let c = v.y || v.x || v.h !== H || v.w !== W ? tf.slice(img, [0, v.y, v.x, 0], [1, v.h, v.w, 3]) : img;
  if (v.blur) c = tf.image.resizeBilinear(c, [v.blur, v.blur]);
  return c.shape[1] === SIZE && c.shape[2] === SIZE ? c : tf.image.resizeBilinear(c, [SIZE, SIZE]);
}

// the 224 square the attacker's dinov2 actually looks at, given a WORK-sized photo
export function centerCrop(p: Planar, frac = SIZE / WORK): Float32Array {
  const v = centerView(p.width, p.height, frac);
  if (v.w === SIZE) {
    const out = new Float32Array(SIZE * SIZE * 3);
    for (let y = 0; y < SIZE; y++) {
      const s = ((v.y + y) * p.width + v.x) * 3;
      out.set(p.data.subarray(s, s + SIZE * 3), y * SIZE * 3);
    }
    return out;
  }
  // odd sizes (tests, tiny photos) go through tf
  const t = tf.tidy(() => render(tf.tensor4d(p.data, [1, p.height, p.width, 3]), v));
  const out = t.dataSync() as Float32Array;
  t.dispose();
  return out;
}

// iterative fgsm with momentum, averaged over random views of the photo each step (expectation over
// transformation). the old version attacked one 224 squash of the frame and hit ~-0.05 self-similarity
// there, then the attacker's resize + center crop shifted the patch grid and it was basically gone.
// img is the photo at short edge WORK. returns a same-sized delta to stretch over the full image
export async function matchingNoise(dino: Dino, img: Planar, opts: NoiseOpts = {}) {
  const eps = opts.eps ?? 4 / 255;
  const steps = opts.steps ?? 10;
  const alpha = opts.alpha ?? 1 / 255;
  const nViews = Math.max(2, opts.views ?? 4);
  const mu = opts.momentum ?? 1;
  const { width: W, height: H } = img;
  const rs = (opts.paramRes ?? 128) / Math.min(W, H);
  const PH = Math.max(1, Math.round(H * rs));
  const PW = Math.max(1, Math.round(W * rs));

  const x = tf.tensor4d(img.data, [1, H, W, 3]);
  const fixed = [centerView(W, H, SIZE / WORK), centerView(W, H, 1)];
  // push every view away from the clean photo as a matcher would see it. one target for all views keeps
  // this to a single clean forward pass
  const [target, dinoClean] = tf.tidy(() => {
    const e = dino.embed(
      tf.concat(
        fixed.map((v) => render(x, v)),
        0,
      ),
    );
    const m = e.mean(0, true);
    return [m.div(tf.norm(m, 2, -1, true)), e.slice([0, 0], [1, DIM])];
  });
  // random start inside the ε-ball (madry-style pgd). starting at δ = 0 is the one place the gradient is
  // exactly zero, since the image is maximally similar to itself there. webgpu's float fuzz happened to
  // kick it loose; cpu/wasm math is exact and the attack just sat there
  let dp = tf.randomUniform([1, PH, PW, 3], -eps, eps) as tf.Tensor4D;
  let mom: tf.Tensor = tf.zerosLike(dp);

  const advOf = (d: tf.Tensor4D) =>
    tf.clipByValue(x.add(tf.image.resizeBilinear(d, [H, W])), 0, 1) as tf.Tensor4D;
  let views = fixed;
  const vg = tf.valueAndGrad((d: tf.Tensor) => {
    const adv = advOf(d as tf.Tensor4D);
    const e = dino.embed(
      tf.concat(
        views.map((v) => render(adv, v)),
        0,
      ),
    );
    return tf.sum(tf.matMul(e, target, false, true));
  });

  for (let s = 0; s < steps; s++) {
    const all = [...fixed, ...Array.from({ length: nViews - 2 }, () => randomView(W, H))];
    // two views per pass, max. a batch of 3+ through embed hangs tfjs-webgpu outright on an rtx 4060 (and
    // takes the driver down with it). no idea which kernel, batch 1 and 2 are fine and fast, so pairs it is
    let g = tf.zerosLike(dp) as tf.Tensor;
    let total = 0;
    for (let i = 0; i < all.length; i += 2) {
      views = all.slice(i, i + 2);
      const r = vg(dp);
      const ng = g.add(r.grad);
      total += (await r.value.data())[0];
      for (const t of [r.value, r.grad, g]) t.dispose();
      g = ng;
    }
    const sim = total / all.length;
    const [nextMom, next] = tf.tidy(() => {
      // mi-fgsm: l1-normalize then accumulate. stops the sign from flipping around between random views,
      // and it's known to transfer better to models we never saw
      const m = mom.mul(mu).add(g.div(tf.mean(tf.abs(g)).add(1e-12)));
      return [m, tf.clipByValue(dp.sub(tf.sign(m).mul(alpha)), -eps, eps) as tf.Tensor4D];
    });
    for (const t of [g, mom, dp]) t.dispose();
    mom = nextMom;
    dp = next;
    opts.onStep?.(s + 1, steps, sim);
  }
  // report self-similarity in the view that matters most: the attacker's dino crop
  const simT = tf.tidy(() => tf.sum(dino.embed(render(advOf(dp), fixed[0])).mul(dinoClean)));
  const sim = (await simT.data())[0];
  const delta = tf.tidy(() => tf.image.resizeBilinear(dp, [H, W]).reshape([H * W * 3]));
  const out = (await delta.data()) as Float32Array;
  for (const t of [simT, delta, dp, mom, x, target, dinoClean]) t.dispose();
  return { delta: out, width: W, height: H, sim };
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
