import { blurFMap, makeFMap, resizeFMap } from "./image";
import type { FMap } from "./types";

// gabor texture energy, tuned to find *patterns* (tile grout, wallpaper, rugs) rather than plain edges.
// trick: a lone edge only fires one orientation, a grid fires two orthogonal ones at once. so we take the
// geometric mean of orthogonal pairs and an edge mostly cancels out.

type Kernel = { size: number; even: Float32Array; odd: Float32Array };

function gaborKernel(lambda: number, theta: number): Kernel {
  const sigma = 0.56 * lambda;
  const half = Math.ceil(2.5 * sigma);
  const size = half * 2 + 1;
  const even = new Float32Array(size * size);
  const odd = new Float32Array(size * size);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  let evenMean = 0;
  for (let y = -half; y <= half; y++) {
    for (let x = -half; x <= half; x++) {
      const xr = x * ct + y * st;
      const yr = -x * st + y * ct;
      const g = Math.exp(-(xr * xr + yr * yr) / (2 * sigma * sigma));
      const i = (y + half) * size + (x + half);
      even[i] = g * Math.cos((2 * Math.PI * xr) / lambda);
      odd[i] = g * Math.sin((2 * Math.PI * xr) / lambda);
      evenMean += even[i];
    }
  }
  // kill the dc term or flat bright walls read as "texture"
  evenMean /= size * size;
  let norm = 0;
  for (let i = 0; i < even.length; i++) {
    even[i] -= evenMean;
    norm += Math.abs(even[i]);
  }
  for (let i = 0; i < even.length; i++) {
    even[i] /= norm;
    odd[i] /= norm;
  }
  return { size, even, odd };
}

const THETAS = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4];
const LAMBDA = 4;
const BANK = THETAS.map((t) => gaborKernel(LAMBDA, t));

function energy(gray: FMap, k: Kernel): Float32Array {
  const { width: w, height: h, data } = gray;
  const out = new Float32Array(w * h);
  const half = (k.size - 1) >> 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let re = 0;
      let im = 0;
      for (let ky = -half; ky <= half; ky++) {
        const yy = Math.min(h - 1, Math.max(0, y + ky));
        const row = yy * w;
        const krow = (ky + half) * k.size + half;
        for (let kx = -half; kx <= half; kx++) {
          const xx = Math.min(w - 1, Math.max(0, x + kx));
          const v = data[row + xx];
          re += v * k.even[krow + kx];
          im += v * k.odd[krow + kx];
        }
      }
      out[y * w + x] = Math.sqrt(re * re + im * im);
    }
  }
  return out;
}

function patternAtScale(gray: FMap): FMap {
  const e = BANK.map((k) => energy(gray, k));
  const out = makeFMap(gray.width, gray.height);
  for (let i = 0; i < out.data.length; i++) {
    const a = Math.sqrt(e[0][i] * e[2][i]);
    const b = Math.sqrt(e[1][i] * e[3][i]);
    out.data[i] = a > b ? a : b;
  }
  return out;
}

// gray should be ~256px on the long side. returns raw pattern energy at the same size, smoothed into regions
export function patternEnergy(gray: FMap): FMap {
  const fine = patternAtScale(gray);
  const halfW = Math.max(8, Math.round(gray.width / 2));
  const halfH = Math.max(8, Math.round(gray.height / 2));
  const coarse = resizeFMap(patternAtScale(resizeFMap(gray, halfW, halfH)), gray.width, gray.height);
  const out = makeFMap(gray.width, gray.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.max(fine.data[i], coarse.data[i]);
  return blurFMap(out, Math.max(2, gray.width / 64));
}
