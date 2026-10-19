import { ImageSegmenter, ObjectDetector } from "@mediapipe/tasks-vision";
import { SUBJECT_LABELS, buildHeat, caption } from "./heat";
import { fitWithin, makeFMap, resizeFMap, resizeRGBA, toGray } from "./image";
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
const HEAT_SIDE = 256;

let assetBase = "/";
let segmenter: ImageSegmenter | undefined;
let detector: ObjectDetector | undefined;

type Current = { img: RGBA; subject: FMap; heat: FMap; subjectCoverage: number };
let current: Current | undefined;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

async function loadMediapipe(id: number) {
  if (segmenter && detector) return;
  const parts = { segmenter: [0, 1], detector: [0, 1] } as Record<string, [number, number]>;
  const report = () => {
    const loaded = parts.segmenter[0] + parts.detector[0];
    const total = parts.segmenter[1] + parts.detector[1];
    post({
      id,
      type: "progress",
      stage: "models",
      value: total ? loaded / total : 0,
      label: "Getting the on-device models ready",
    });
  };
  const [segBuf, detBuf] = await Promise.all([
    fetchModel("segmenter", (l, t) => {
      parts.segmenter = [l, t];
      report();
    }),
    fetchModel("detector", (l, t) => {
      parts.detector = [l, t];
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

async function analyze(id: number, blob: Blob, keep: boolean): Promise<Analysis> {
  const step = (value: number, label: string) =>
    post({ id, type: "progress", stage: "analyze", value, label });
  step(0.05, "Opening the photo");
  const img = await decode(blob, MAX_SIDE);
  const [aw, ah] = fitWithin(img.width, img.height, ANALYSIS_SIDE);
  const small = resizeRGBA(img, aw, ah);

  step(0.2, "Looking for people");
  const seg = segmenter!.segment(toImageData(small));
  const masks = seg.confidenceMasks ?? [];
  const subject = makeFMap(aw, ah);
  if (masks[0]) {
    const bg = masks[0].getAsFloat32Array();
    for (let i = 0; i < subject.data.length; i++) subject.data[i] = 1 - bg[i];
  }
  seg.close();

  step(0.45, "Spotting furniture and fixtures");
  const det = detector!.detect(toImageData(small));
  const detections: Detection[] = det.detections
    .filter((d) => d.boundingBox && d.categories[0])
    .map((d) => {
      const b = d.boundingBox!;
      return {
        label: d.categories[0].categoryName,
        score: d.categories[0].score,
        box: { x: b.originX / aw, y: b.originY / ah, w: b.width / aw, h: b.height / ah },
      };
    });

  // pets count as subject too. the segmenter only knows humans, so they get a soft ellipse from the box
  for (const d of detections) {
    if (!SUBJECT_LABELS.has(d.label) || d.label === "person") continue;
    const cx = (d.box.x + d.box.w / 2) * aw;
    const cy = (d.box.y + d.box.h / 2) * ah;
    const rx = (d.box.w * aw) / 2;
    const ry = (d.box.h * ah) / 2;
    for (let y = 0; y < ah; y++)
      for (let x = 0; x < aw; x++) {
        const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (e < 1.1)
          subject.data[y * aw + x] = Math.max(subject.data[y * aw + x], Math.min(1, (1.1 - e) * 4));
      }
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
