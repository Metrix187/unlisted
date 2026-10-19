// plain rgba buffer. same shape as ImageData so we can pass either around without caring
export type RGBA = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

// single-channel float map, row major, values usually 0..1
export type FMap = {
  width: number;
  height: number;
  data: Float32Array;
};

// normalized 0..1 coords so boxes survive resizes
export type Box = { x: number; y: number; w: number; h: number };

export type ElementKind = "window" | "art" | "pattern" | "furniture" | "fixture" | "plant" | "decor";

export type Detection = {
  label: string;
  score: number;
  box: Box;
};

export type HeatSource = {
  kind: ElementKind;
  // the word we show people. "the couch", "that window"
  phrase: string;
  weight: number;
  box?: Box;
};

export type RoomKind = "bathroom" | "kitchen" | "bedroom" | "living room" | "dining room" | "office" | "room";

export type Analysis = {
  width: number;
  height: number;
  heat: FMap;
  score: number;
  room: RoomKind;
  exterior: boolean;
  caption: string;
  elements: HeatSource[];
  hasPerson: boolean;
  subjectCoverage: number;
  detections: Detection[];
  // ms since start, per stage. for the ?debug crowd
  timings?: Record<string, number>;
};

export type ScrubMode = "background" | "hotspots" | "metadata";
export type Backdrop = "blur" | "plain";

export type NoiseReport =
  | { applied: true; backend: string; similarityBefore: number; similarityAfter: number; ms: number }
  | { applied: false; reason: string };

export type ScrubResult = {
  blob: Blob;
  width: number;
  height: number;
  mode: ScrubMode;
  noise?: NoiseReport;
};

export type ProgressEvent = {
  stage: "models" | "analyze" | "scrub" | "noise" | "encode";
  value: number;
  label: string;
};
