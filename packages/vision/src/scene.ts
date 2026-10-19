import { fitWithin, resizeRGBA } from "./image";
import type { RGBA } from "./types";

// interior vs exterior for listing photos. cheap and dumb on purpose: exteriors have sky touching the
// top edge, and usually some green. ceilings also touch the top edge, so white "sky" counts for less
// than blue sky, and it has to be really bright.

export type SceneGuess = { exterior: boolean; sky: number; green: number; confidence: number };

export function classifyScene(img: RGBA): SceneGuess {
  const [w, h] = fitWithin(img.width, img.height, 96);
  const s = resizeRGBA(img, w, h);
  const d = s.data;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; p < lum.length; i += 4, p++)
    lum[p] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;

  // 0 = not sky, 1 = blue-ish sky, 2 = blown-out/overcast sky
  const cand = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const gx = x > 0 && x < w - 1 ? Math.abs(lum[p + 1] - lum[p - 1]) : 0;
      const gy = y > 0 && y < h - 1 ? Math.abs(lum[p + w] - lum[p - w]) : 0;
      const smooth = gx + gy < 0.08;
      if (!smooth) continue;
      if (b > r + 12 && b >= g - 4 && lum[p] > 0.35) cand[p] = 1;
      else if (lum[p] > 0.86 && Math.max(r, g, b) - Math.min(r, g, b) < 26) cand[p] = 2;
    }

  // flood fill from the top row so a window halfway down the wall doesn't count
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) if (cand[x]) stack.push(x);
  let blue = 0;
  let white = 0;
  while (stack.length) {
    const p = stack.pop()!;
    if (seen[p] || !cand[p]) continue;
    seen[p] = 1;
    if (cand[p] === 1) blue++;
    else white++;
    const x = p % w;
    const y = (p / w) | 0;
    if (y > h * 0.65) continue;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }

  let green = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 1] > d[i] * 1.08 && d[i + 1] > d[i + 2] * 1.05 && d[i + 1] > 50) green++;
  }
  const n = w * h;
  const sky = (blue + white * 0.45) / n;
  const greenFrac = green / n;
  const score = sky * 2.2 + greenFrac * 0.6;
  return {
    exterior: score > 0.2,
    sky,
    green: greenFrac,
    confidence: Math.min(1, Math.abs(score - 0.2) * 3),
  };
}
