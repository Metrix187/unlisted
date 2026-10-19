import { percentile } from "./image";
import type { Box, FMap } from "./types";

// windows are the single most identifying thing in a room photo (the view outside is basically a
// fingerprint), and no off-the-shelf detector has a "window" class. so: bright, roughly rectangular,
// much brighter than what's around it, with crisp edges. the crisp-edge part is what makes a blurred
// window stop counting, which is exactly what we want after a scrub.

export type WindowHit = { box: Box; strength: number };

function close(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -r; dy <= r && !on; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w && mask[yy * w + xx]) {
            on = 1;
            break;
          }
        }
      dil[y * w + x] = on;
    }
  const ero = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let on = 1;
      for (let dy = -r; dy <= r && on; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          if (!dil[yy * w + xx]) {
            on = 0;
            break;
          }
        }
      ero[y * w + x] = on;
    }
  return ero;
}

type Comp = { area: number; x0: number; y0: number; x1: number; y1: number; edge: number; edgeN: number };

export function findWindows(gray: FMap): WindowHit[] {
  const { width: w, height: h, data } = gray;
  const thr = Math.max(0.72, percentile(data, 0.9));
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) mask[i] = data[i] >= thr ? 1 : 0;
  mask = close(mask, w, h, 1);

  // gradient magnitude, used to check how sharp each blob's border is
  const grad = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = data[i + 1] - data[i - 1];
      const gy = data[i + w] - data[i - w];
      grad[i] = Math.sqrt(gx * gx + gy * gy) * 0.5;
    }

  const label = new Int32Array(w * h).fill(-1);
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const c: Comp = { area: 0, x0: w, y0: h, x1: 0, y1: 0, edge: 0, edgeN: 0 };
    const id = comps.length;
    comps.push(c);
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p / w) | 0;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      let border = false;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q < 0) continue;
        if (!mask[q]) border = true;
        else if (label[q] < 0) {
          label[q] = id;
          stack.push(q);
        }
      }
      if (border) {
        // peak gradient within a pixel of the border
        let g = grad[p];
        for (const q of nb) if (q >= 0 && grad[q] > g) g = grad[q];
        c.edge += g;
        c.edgeN++;
      }
    }
  }

  const total = w * h;
  const hits: WindowHit[] = [];
  for (const c of comps) {
    const frac = c.area / total;
    if (frac < 0.004 || frac > 0.45) continue;
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const fill = c.area / (bw * bh);
    const aspect = bw / bh;
    if (fill < 0.5 || aspect < 0.2 || aspect > 5) continue;

    // brightness inside vs a ring around the bbox
    const pad = Math.max(2, Math.round(Math.max(bw, bh) * 0.15));
    let inSum = 0;
    let inN = 0;
    let ringSum = 0;
    let ringN = 0;
    for (let y = Math.max(0, c.y0 - pad); y <= Math.min(h - 1, c.y1 + pad); y++)
      for (let x = Math.max(0, c.x0 - pad); x <= Math.min(w - 1, c.x1 + pad); x++) {
        const inside = x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1;
        if (inside) {
          inSum += data[y * w + x];
          inN++;
        } else {
          ringSum += data[y * w + x];
          ringN++;
        }
      }
    if (!ringN) continue;
    const contrast = inSum / inN - ringSum / ringN;
    const sharp = c.edgeN ? c.edge / c.edgeN : 0;
    if (contrast < 0.18 || sharp < 0.06) continue;

    const strength = Math.min(1, 0.5 + contrast + sharp * 2) * Math.min(1, fill + 0.2);
    hits.push({ box: { x: c.x0 / w, y: c.y0 / h, w: bw / w, h: bh / h }, strength });
  }
  return hits.sort((a, b) => b.strength - a.strength).slice(0, 6);
}
