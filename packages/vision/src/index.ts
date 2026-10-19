// pure, dom-free bits. the worker and the client live behind "./worker" and "./client"
export * from "./types";
export * from "./image";
export { patternEnergy } from "./texture";
export { findWindows, type WindowHit } from "./windows";
export { classifyScene, type SceneGuess } from "./scene";
export { buildHeat, caption, exposureScore, guessRoom, WEIGHTS, SUBJECT_LABELS } from "./heat";
export { scrubBackground, blurHotspots, prepareMask, backgroundSigma } from "./scrub";
export { inspectMetadata, type MetaReport } from "./exif";
