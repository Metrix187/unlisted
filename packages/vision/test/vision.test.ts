import { describe, expect, test } from "vitest";
import {
  blurRGBA,
  boxesForGauss,
  buildHeat,
  caption,
  classifyScene,
  exposureScore,
  findWindows,
  fitWithin,
  inspectMetadata,
  makeFMap,
  makeRGBA,
  patternEnergy,
  resizeRGBA,
  scrubBackground,
  toGray,
} from "../src";
import { fixtureBytes, loadFixture } from "./helpers";

function gray256(name: string, blur = 0) {
  let img = loadFixture(name);
  if (blur) img = blurRGBA(img, blur);
  const [w, h] = fitWithin(img.width, img.height, 256);
  return toGray(resizeRGBA(img, w, h));
}

describe("pixel ops", () => {
  test("box sizes approximate the requested gaussian", () => {
    const sizes = boxesForGauss(10);
    const variance = sizes.reduce((s, w) => s + (w * w - 1) / 12, 0);
    expect(Math.sqrt(variance)).toBeCloseTo(10, 0);
  });

  test("blur keeps a flat image flat and kills a checkerboard", () => {
    const img = makeRGBA(64, 64);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const v = (x + y) % 2 ? 255 : 0;
        const i = (y * 64 + x) * 4;
        img.data.set([v, v, v, 255], i);
      }
    const out = blurRGBA(img, 6);
    for (let i = 0; i < out.data.length; i += 4) expect(Math.abs(out.data[i] - 127.5)).toBeLessThan(12);
  });

  test("area resize preserves mean brightness", () => {
    const img = loadFixture("kitchen.jpg");
    const small = resizeRGBA(img, 100, 75);
    const m = (d: Uint8ClampedArray) => {
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i];
      return s / (d.length / 4);
    };
    expect(Math.abs(m(small.data) - m(img.data))).toBeLessThan(1.5);
  });
});

describe("windows + patterns", () => {
  test("finds the windows in the living room", () => {
    expect(findWindows(gray256("living.jpg")).length).toBeGreaterThan(0);
  });

  test("a blurred window isn't a window anymore", () => {
    expect(findWindows(gray256("living.jpg", 30))).toHaveLength(0);
  });

  test("blur flattens pattern energy", () => {
    const sharp = patternEnergy(gray256("kitchen.jpg"));
    const soft = patternEnergy(gray256("kitchen.jpg", 30));
    const max = (a: Float32Array) => a.reduce((m, v) => (v > m ? v : m), 0);
    expect(max(soft.data)).toBeLessThan(max(sharp.data) * 0.2);
  });
});

describe("heat + score", () => {
  test("room photo scores higher than its scrubbed self", () => {
    const g = gray256("living.jpg");
    const before = buildHeat({
      width: g.width,
      height: g.height,
      detections: [{ label: "couch", score: 0.8, box: { x: 0.3, y: 0.5, w: 0.4, h: 0.3 } }],
      windows: findWindows(g),
      pattern: patternEnergy(g),
    });
    const gb = gray256("living.jpg", 30);
    const after = buildHeat({
      width: gb.width,
      height: gb.height,
      detections: [],
      windows: findWindows(gb),
      pattern: patternEnergy(gb),
    });
    expect(before.score).toBeGreaterThan(after.score + 20);
    expect(after.score).toBeLessThan(15);
    expect(before.room).toBe("living room");
  });

  test("subject pixels carry no heat", () => {
    const g = gray256("bathroom.jpg");
    const subject = makeFMap(g.width, g.height, 1);
    const out = buildHeat({
      width: g.width,
      height: g.height,
      detections: [],
      windows: [],
      pattern: patternEnergy(g),
      subject,
    });
    expect(exposureScore(out.heat)).toBe(0);
  });

  test("captions read like a person wrote them", () => {
    const c = caption(
      "bathroom",
      [
        { kind: "pattern", phrase: "the tile", weight: 0.8 },
        { kind: "fixture", phrase: "the sink", weight: 0.6 },
        { kind: "window", phrase: "that window", weight: 1 },
      ],
      70,
      false,
    );
    expect(c).toBe(
      "Looks like a bathroom. The tile, the sink, and that window are what a matching tool would lock onto.",
    );
    expect(caption("room", [], 5, false)).toContain("Not much left");
    expect(c).not.toMatch(/embedding/i);
  });
});

describe("scene", () => {
  test.each(["exterior-brick.jpg", "exterior-snow.jpg"])("%s is an exterior", (f) => {
    expect(classifyScene(loadFixture(f)).exterior).toBe(true);
  });
  test.each([
    "bathroom.jpg",
    "bedroom.jpg",
    "kitchen.jpg",
    "living.jpg",
    "living-rug.jpg",
    "person-living.jpg",
  ])("%s is an interior", (f) => {
    expect(classifyScene(loadFixture(f)).exterior).toBe(false);
  });
});

describe("scrub", () => {
  test("background scrub keeps the subject pixels and changes the rest", () => {
    const img = loadFixture("bedroom.jpg");
    const mask = makeFMap(img.width, img.height);
    // pretend the middle third is a person
    for (let y = 0; y < img.height; y++)
      for (let x = Math.floor(img.width / 3); x < Math.floor((2 * img.width) / 3); x++)
        mask.data[y * img.width + x] = 1;
    const out = scrubBackground(img, mask, "blur");
    const at = (im: { data: Uint8ClampedArray; width: number }, x: number, y: number) =>
      im.data[(y * im.width + x) * 4];
    const cx = Math.floor(img.width / 2);
    expect(at(out, cx, 100)).toBe(at(img, cx, 100));
    let diff = 0;
    for (let y = 0; y < img.height; y += 7) diff += Math.abs(at(out, 5, y) - at(img, 5, y));
    expect(diff).toBeGreaterThan(0);
  });

  test("plain backdrop is a smooth gradient", () => {
    const img = loadFixture("kitchen.jpg");
    const out = scrubBackground(img, makeFMap(img.width, img.height), "plain");
    const row = (y: number) => out.data.slice(y * img.width * 4, (y + 1) * img.width * 4);
    const r = row(10);
    for (let i = 4; i < r.length; i += 4) expect(r[i]).toBe(r[0]);
  });
});

describe("metadata sniffer", () => {
  test("sees the exif + gps in the fixture", () => {
    const m = inspectMetadata(fixtureBytes("bathroom-exif.jpg"));
    expect(m).toMatchObject({ format: "jpeg", exif: true, gps: true });
  });
  test("plain fixture has none", () => {
    expect(inspectMetadata(fixtureBytes("bathroom.jpg"))).toMatchObject({
      exif: false,
      gps: false,
      xmp: false,
    });
  });
});
