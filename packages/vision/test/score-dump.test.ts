import { readdirSync } from "node:fs";
import { test } from "vitest";
import { blurRGBA, buildHeat, findWindows, fitWithin, patternEnergy, resizeRGBA, toGray } from "../src";
import { FIXTURES, loadFixture } from "./helpers";

test.skipIf(!process.env.CALIBRATE)("score dump", { timeout: 120_000 }, () => {
  for (const f of readdirSync(FIXTURES).filter((f) => f.endsWith(".jpg"))) {
    const row: string[] = [];
    for (const b of [0, 30]) {
      let img = loadFixture(f);
      if (b) img = blurRGBA(img, b);
      const [w, h] = fitWithin(img.width, img.height, 256);
      const g = toGray(resizeRGBA(img, w, h));
      const out = buildHeat({
        width: w,
        height: h,
        detections: [],
        windows: findWindows(g),
        pattern: patternEnergy(g),
      });
      row.push(`${out.score} (pat ${out.patternCoverage.toFixed(2)})`);
    }
    console.log(f.padEnd(22), row.join("  ->  "));
  }
});
