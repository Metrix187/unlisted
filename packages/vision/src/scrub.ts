import {
  blurFMap,
  blurRGBA,
  composite,
  desaturate,
  fitWithin,
  gradientBackdrop,
  medianColor,
  resizeFMap,
  resizeRGBA,
  smoothstep,
} from "./image";
import type { Backdrop, FMap, RGBA } from "./types";

// subject mask comes in at analysis resolution; blow it up and soften the edge so hair doesn't look
// like it was cut out with safety scissors
export function prepareMask(mask: FMap, width: number, height: number): FMap {
  const big = resizeFMap(mask, width, height);
  const soft = blurFMap(big, Math.max(1.5, Math.max(width, height) * 0.004));
  // slight choke so the sliver of room hugging the person goes too
  for (let i = 0; i < soft.data.length; i++) soft.data[i] = smoothstep(0.35, 0.85, soft.data[i]);
  return soft;
}

// how hard to smear the background, as a fraction of the long side. same look on a 4k photo or a thumbnail
const BG_SIGMA = 0.03;

export function backgroundSigma(width: number, height: number) {
  return Math.max(8, Math.max(width, height) * BG_SIGMA);
}

// the blur is huge anyway, so do it on a small copy and scale back up. way cheaper, looks identical
function smear(img: RGBA, sigmaFrac: number, desat: number): RGBA {
  const [w, h] = fitWithin(img.width, img.height, 512);
  const small = resizeRGBA(img, w, h);
  const blurred = desaturate(blurRGBA(small, Math.max(2, Math.max(w, h) * sigmaFrac)), desat);
  return resizeRGBA(blurred, img.width, img.height);
}

export function scrubBackground(img: RGBA, subject: FMap, backdrop: Backdrop): RGBA {
  const mask = subject.width === img.width ? subject : prepareMask(subject, img.width, img.height);
  const bg =
    backdrop === "plain"
      ? gradientBackdrop(img.width, img.height, medianColor(img))
      : // big blur, then wash most of the color out so even the room's palette gets mushy
        smear(img, BG_SIGMA, 0.75);
  return composite(img, bg, mask);
}

// keep the room, smear just the hot stuff
export function blurHotspots(img: RGBA, heat: FMap, threshold = 0.42): RGBA {
  const big = resizeFMap(heat, img.width, img.height);
  const keep: FMap = { width: img.width, height: img.height, data: new Float32Array(big.data.length) };
  for (let i = 0; i < big.data.length; i++)
    keep.data[i] = 1 - smoothstep(threshold - 0.12, threshold + 0.08, big.data[i]);
  const soft = blurFMap(keep, Math.max(2, Math.max(img.width, img.height) * 0.006));
  return composite(img, smear(img, BG_SIGMA * 0.8, 0.5), soft);
}
