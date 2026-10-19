import type { FMap, RGBA } from "./types";

// all the pixel pushing lives here. pure functions on buffers so vitest can poke them without a browser

export function makeRGBA(width: number, height: number): RGBA {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function makeFMap(width: number, height: number, fill = 0): FMap {
  const data = new Float32Array(width * height);
  if (fill) data.fill(fill);
  return { width, height, data };
}

export function fitWithin(width: number, height: number, max: number): [number, number] {
  const s = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s))];
}

// separable resize on n interleaved float channels. area-average going down, bilinear going up.
// area-averaging matters: point-sampling a 4000px photo down to 384 aliases tile grout into moire and
// then the texture map lights up on garbage
function resample1D(
  src: Float32Array,
  sw: number,
  sh: number,
  ch: number,
  dw: number,
  horizontal: boolean,
): Float32Array {
  const inLen = horizontal ? sw : sh;
  const outLen = dw;
  const lines = horizontal ? sh : sw;
  const out = new Float32Array((horizontal ? dw * sh : sw * dw) * ch);
  const scale = inLen / outLen;
  const idxIn = (line: number, i: number) => (horizontal ? (line * sw + i) * ch : (i * sw + line) * ch);
  const idxOut = (line: number, i: number) => (horizontal ? (line * dw + i) * ch : (i * sw + line) * ch);

  if (scale > 1) {
    for (let line = 0; line < lines; line++) {
      for (let o = 0; o < outLen; o++) {
        const start = o * scale;
        const end = start + scale;
        let i0 = Math.floor(start);
        const oi = idxOut(line, o);
        for (let c = 0; c < ch; c++) out[oi + c] = 0;
        let total = 0;
        for (; i0 < end && i0 < inLen; i0++) {
          const w = Math.min(i0 + 1, end) - Math.max(i0, start);
          if (w <= 0) continue;
          const ii = idxIn(line, i0);
          for (let c = 0; c < ch; c++) out[oi + c] += src[ii + c] * w;
          total += w;
        }
        if (total > 0) for (let c = 0; c < ch; c++) out[oi + c] /= total;
      }
    }
  } else {
    for (let line = 0; line < lines; line++) {
      for (let o = 0; o < outLen; o++) {
        const pos = Math.max(0, Math.min(inLen - 1, (o + 0.5) * scale - 0.5));
        const a = Math.floor(pos);
        const b = Math.min(inLen - 1, a + 1);
        const t = pos - a;
        const ia = idxIn(line, a);
        const ib = idxIn(line, b);
        const oi = idxOut(line, o);
        for (let c = 0; c < ch; c++) out[oi + c] = src[ia + c] * (1 - t) + src[ib + c] * t;
      }
    }
  }
  return out;
}

function resampleChannels(src: Float32Array, sw: number, sh: number, ch: number, dw: number, dh: number) {
  const h = resample1D(src, sw, sh, ch, dw, true);
  return resample1D(h, dw, sh, ch, dh, false);
}

export function resizeRGBA(img: RGBA, dw: number, dh: number): RGBA {
  if (dw === img.width && dh === img.height) return { width: dw, height: dh, data: img.data.slice() };
  const f = Float32Array.from(img.data);
  const r = resampleChannels(f, img.width, img.height, 4, dw, dh);
  return { width: dw, height: dh, data: Uint8ClampedArray.from(r, (v) => Math.round(v)) };
}

export function resizeFMap(map: FMap, dw: number, dh: number): FMap {
  if (dw === map.width && dh === map.height) return { width: dw, height: dh, data: map.data.slice() };
  return { width: dw, height: dh, data: resampleChannels(map.data, map.width, map.height, 1, dw, dh) };
}

export function toGray(img: RGBA): FMap {
  const out = makeFMap(img.width, img.height);
  const d = img.data;
  for (let i = 0, j = 0; j < out.data.length; i += 4, j++) {
    out.data[j] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  }
  return out;
}

