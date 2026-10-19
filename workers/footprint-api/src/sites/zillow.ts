import { type Address, streetLine } from "../normalize";
import { type Dates, type Site, dedupe, grab, isoDate, jsonLd, ldImages, scriptJson } from "./common";

// zillow tucks the whole listing into __NEXT_DATA__ -> gdpClientCache, which is itself a json *string*
// keyed by a graphql query name. we dig for `property` wherever it is

type ZPhoto = { mixedSources?: { jpeg?: { url: string; width: number }[] }; url?: string };
type ZProperty = {
  responsivePhotos?: ZPhoto[];
  originalPhotos?: ZPhoto[];
  datePostedString?: string;
  dateSold?: number | string;
  priceHistory?: { date?: string; event?: string }[];
};

function findProperty(next: unknown): ZProperty | undefined {
  const cacheStr = (next as { props?: { pageProps?: { componentProps?: { gdpClientCache?: string } } } })
    ?.props?.pageProps?.componentProps?.gdpClientCache;
  if (!cacheStr) return;
  try {
    const cache = JSON.parse(cacheStr) as Record<string, { property?: ZProperty }>;
    return Object.values(cache).find((v) => v?.property)?.property;
  } catch {
    return;
  }
}

const SIZE_RE = /-(cc_ft_(\d+)|p_([a-z])|uncropped_scaled_within_(\d+)_\d+|o_a|full)\.(jpg|webp|jpeg)$/;
const LETTER_SIZE: Record<string, number> = {
  a: 120,
  b: 192,
  c: 256,
  d: 300,
  e: 384,
  f: 576,
  g: 768,
  h: 1024,
};

export const zillowKey = (u: string) => u.split("?")[0].replace(SIZE_RE, "");
export function zillowSize(u: string) {
  const m = u.split("?")[0].match(SIZE_RE);
  if (!m) return 0;
  if (m[2]) return Number(m[2]);
  if (m[3]) return LETTER_SIZE[m[3]] ?? 400;
  if (m[4]) return Number(m[4]);
  return 2000;
}

const slug = (a: Address) =>
  `${streetLine(a)} ${a.city} ${a.state}${a.zip ? ` ${a.zip}` : ""}`
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/gi, "");

export const zillow: Site = {
  id: "zillow",
  name: "Zillow",
  hosts: ["zillow.com", "zillowstatic.com"],
  searchUrl: (a) => `https://www.zillow.com/homes/${slug(a)}_rb/`,
  // same url. robots.txt says Disallow: /homes/ for everyone, so this is going to come back "robots"
  lookupUrl: (a) => `https://www.zillow.com/homes/${slug(a)}_rb/`,
  findListing(html) {
    const m = html.match(/https:\/\/www\.zillow\.com\/homedetails\/[^"'\s<>]+_zpid\/?/);
    return m?.[0];
  },
  parse(html) {
    const prop = findProperty(scriptJson(html, "__NEXT_DATA__"));
    let urls: string[] = [];
    for (const p of [...(prop?.responsivePhotos ?? []), ...(prop?.originalPhotos ?? [])]) {
      for (const s of p.mixedSources?.jpeg ?? []) urls.push(s.url);
      if (p.url) urls.push(p.url);
    }
    // structure moves around every few months. fall back to anything that looks like a listing photo
    if (!urls.length)
      urls = [
        ...ldImages(jsonLd(html)),
        ...grab(html, /https:\/\/photos\.zillowstatic\.com\/fp\/[a-f0-9]+-[a-z0-9_]+\.(?:jpg|webp)/),
      ];
    const dates: Dates = {};
    if (prop?.datePostedString) dates.listed = isoDate(prop.datePostedString);
    if (prop?.dateSold) dates.sold = isoDate(Number(prop.dateSold) || String(prop.dateSold));
    const history = (prop?.priceHistory ?? [])
      .filter((h) => h.date && h.event)
      .map((h) => ({ date: isoDate(h.date)!, event: h.event! }))
      .filter((h) => h.date);
    if (history.length) dates.history = history;
    return { photos: dedupe(urls, zillowKey, zillowSize), dates };
  },
};
