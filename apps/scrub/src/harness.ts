import type { Backdrop, ScrubMode } from "@unlisted/vision";
import { VisionClient } from "@unlisted/vision/client";

// eval/defend.mjs opens this page headlessly and calls window.harness.run() once per image. same worker,
// same models, same code path as the real button, just without the ui in the way

type Opts = { mode: ScrubMode; backdrop?: Backdrop; noise?: boolean; slow?: boolean };

const client = new VisionClient(new URL("/", location.href).href);

function b64ToBlob(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

async function blobToB64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const harness = {
  ready: () => client.init(),
  async run(b64: string, opts: Opts) {
    const t0 = performance.now();
    const analysis = await client.analyze(b64ToBlob(b64));
    const result = await client.scrub({
      mode: opts.mode,
      backdrop: opts.backdrop ?? "blur",
      noise: !!opts.noise,
      slow: opts.slow,
    });
    return {
      image: await blobToB64(result.blob),
      score: analysis.score,
      hasPerson: analysis.hasPerson,
      noise: result.noise ?? null,
      ms: Math.round(performance.now() - t0),
    };
  },
};

(window as unknown as { harness: typeof harness }).harness = harness;
document.body.dataset.ready = "1";
