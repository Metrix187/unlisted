import preact from "@preact/preset-vite";
import { type Plugin, defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const api = env.VITE_API_URL || "http://localhost:8787";
  const apiOrigin = new URL(api).origin;

  // the page talks to our worker and nothing else. listing photos load as plain <img>s (no cookies, no
  // referrer), which is why img-src is wider than connect-src
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    `connect-src 'self' ${apiOrigin}`,
    `img-src 'self' data: blob: ${apiOrigin} https:`,
    "style-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
  const headers = {
    "Content-Security-Policy": `${csp}; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };

  const cspPlugin: Plugin = {
    name: "footprint-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
    generateBundle() {
      const body = Object.entries(headers)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      this.emitFile({ type: "asset", fileName: "_headers", source: `/*\n${body}\n` });
    },
  };

  return {
    plugins: [
      preact(),
      cspPlugin,
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: false,
        manifest: {
          name: "Footprint",
          short_name: "Footprint",
          description: "Manual listing-search links and photo-removal guides. Address lookups use a server.",
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
        },
        workbox: { globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"], navigateFallback: "index.html" },
      }),
    ],
    define: { __API__: JSON.stringify(api) },
    // the removal guides live in docs/ so they can be edited without touching code
    server: { fs: { allow: ["../.."] } },
    build: { target: "es2022", sourcemap: true },
    preview: { headers },
  };
});