// box sizes that stack into a decent gaussian. the classic "3 box blurs ≈ gaussian" trick
export function boxesForGauss(sigma: number, n = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

// running-sum box blur along one axis, edge-clamped. cost doesn't care about radius which is the whole point
function boxPass(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  ch: number,
  r: number,
  horiz: boolean,
) {
  const len = horiz ? w : h;
  const lines = horiz ? h : w;
  const stride = horiz ? ch : w * ch;
  const norm = 1 / (2 * r + 1);
  const acc = new Float64Array(ch);
  for (let line = 0; line < lines; line++) {
    const base = horiz ? line * w * ch : line * ch;
    for (let c = 0; c < ch; c++) {
      let s = 0;
      for (let k = -r; k <= r; k++) {
        const i = Math.min(len - 1, Math.max(0, k));
        s += src[base + i * stride + c];
      }
      acc[c] = s;
    }
    for (let i = 0; i < len; i++) {
      const o = base + i * stride;
      for (let c = 0; c < ch; c++) dst[o + c] = acc[c] * norm;
      const add = Math.min(len - 1, i + r + 1);
      const sub = Math.max(0, i - r);
      for (let c = 0; c < ch; c++) acc[c] += src[base + add * stride + c] - src[base + sub * stride + c];
    }
  }
}

export function gaussianBlurChannels(data: Float32Array, w: number, h: number, ch: number, sigma: number) {
  if (sigma < 0.5) return data.slice();
  const a = data.slice();
  const b = new Float32Array(data.length);
  for (const size of boxesForGauss(sigma)) {
    const r = (size - 1) >> 1;
    boxPass(a, b, w, h, ch, r, true);
    boxPass(b, a, w, h, ch, r, false);
  }
  return a;
}

export function blurRGBA(img: RGBA, sigma: number): RGBA {
  const f = gaussianBlurChannels(Float32Array.from(img.data), img.width, img.height, 4, sigma);
  return { width: img.width, height: img.height, data: Uint8ClampedArray.from(f, (v) => Math.round(v)) };
}

export function blurFMap(map: FMap, sigma: number): FMap {
  return {
    width: map.width,
    height: map.height,
    data: gaussianBlurChannels(map.data, map.width, map.height, 1, sigma),
  };
}

export function desaturate(img: RGBA, amount: number): RGBA {
  const out = makeRGBA(img.width, img.height);
  const s = img.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const y = 0.2126 * s[i] + 0.7152 * s[i + 1] + 0.0722 * s[i + 2];
    d[i] = s[i] + (y - s[i]) * amount;
    d[i + 1] = s[i + 1] + (y - s[i + 1]) * amount;
    d[i + 2] = s[i + 2] + (y - s[i + 2]) * amount;
    d[i + 3] = s[i + 3];
  }
  return out;
}

// per-channel median via histograms. close enough to "the color of this room" for a backdrop
export function medianColor(img: RGBA): [number, number, number] {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const d = img.data;
  const step = Math.max(1, Math.floor(d.length / 4 / 200_000)) * 4;
  let n = 0;
  for (let i = 0; i < d.length; i += step) {
    hist[0][d[i]]++;
    hist[1][d[i + 1]]++;
    hist[2][d[i + 2]]++;
    n++;
  }
  return hist.map((h) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += h[v];
      if (acc >= n / 2) return v;
    }
    return 128;
  }) as [number, number, number];
}

// flat-ish vertical gradient around a base color. reads as "studio backdrop", not as a room
export function gradientBackdrop(width: number, height: number, base: [number, number, number]): RGBA {
  const out = makeRGBA(width, height);
  const top = base.map((c) => Math.min(255, c * 1.08 + 10));
  const bot = base.map((c) => Math.max(0, c * 0.86 - 6));
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    const r = top[0] + (bot[0] - top[0]) * t;
    const g = top[1] + (bot[1] - top[1]) * t;
    const b = top[2] + (bot[2] - top[2]) * t;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  }
  return out;
}

// out = fg where mask≈1, bg where mask≈0
export function composite(fg: RGBA, bg: RGBA, mask: FMap): RGBA {
  const out = makeRGBA(fg.width, fg.height);
  const m = mask.data;
  for (let p = 0, i = 0; p < m.length; p++, i += 4) {
    const a = m[p] < 0 ? 0 : m[p] > 1 ? 1 : m[p];
    out.data[i] = fg.data[i] * a + bg.data[i] * (1 - a);
    out.data[i + 1] = fg.data[i + 1] * a + bg.data[i + 1] * (1 - a);
    out.data[i + 2] = fg.data[i + 2] * a + bg.data[i + 2] * (1 - a);
    out.data[i + 3] = 255;
  }
  return out;
}

export function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function percentile(values: Float32Array, p: number): number {
  const step = Math.max(1, Math.floor(values.length / 50_000));
  const sample: number[] = [];
  for (let i = 0; i < values.length; i += step) sample.push(values[i]);
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.max(0, Math.floor(p * (sample.length - 1))))] ?? 0;
}

export function mean(values: Float32Array): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return values.length ? s / values.length : 0;
}

// crop by a normalized box, clamped to the image
export function cropRGBA(img: RGBA, x: number, y: number, w: number, h: number): RGBA {
  const x0 = Math.max(0, Math.floor(x * img.width));
  const y0 = Math.max(0, Math.floor(y * img.height));
  const x1 = Math.min(img.width, Math.ceil((x + w) * img.width));
  const y1 = Math.min(img.height, Math.ceil((y + h) * img.height));
  const cw = Math.max(1, x1 - x0);
  const ch = Math.max(1, y1 - y0);
  const out = makeRGBA(cw, ch);
  for (let row = 0; row < ch; row++) {
    const s = ((y0 + row) * img.width + x0) * 4;
    out.data.set(img.data.subarray(s, s + cw * 4), row * cw * 4);
  }
  return out;
}
