import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "@tensorflow/tfjs-backend-cpu";
import * as tf from "@tensorflow/tfjs-core";
import { expect, test } from "vitest";
import { Dino, matchingNoise, parseSafetensors } from "../src/dino";
import { FIXTURES } from "./helpers";

// parity check against pytorch. needs the 88mb checkpoint locally, so it's opt-in:
//   DINO_WEIGHTS=/path/to/model.safetensors pnpm --filter @unlisted/vision test
const weights = process.env.DINO_WEIGHTS;

test.skipIf(!weights || !existsSync(weights))(
  "tfjs dinov2 matches pytorch",
  { timeout: 900_000 },
  async () => {
    // let vitest's "test started" rpc land before the cpu backend hogs the thread for minutes. without this
    // the reply sits behind the blocked event loop, times out, and vitest exits 1 on a test that passed
    await new Promise((r) => setTimeout(r, 1000));
    await tf.setBackend("cpu");
    const dino = new Dino(parseSafetensors(new Uint8Array(readFileSync(weights!))));
    const rgb = readFileSync(join(FIXTURES, "dino-ref", "kitchen-224.rgb"));
    const ref = JSON.parse(readFileSync(join(FIXTURES, "dino-ref", "kitchen-cls.json"), "utf8")) as number[];
    const x = Float32Array.from(rgb, (v) => v / 255);
    const e = (await dino.embed(tf.tensor4d(x, [1, 224, 224, 3])).data()) as Float32Array;
    const cos = ref.reduce((s, v, i) => s + v * e[i], 0);
    console.log("cosine vs pytorch:", cos);
    expect(cos).toBeGreaterThan(0.999);

    const { delta, sim } = await matchingNoise(dino, { data: x, width: 224, height: 224 }, { steps: 1 });
    console.log("sim after 1 step:", sim);
    expect(sim).toBeLessThan(0.995);
    const maxAbs = delta.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(maxAbs).toBeLessThanOrEqual(4 / 255 + 1e-6);
  },
);
