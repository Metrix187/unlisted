import { makeFMap, mean, smoothstep } from "./image";
import type { Box, Detection, ElementKind, FMap, HeatSource, RoomKind } from "./types";
import type { WindowHit } from "./windows";

// how much each kind of thing gives a room away. windows win because the view is unique to the address.
// walls are the floor, not zero: even a blank wall has paint color and light falloff
export const WEIGHTS: Record<ElementKind | "wall", number> = {
  window: 1.0,
  art: 0.9,
  pattern: 0.8,
  decor: 0.7,
  fixture: 0.6,
  furniture: 0.5,
  plant: 0.5,
  wall: 0.1,
};

type LabelInfo = { kind: ElementKind; phrase: string };

const LABELS: Record<string, LabelInfo> = {
  couch: { kind: "furniture", phrase: "the couch" },
  chair: { kind: "furniture", phrase: "the chairs" },
  bed: { kind: "furniture", phrase: "the bed" },
  "dining table": { kind: "furniture", phrase: "the table" },
  bench: { kind: "furniture", phrase: "the bench" },
  toilet: { kind: "fixture", phrase: "the toilet" },
  sink: { kind: "fixture", phrase: "the sink" },
  oven: { kind: "fixture", phrase: "the oven" },
  microwave: { kind: "fixture", phrase: "the microwave" },
  refrigerator: { kind: "fixture", phrase: "the fridge" },
  toaster: { kind: "fixture", phrase: "the toaster" },
  tv: { kind: "fixture", phrase: "the TV" },
  "potted plant": { kind: "plant", phrase: "the plants" },
  clock: { kind: "decor", phrase: "the clock" },
  vase: { kind: "decor", phrase: "the vase" },
  "teddy bear": { kind: "decor", phrase: "the stuffed animal" },
  book: { kind: "decor", phrase: "the books" },
};

// people and pets are the subject, not the room
export const SUBJECT_LABELS = new Set(["person", "cat", "dog", "bird"]);

export function guessRoom(dets: Detection[]): RoomKind {
  const has = (l: string) => dets.some((d) => d.label === l);
  if (has("toilet")) return "bathroom";
  if (has("oven") || has("microwave") || has("refrigerator") || has("toaster")) return "kitchen";
  // a sink with no stove or fridge in sight is way more often a bathroom
  if (has("sink")) return "bathroom";
  if (has("bed")) return "bedroom";
  if (has("couch") || has("tv")) return "living room";
  if (has("dining table")) return "dining room";
  if (has("laptop") || has("keyboard") || has("mouse")) return "office";
  return "room";
}

// soft-edged box. feather in normalized units of the box's short side
function stampBox(map: FMap, box: Box, weight: number, feather = 0.18) {
  const { width: w, height: h, data } = map;
  const fx = Math.max(1, box.w * w * feather);
  const fy = Math.max(1, box.h * h * feather);
  const f = Math.min(fx, fy);
  const x0 = box.x * w;
  const y0 = box.y * h;
  const x1 = (box.x + box.w) * w;
  const y1 = (box.y + box.h) * h;
  const ys = Math.max(0, Math.floor(y0 - f));
  const ye = Math.min(h - 1, Math.ceil(y1 + f));
  const xs = Math.max(0, Math.floor(x0 - f));
  const xe = Math.min(w - 1, Math.ceil(x1 + f));
  for (let y = ys; y <= ye; y++) {
    const dy = y + 0.5 < y0 ? y0 - (y + 0.5) : y + 0.5 > y1 ? y + 0.5 - y1 : 0;
    for (let x = xs; x <= xe; x++) {
      const dx = x + 0.5 < x0 ? x0 - (x + 0.5) : x + 0.5 > x1 ? x + 0.5 - x1 : 0;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const v = weight * (1 - smoothstep(0, f, dist));
      const i = y * w + x;
      if (v > data[i]) data[i] = v;
    }
  }
}

export type HeatInputs = {
  width: number;
  height: number;
  detections: Detection[];
  windows: WindowHit[];
  pattern: FMap; // raw pattern energy, same size as the heat map
  subject?: FMap; // 0..1 how much each pixel is the person/pet, same size
};

