import { readdirSync } from "node:fs";
import { test } from "vitest";
import {
  blurRGBA,
  classifyScene,
  findWindows,
  fitWithin,
  patternEnergy,
  percentile,
  resizeRGBA,
  toGray,
} from "../src";
import { FIXTURES, loadFixture } from "./helpers";

// not a real test. run with CALIBRATE=1 to print the raw numbers the thresholds were tuned against
test.skipIf(!process.env.CALIBRATE)("calibration dump", { timeout: 120_000 }, () => {
  for (const f of readdirSync(FIXTURES).filter((f) => f.endsWith(".jpg"))) {
    for (const blurred of [false, true]) {
      let img = loadFixture(f);
      if (blurred) img = blurRGBA(img, 30);
      const [w, h] = fitWithin(img.width, img.height, 256);
      const gray = toGray(resizeRGBA(img, w, h));
      const pat = patternEnergy(gray);
      const win = findWindows(gray);
      const sc = classifyScene(img);
      console.log(
        f.padEnd(22),
        blurred ? "blur" : "    ",
        `pat p50=${percentile(pat.data, 0.5).toFixed(4)} p90=${percentile(pat.data, 0.9).toFixed(4)} p99=${percentile(pat.data, 0.99).toFixed(4)}`,
        `win=${win.length} ${win.map((x) => x.strength.toFixed(2)).join(",")}`,
        `sky=${sc.sky.toFixed(3)} green=${sc.green.toFixed(3)} ext=${sc.exterior}`,
      );
    }
  }
});
