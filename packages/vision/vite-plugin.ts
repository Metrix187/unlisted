import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// serves/emits the wasm bits mediapipe and tfjs need, from our own origin. that way the only thing on a
// cdn is model weights, and the CSP can stay tight

const here = dirname(fileURLToPath(import.meta.url));
const mp = join(here, "node_modules/@mediapipe/tasks-vision/wasm");
const tfw = join(here, "node_modules/@tensorflow/tfjs-backend-wasm/dist");

function files(): Record<string, () => Buffer | string> {
  return {
    "mediapipe/vision_wasm_internal.wasm": () => readFileSync(join(mp, "vision_wasm_internal.wasm")),
    // the loader is a plain script that sets a global. tack an export on the end so a module worker can
    // import() it instead of importScripts()
    "mediapipe/vision_wasm_internal.mjs": () =>
      `${readFileSync(join(mp, "vision_wasm_internal.js"), "utf8")}\nexport default ModuleFactory;\n`,
    "tfjs/tfjs-backend-wasm.wasm": () => readFileSync(join(tfw, "tfjs-backend-wasm.wasm")),
    "tfjs/tfjs-backend-wasm-simd.wasm": () => readFileSync(join(tfw, "tfjs-backend-wasm-simd.wasm")),
    "tfjs/tfjs-backend-wasm-threaded-simd.wasm": () =>
      readFileSync(join(tfw, "tfjs-backend-wasm-threaded-simd.wasm")),
  };
}

export function visionAssets(): Plugin {
  const table = files();
  return {
    name: "unlisted-vision-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0].replace(/^\//, "");
        const f = table[path];
        if (!f) return next();
        res.setHeader("content-type", path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.end(f());
      });
    },
    generateBundle() {
      for (const [fileName, f] of Object.entries(table)) {
        this.emitFile({ type: "asset", fileName, source: f() });
      }
    },
  };
}