export type HeatOutput = {
  heat: FMap;
  sources: HeatSource[];
  score: number;
  room: RoomKind;
  patternCoverage: number;
};

// pattern energy thresholds, picked by staring at the fixtures. tile grout lands ~0.05+, plain walls < 0.02, blurred anything < 0.003
const PATTERN_LO = 0.024;
const PATTERN_HI = 0.062;

export function buildHeat(inp: HeatInputs): HeatOutput {
  const { width: w, height: h } = inp;
  const heat = makeFMap(w, h, WEIGHTS.wall);
  const contrib = new Map<string, { source: HeatSource; mass: number }>();
  const bump = (source: HeatSource, mass: number) => {
    const prev = contrib.get(source.phrase);
    if (prev) prev.mass += mass;
    else contrib.set(source.phrase, { source, mass });
  };

  let patternPix = 0;
  for (let i = 0; i < heat.data.length; i++) {
    const p = smoothstep(PATTERN_LO, PATTERN_HI, inp.pattern.data[i]) * WEIGHTS.pattern;
    if (p > heat.data[i]) heat.data[i] = p;
    if (p > 0.4) patternPix++;
  }
  const patternCoverage = patternPix / heat.data.length;

  for (const d of inp.detections) {
    const info = LABELS[d.label];
    if (!info) continue;
    const wgt = WEIGHTS[info.kind] * Math.min(1, 0.4 + d.score);
    stampBox(heat, d.box, wgt);
    bump(
      { kind: info.kind, phrase: info.phrase, weight: WEIGHTS[info.kind], box: d.box },
      d.box.w * d.box.h * wgt,
    );
  }

  inp.windows.forEach((win) => {
    const wgt = WEIGHTS.window * win.strength;
    stampBox(heat, win.box, wgt, 0.12);
    bump(
      {
        kind: "window",
        phrase: inp.windows.length > 1 ? "the windows" : "that window",
        weight: WEIGHTS.window,
        box: win.box,
      },
      // windows punch above their pixel count
      win.box.w * win.box.h * wgt * 2.5,
    );
  });

  if (inp.subject) {
    const s = inp.subject.data;
    for (let i = 0; i < heat.data.length; i++) heat.data[i] *= 1 - Math.min(1, s[i]);
  }

  const room = guessRoom(inp.detections);
  if (patternCoverage > 0.02) {
    const tiley = room === "bathroom" || room === "kitchen";
    bump(
      { kind: "pattern", phrase: tiley ? "the tile" : "the patterns", weight: WEIGHTS.pattern },
      patternCoverage * WEIGHTS.pattern,
    );
  }

  const sources = [...contrib.values()].sort((a, b) => b.mass - a.mass).map((c) => c.source);
  return { heat, sources, score: exposureScore(heat), room, patternCoverage };
}

// 0-100, rough. mean heat above the wall floor, stretched so a busy room sits in the 60-90 range and a
// scrubbed one lands near the bottom. it's a vibe meter with math behind it, and the ui says "rough"
export function exposureScore(heat: FMap): number {
  const m = mean(heat.data);
  const t = Math.max(0, Math.min(1, (m - WEIGHTS.wall) / 0.42));
  return Math.round(100 * t ** 0.85);
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function list(items: string[]) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function caption(room: RoomKind, sources: HeatSource[], score: number, exterior: boolean): string {
  const where = exterior
    ? "Looks like the outside of a home."
    : room === "room"
      ? "Looks like the inside of a home."
      : `Looks like a ${room}.`;
  if (score < 15) return `${where} Not much left here that a matching tool could lock onto.`;
  const top = sources.slice(0, 3).map((s) => s.phrase);
  if (!top.length) {
    return `${where} The walls, light, and layout are what a matching tool would lock onto.`;
  }
  const verb = top.length === 1 && !top[0].endsWith("s") ? "is" : "are";
  return `${where} ${cap(list(top))} ${verb} what a matching tool would lock onto.`;
}
