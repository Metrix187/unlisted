import { readFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
import type { RGBA } from "../src/types";

export const FIXTURES = join(__dirname, "..", "fixtures");

export function loadFixture(name: string): RGBA {
  const raw = jpeg.decode(readFileSync(join(FIXTURES, name)), { useTArray: true, formatAsRGBA: true });
  return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data.buffer) };
}

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}
