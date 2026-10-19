import { ImageSegmenter, ObjectDetector } from "@mediapipe/tasks-vision";
import { SUBJECT_LABELS, buildHeat, caption } from "./heat";
import { cropRGBA, fitWithin, makeFMap, resizeFMap, resizeRGBA, smoothstep, toGray } from "./image";
import { MODELS, fetchModel } from "./models";
import { classifyScene } from "./scene";
import { blurHotspots, scrubBackground } from "./scrub";
import { patternEnergy } from "./texture";
import type { Analysis, Backdrop, Detection, FMap, NoiseReport, RGBA, ScrubMode } from "./types";
import { findWindows } from "./windows";

// everything heavy runs in here, off the main thread. this file never calls fetch() with anything but a
// model url (see models.ts). images come in as blobs from the page and go back out as blobs. that's it.

type WorkerScope = {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  navigator: Navigator;
  ModuleFactory?: unknown;
};
// dom lib and webworker lib can't share a tsconfig, so we just describe the bits of the worker scope we use
const scope = globalThis as unknown as WorkerScope;

export type WorkerRequest =
  | { id: number; type: "init"; assetBase: string }
  | { id: number; type: "analyze"; blob: Blob; keep?: boolean }
  | { id: number; type: "scrub"; mode: ScrubMode; backdrop: Backdrop; noise: boolean }
  | { id: number; type: "noiseStatus" };

export type WorkerResponse =
  | { id: number; type: "progress"; stage: string; value: number; label: string }
  | { id: number; type: "done"; result: unknown }
  | { id: number; type: "error"; message: string };

const MAX_SIDE = 2560;
const ANALYSIS_SIDE = 512;
// the subject mask gets a bigger canvas than the rest so hair edges survive the upscale to full res
const SUBJECT_SIDE = 1024;
const HEAT_SIDE = 256;

let assetBase = "/";
let segmenter: ImageSegmenter | undefined;
let detector: ObjectDetector | undefined;
let outliner: ImageSegmenter | undefined;

// pascal voc class ids in deeplab's output
const VOC: Record<string, number> = { bird: 3, cat: 8, dog: 12, person: 15 };

type Current = { img: RGBA; subject: FMap; heat: FMap; subjectCoverage: number };
let current: Current | undefined;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

async function loadMediapipe(id: number) {
  if (segmenter && detector && outliner) return;
  const parts = { segmenter: [0, 1], detector: [0, 1], outliner: [0, 1] } as Record<string, [number, number]>;
  const report = () => {
    const vals = Object.values(parts);
    const loaded = vals.reduce((s, p) => s + p[0], 0);
    const total = vals.reduce((s, p) => s + p[1], 0);
    post({
      id,
      type: "progress",
      stage: "models",
      value: total ? loaded / total : 0,
      label: "Getting the on-device models ready",
    });
  };
  const [segBuf, detBuf, outBuf] = await Promise.all([
    fetchModel("segmenter", (l, t) => {
      parts.segmenter = [l, t];
      report();
    }),
    fetchModel("detector", (l, t) => {
      parts.detector = [l, t];
      report();
    }),
    fetchModel("outliner", (l, t) => {
      parts.outliner = [l, t];
      report();
    }),
  ]);

  // mediapipe wants to importScripts() its loader, which module workers can't do. so we import an esm
  // copy ourselves, hand it the factory, and give it an empty loader path so it skips that step
  const fileset = { wasmLoaderPath: "", wasmBinaryPath: `${assetBase}mediapipe/vision_wasm_internal.wasm` };
  const setFactory = async () => {
    const mod = await import(/* @vite-ignore */ `${assetBase}mediapipe/vision_wasm_internal.mjs`);
    scope.ModuleFactory = mod.default;
  };
  await setFactory();
  segmenter = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: segBuf, delegate: "CPU" },
    runningMode: "IMAGE",
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  await setFactory();
  outliner = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: outBuf, delegate: "CPU" },
    runningMode: "IMAGE",
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  await setFactory();
  detector = await ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: detBuf, delegate: "CPU" },
    runningMode: "IMAGE",
    scoreThreshold: 0.3,
    maxResults: 25,
  });
}

