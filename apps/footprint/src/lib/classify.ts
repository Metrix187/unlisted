import { classifyScene } from "@unlisted/vision";

export type Kind = "interior" | "exterior" | "unknown";

// same sky-and-greenery heuristic scrub ships, run on the thumbnail. needs pixel access, so it only works
// for images that came through our proxy (cors) or from a cdn that happens to allow it
export function classifyImg(img: HTMLImageElement): Kind {
  try {
    const w = Math.min(160, img.naturalWidth);
    const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    return classifyScene({ width: w, height: h, data: d.data }).exterior ? "exterior" : "interior";
  } catch {
    // tainted canvas. we just can't tell
    return "unknown";
  }
}
