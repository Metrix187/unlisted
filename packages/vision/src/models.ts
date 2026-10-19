// every byte we pull over the network lives here. models only, never anything of the user's.
// keep this list and the CSP connect-src in lockstep (see apps/scrub/vite.config.ts)

export const MODEL_HOSTS = [
  "https://storage.googleapis.com",
  "https://huggingface.co",
  // hf redirects weight downloads to whichever regional cdn is closest, all under hf.co
  "https://*.hf.co",
];

export const MODELS = {
  segmenter: {
    url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
    label: "person finder",
  },
  outliner: {
    url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/latest/deeplab_v3.tflite",
    label: "outline finder",
  },
  detector: {
    url: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite",
    label: "room-stuff finder",
  },
  dino: {
    url: "https://huggingface.co/facebook/dinov2-small/resolve/ed25f3a31f01632728cabb09d1542f84ab7b0056/model.safetensors",
    label: "matching model",
  },
} as const;

export type ModelKey = keyof typeof MODELS;

const CACHE = "unlisted-models-v1";

// cache-first fetch with byte-level progress. the Cache API works inside workers, so the models survive
// offline without the service worker having to know about them
export async function fetchModel(
  key: ModelKey,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const { url } = MODELS[key];
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      onProgress?.(buf.length, buf.length);
      return buf;
    }
  } catch {
    // private mode / no cache api. we'll just download every time, sad but fine
  }

  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok || !res.body) throw new Error(`couldn't download the ${MODELS[key].label} (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total || loaded);
  }
  const buf = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  try {
    await cache?.put(url, new Response(buf, { headers: { "content-type": "application/octet-stream" } }));
  } catch {
    // quota, probably. next load just downloads again
  }
  return buf;
}

export async function isCached(key: ModelKey): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE);
    return !!(await cache.match(MODELS[key].url));
  } catch {
    return false;
  }
}