async function decode(blob: Blob, maxSide: number): Promise<RGBA> {
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const [w, h] = fitWithin(bmp.width, bmp.height, maxSide);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const d = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
}

function toImageData(img: RGBA) {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

function runDetector(part: RGBA, ox: number, oy: number, sx: number, sy: number): Detection[] {
  const res = detector!.detect(toImageData(part));
  return res.detections
    .filter((d) => d.boundingBox && d.categories[0])
    .map((d) => {
      const b = d.boundingBox!;
      return {
        label: d.categories[0].categoryName,
        score: d.categories[0].score,
        box: {
          x: ox + (b.originX / part.width) * sx,
          y: oy + (b.originY / part.height) * sy,
          w: (b.width / part.width) * sx,
          h: (b.height / part.height) * sy,
        },
      };
    });
}

// efficientdet-lite0 squashes everything to 320px, so a person across the room is a dozen pixels and
// just vanishes. one full-frame pass plus a 2x2 of overlapping tiles fixes most of that
function detectTiled(img: RGBA, small: RGBA): Detection[] {
  const all = runDetector(small, 0, 0, 1, 1);
  if (Math.max(img.width, img.height) >= 640) {
    const t = 0.58;
    for (const ty of [0, 1 - t])
      for (const tx of [0, 1 - t]) {
        const crop = cropRGBA(img, tx, ty, t, t);
        const [cw, ch] = fitWithin(crop.width, crop.height, ANALYSIS_SIDE);
        all.push(...runDetector(resizeRGBA(crop, cw, ch), tx, ty, t, t));
      }
  }
  return suppress(all);
}

// nms, but by "how much of the smaller box is inside the bigger one" so a tile's half-a-couch doesn't
// survive next to the full-frame whole couch
function suppress(dets: Detection[]): Detection[] {
  const keep: Detection[] = [];
  for (const d of [...dets].sort((a, b) => b.score - a.score)) {
    const dup = keep.some((k) => {
      if (k.label !== d.label) return false;
      const ix = Math.max(0, Math.min(k.box.x + k.box.w, d.box.x + d.box.w) - Math.max(k.box.x, d.box.x));
      const iy = Math.max(0, Math.min(k.box.y + k.box.h, d.box.y + d.box.h) - Math.max(k.box.y, d.box.y));
      const inter = ix * iy;
      const small = Math.min(k.box.w * k.box.h, d.box.w * d.box.h);
      return small > 0 && inter / small > 0.6;
    });
    if (!dup) keep.push(d);
  }
  return keep;
}

async function analyze(id: number, blob: Blob, keep: boolean): Promise<Analysis> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const step = (value: number, label: string) => {
    timings[label] = Math.round(performance.now() - t0);
    post({ id, type: "progress", stage: "analyze", value, label });
  };
  step(0.05, "Opening the photo");
  const img = await decode(blob, MAX_SIDE);
  const [aw, ah] = fitWithin(img.width, img.height, ANALYSIS_SIDE);
  const small = resizeRGBA(img, aw, ah);

  step(0.2, "Spotting furniture, fixtures, and people");
  const detections = detectTiled(img, small);

  step(0.4, "Tracing people");
  const [sw, sh] = fitWithin(img.width, img.height, SUBJECT_SIDE);
  const subject = makeFMap(sw, sh);
  // confidence for one class (or 1 - background) out of a mediapipe segmenter run
  const segment = (model: ImageSegmenter, part: RGBA, cls: number | "notbg") => {
    const seg = model.segment(toImageData(part));
    const masks = seg.confidenceMasks ?? [];
    const out = makeFMap(part.width, part.height);
    const m = masks[cls === "notbg" ? 0 : cls];
    if (m) {
      const f = m.getAsFloat32Array();
      for (let i = 0; i < out.data.length; i++) out.data[i] = cls === "notbg" ? 1 - f[i] : f[i];
    }
    seg.close();
    return out;
  };
  // crop masks get thresholded and faded out toward the crop's edges, otherwise any low-level mush in the
  // mask shows up as a sharp rectangle around the person
  const paste = (m: FMap, bx: number, by: number, bw: number, bh: number) => {
    const tw = Math.max(1, Math.round(bw * sw));
    const th = Math.max(1, Math.round(bh * sh));
    const placed = resizeFMap(m, tw, th);
    const x0 = Math.round(bx * sw);
    const y0 = Math.round(by * sh);
    const fade = Math.max(2, Math.min(tw, th) * 0.06);
    for (let y = 0; y < th && y0 + y < sh; y++)
      for (let x = 0; x < tw && x0 + x < sw; x++) {
        const i = (y0 + y) * sw + x0 + x;
        const edge = Math.min(1, Math.min(x, y, tw - 1 - x, th - 1 - y) / fade);
        const v = smoothstep(0.3, 0.7, placed.data[y * tw + x]) * edge;
        if (v > subject.data[i]) subject.data[i] = v;
      }
  };

  // whole-frame selfie pass catches close-ups. it also hallucinates people in plants and pillars, so away
  // from anything the detector called a person we only keep the parts it's really sure about
  const subjects = detections.filter((d) => SUBJECT_LABELS.has(d.label) && d.score > 0.25);
  const people = subjects.filter((d) => d.label === "person");
  const whole = resizeFMap(segment(segmenter!, small, "notbg"), sw, sh);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      let v = whole.data[i];
      if (people.length) {
        const nx = x / sw;
        const ny = y / sh;
        const near = people.some(
          (p) =>
            nx > p.box.x - 0.03 &&
            nx < p.box.x + p.box.w + 0.03 &&
            ny > p.box.y - 0.03 &&
            ny < p.box.y + p.box.h + 0.03,
        );
        if (!near && v < 0.85) v = 0;
      } else if (v < 0.6) v = 0;
      subject.data[i] = v;
    }

  // the selfie model is hopeless at a whole person across the room, and knows nothing about pets. so each
  // detected person/pet gets a cropped deeplab pass of its own, pasted back in
  for (const d of subjects) {
    const padX = d.box.w * 0.15;
    const padY = d.box.h * 0.08;
    const bx = Math.max(0, d.box.x - padX);
    const by = Math.max(0, d.box.y - padY);
    const bw = Math.min(1 - bx, d.box.w + padX * 2);
    const bh = Math.min(1 - by, d.box.h + padY * 2);
    const crop = cropRGBA(img, bx, by, bw, bh);
    const [cw, ch] = fitWithin(crop.width, crop.height, 384);
    const part = resizeRGBA(crop, cw, ch);
    paste(segment(outliner!, part, VOC[d.label] ?? VOC.person), bx, by, bw, bh);
  }
  step(0.65, "Checking windows and patterns");
  const [hw, hh] = fitWithin(aw, ah, HEAT_SIDE);
  const gray = toGray(resizeRGBA(small, hw, hh));
  const windows = findWindows(gray);
  const pattern = patternEnergy(gray);
  const subjectSmall = resizeFMap(subject, hw, hh);
  let coverage = 0;
  for (let i = 0; i < subjectSmall.data.length; i++) if (subjectSmall.data[i] > 0.5) coverage++;
  coverage /= subjectSmall.data.length;

  step(0.9, "Adding it up");
  const built = buildHeat({ width: hw, height: hh, detections, windows, pattern, subject: subjectSmall });
  const scene = classifyScene(small);
  if (keep) current = { img, subject, heat: built.heat, subjectCoverage: coverage };
  step(1, "Done");
  return {
    width: img.width,
    height: img.height,
    // copy, because this one gets transferred and the worker still needs its own for hotspot blur
    heat: { ...built.heat, data: built.heat.data.slice() },
    score: built.score,
    room: built.room,
    exterior: scene.exterior,
    caption: caption(built.room, built.sources, built.score, scene.exterior),
    elements: built.sources,
    hasPerson: coverage > 0.01,
    subjectCoverage: coverage,
    detections,
    timings,
  };
}

