import { display } from "../normalize";
import { type Site, ddg, dedupe, grab, jsonLd, ldDates, ldImages } from "./common";

// apartments.com (also costar, also akamai). rentals mostly, which is exactly where interior photos of
// people's actual homes pile up. same deal as homes.com: pasted pages only, and usually walled

const RE = /https:\/\/images1\.apartments\.com\/i2\/[A-Za-z0-9_-]+\/(\d+)\/[A-Za-z0-9_.-]+\.(?:jpg|webp)/;
export const aptKey = (u: string) => u.split("/").slice(0, 5).join("/");
export const aptSize = (u: string) => Number(u.match(RE)?.[1] ?? 500);

export const apartments: Site = {
  id: "apartments",
  name: "Apartments.com",
  hosts: ["apartments.com"],
  searchUrl: (a) => ddg(`"${display(a)}" site:apartments.com`),
  lookupUrl: (a) =>
    `https://www.apartments.com/services/geography/search/?t=${encodeURIComponent(display(a))}`,
  parse(html) {
    const ld = jsonLd(html);
    const urls = [...ldImages(ld), ...grab(html, RE)];
    return { photos: dedupe(urls, aptKey, aptSize), dates: ldDates(ld) };
  },
};
