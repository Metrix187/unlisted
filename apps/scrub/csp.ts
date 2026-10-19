import { MODEL_HOSTS } from "@unlisted/vision/models";

// the privacy promise, enforced by the browser. connect-src is self + the model cdns and nothing else,
// so even a bug can't ship a photo off somewhere. the e2e network test double-checks this
export const CSP_DIRECTIVES: Record<string, string> = {
  "default-src": "'self'",
  "script-src": "'self' 'wasm-unsafe-eval'",
  "worker-src": "'self'",
  "connect-src": ["'self'", ...MODEL_HOSTS].join(" "),
  "img-src": "'self' blob: data:",
  "style-src": "'self'",
  "font-src": "'self'",
  "manifest-src": "'self'",
  "media-src": "'none'",
  "object-src": "'none'",
  "base-uri": "'none'",
  "form-action": "'self'",
};

export function cspString(extra: Record<string, string> = {}) {
  return Object.entries({ ...CSP_DIRECTIVES, ...extra })
    .map(([k, v]) => `${k} ${v}`)
    .join("; ");
}

// header-only directives (meta tags ignore these)
export const HEADER_ONLY = { "frame-ancestors": "'none'" };