// dinov2 + tfjs are big, so they only get pulled in the first time someone flips the noise toggle
let dinoMod: typeof import("./dino") | undefined;
let dino: import("./dino").Dino | undefined;
let backend = "";

async function ensureDino(id: number) {
  if (dino) return;
  dinoMod = await import("./dino");
  backend = await dinoMod.pickBackend(`${assetBase}tfjs/`);
  const buf = await fetchModel("dino", (l, t) =>
    post({
      id,
      type: "progress",
      stage: "noise",
      value: (l / t) * 0.3,
      label: `Downloading the ${MODELS.dino.label} (once)`,
    }),
  );
  dino = new dinoMod.Dino(dinoMod.parseSafetensors(buf));
}

function to224(img: RGBA): Float32Array {
  const s = resizeRGBA(img, 224, 224);
  const out = new Float32Array(224 * 224 * 3);
  for (let i = 0, j = 0; i < s.data.length; i += 4, j += 3) {
    out[j] = s.data[i] / 255;
    out[j + 1] = s.data[i + 1] / 255;
    out[j + 2] = s.data[i + 2] / 255;
  }
  return out;
}

async function addNoise(id: number, img: RGBA): Promise<{ img: RGBA; report: NoiseReport }> {
  const t0 = performance.now();
  try {
    await ensureDino(id);
  } catch (e) {
    return {
      img,
      report: { applied: false, reason: `Couldn't load the matching model here (${(e as Error).message}).` },
    };
  }
  const mod = dinoMod!;
  const x = to224(img);
  const { delta } = await mod.matchingNoise(dino!, x, {
    onStep: (s, n) =>
      post({
        id,
        type: "progress",
        stage: "noise",
        value: 0.3 + (s / n) * 0.65,
        label: `Adding matching noise (${s}/${n})`,
      }),
  });
  // delta is 224x224x3 over the whole frame. stretch it back over the full-size photo
  const dmap = { width: 224, height: 224 };
  const out: RGBA = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(224 * 224);
    for (let i = 0; i < ch.length; i++) ch[i] = delta[i * 3 + c];
    const up = resizeFMap({ ...dmap, data: ch }, img.width, img.height).data;
    for (let p = 0, i = c; p < up.length; p++, i += 4) out.data[i] = img.data[i] + up[p] * 255;
  }
  // measure on the actual 8-bit result, not the float version, so the number we show is honest
  const simAfter = await mod.similarity(dino!, x, to224(out));
  return {
    img: out,
    report: {
      applied: true,
      backend,
      similarityBefore: 1,
      similarityAfter: simAfter,
      ms: Math.round(performance.now() - t0),
    },
  };
}

