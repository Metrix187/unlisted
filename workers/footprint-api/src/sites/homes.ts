import { display } from "../normalize";
import { type Site, ddg, dedupe, grab, jsonLd, ldDates, ldImages } from "./common";

// homes.com (costar). akamai answers anything that isn't a browser with "access denied", robots.txt
// included. parser's here for pasted pages and for the day that changes

const RE = /https:\/\/images\.homes\.com\/listings\/\d+\/[0-9-]+\.(?:jpg|webp)(?:\?t=[a-z])?/;
const T_SIZE: Record<string, number> = { p: 1200, l: 800, m: 480, s: 240 };

export const homesKey = (u: string) => u.split("?")[0];
export const homesSize = (u: string) => T_SIZE[new URL(u).searchParams.get("t") ?? ""] ?? 1000;

export const homes: Site = {
  id: "homes",
  name: "Homes.com",
  hosts: ["homes.com"],
  searchUrl: (a) => ddg(`"${display(a)}" site:homes.com`),
  lookupUrl: (a) =>
    `https://www.homes.com/routes/res/consumer/property/autocomplete?term=${encodeURIComponent(display(a))}`,
  parse(html) {
    const ld = jsonLd(html);
    const urls = [...ldImages(ld), ...grab(html, RE)];
    // homes.com serves one file at several sizes via ?t=. make sure every photo has a small one to show
    const photos = dedupe(urls, homesKey, homesSize).map((p) => ({
      url: p.url,
      thumb: `${p.url.split("?")[0]}?t=m`,
    }));
    return { photos, dates: ldDates(ld) };
  },
};
