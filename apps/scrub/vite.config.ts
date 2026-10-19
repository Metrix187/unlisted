import preact from "@preact/preset-vite";
import { visionAssets } from "@unlisted/vision/vite";
import { type Plugin, defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { HEADER_ONLY, cspString } from "./csp";

const headers = {
  "Content-Security-Policy": cspString(HEADER_ONLY),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// csp goes in three places: a meta tag (belt), the cloudflare pages _headers file (braces), and the
// preview server so the e2e tests run against the real thing. dev skips it because vite's hmr needs
// inline scripts and websockets
function csp(): Plugin {
  return {
    name: "unlisted-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${cspString()}" />`,
      );
    },
    generateBundle() {
      const body = Object.entries(headers)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      this.emitFile({ type: "asset", fileName: "_headers", source: `/*\n${body}\n` });
    },
  };
}

// HARNESS=1 adds a second, unlinked page that eval/ drives headlessly. never part of a normal build
const harness = process.env.HARNESS === "1";

export default defineConfig({
  plugins: [
    preact(),
    visionAssets(),
    csp(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      manifest: {
        name: "Scrub",
        short_name: "Scrub",
        description: "Blur the room out of your photos before you share them. Runs entirely on your device.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#111113",
        theme_color: "#111113",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // shows scrub in the os share sheet. the post never leaves the phone: the service worker eats it
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: { files: [{ name: "photo", accept: ["image/*"] }] },
        },
      },
      injectManifest: {
        globPatterns: ["**/*.{js,mjs,css,html,png,svg,wasm,webmanifest}"],
        // mediapipe's wasm is ~9mb. it has to be precached or offline doesn't work
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: true,
    outDir: harness ? "dist-harness" : "dist",
    rollupOptions: harness ? { input: { main: "index.html", harness: "harness.html" } } : undefined,
  },
  preview: { headers },
});