async function encode(img: RGBA): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext("2d")!.putImageData(toImageData(img), 0, 0);
  // re-encoding through canvas is what actually drops exif/xmp/gps. there's a test that checks
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

async function scrub(id: number, mode: ScrubMode, backdrop: Backdrop, noise: boolean) {
  if (!current) throw new Error("no photo loaded");
  const step = (value: number, label: string) => post({ id, type: "progress", stage: "scrub", value, label });
  step(0.1, mode === "metadata" ? "Stripping metadata" : "Scrubbing");
  let out = current.img;
  if (mode === "background") out = scrubBackground(current.img, current.subject, backdrop);
  else if (mode === "hotspots") out = blurHotspots(current.img, current.heat);
  step(0.9, "Almost there");

  let report: NoiseReport | undefined;
  if (noise) {
    const r = await addNoise(id, out);
    out = r.img;
    report = r.report;
  }
  post({ id, type: "progress", stage: "encode", value: 0.98, label: "Saving" });
  const blob = await encode(out);
  return { blob, width: out.width, height: out.height, mode, noise: report };
}

scope.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    let result: unknown;
    if (msg.type === "init") {
      assetBase = msg.assetBase;
      await loadMediapipe(msg.id);
      result = true;
    } else if (msg.type === "analyze") {
      await loadMediapipe(msg.id);
      result = await analyze(msg.id, msg.blob, msg.keep ?? true);
    } else if (msg.type === "scrub") {
      result = await scrub(msg.id, msg.mode, msg.backdrop, msg.noise);
    } else if (msg.type === "noiseStatus") {
      const nav = scope.navigator as Navigator & { gpu?: unknown };
      result = { webgpu: !!nav.gpu, loaded: !!dino, backend };
    }
    const transfer: Transferable[] = [];
    const heat = (result as Analysis | undefined)?.heat;
    if (heat?.data) transfer.push(heat.data.buffer);
    post({ id: msg.id, type: "done", result }, transfer);
  } catch (e) {
    post({ id: msg.id, type: "error", message: (e as Error).message ?? String(e) });
  }
};
