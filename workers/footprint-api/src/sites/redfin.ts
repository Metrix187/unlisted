import { display } from "../normalize";
import { type Site, ddg, dedupe, grab, jsonLd, ldDates, ldImages } from "./common";

// redfin detail pages carry schema.org json-ld with the photo list, plus the same urls all over the
// react server state. /stingray/ (their search api) is robots-disallowed, so we can only read pages
// people paste

const SIZES: Record<string, number> = {
  bigphoto: 1024,
  mbpaddedwide: 800,
  mbphoto: 640,
  islphoto: 300,
  genIsl: 300,
};
const RE = /\/photo\/(\d+)\/([a-zA-Z]+)\/(\d+)\/([A-Za-z0-9_]+)\.(?:jpg|webp)/;

export const redfinKey = (u: string) => {
  const m = u.match(RE);
  return m ? `${m[1]}/${m[3]}/${m[4].replace(/^gen[A-Za-z]+\./, "")}` : u;
};
export const redfinSize = (u: string) => SIZES[u.match(RE)?.[2] ?? ""] ?? 500;

export const redfin: Site = {
  id: "redfin",
  name: "Redfin",
  hosts: ["redfin.com", "cdn-redfin.com"],
  searchUrl: (a) => ddg(`"${display(a)}" site:redfin.com`),
  lookupUrl: (a) =>
    `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(display(a))}&v=2`,
  findListing(text) {
    const m = text.match(/"url":"(\/[A-Z]{2}\/[^"]+\/home\/\d+)"/);
    return m ? `https://www.redfin.com${m[1]}` : undefined;
  },
  parse(html) {
    const ld = jsonLd(html);
    const urls = [
      ...ldImages(ld),
      ...grab(
        html,
        /https:\/\/ssl\.cdn-redfin\.com\/photo\/\d+\/[a-zA-Z]+\/\d+\/[A-Za-z0-9_.]+\.(?:jpg|webp)/,
      ),
    ].filter((u) => RE.test(u) || !u.includes("cdn-redfin"));
    return { photos: dedupe(urls, redfinKey, redfinSize), dates: ldDates(ld) };
  },
};
