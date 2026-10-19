// the one loud thing on screen. green -> amber -> red, as rgb triples so canvas code can use them too
type RGB = [number, number, number];

const COOL: RGB = [48, 164, 108];
const MID: RGB = [245, 166, 35];
const HOT: RGB = [229, 72, 77];

export function heatColor(t: number): RGB {
  const x = Math.max(0, Math.min(1, t));
  const [from, to, k] = x < 0.5 ? [COOL, MID, x * 2] : [MID, HOT, (x - 0.5) * 2];
  return [
    Math.round(from[0] + (to[0] - from[0]) * k),
    Math.round(from[1] + (to[1] - from[1]) * k),
    Math.round(from[2] + (to[2] - from[2]) * k),
  ];
}

export function scoreColor(score: number): string {
  const [r, g, b] = heatColor(score / 100);
  return `rgb(${r} ${g} ${b})`;
}
