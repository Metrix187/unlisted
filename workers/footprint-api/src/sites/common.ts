import type { Address } from "../normalize";

export type SiteId = "zillow" | "redfin" | "realtor" | "trulia" | "homes" | "apartments" | "streetview";

export type Photo = { url: string; thumb: string };
export type Dates = { listed?: string; sold?: string; history?: { date: string; event: string }[] };
export type Parsed = { photos: Photo[]; dates: Dates; listingUrl?: string };

export type Site = {
  id: SiteId;
  name: string;
  hosts: string[];
  // what a person would open to find the listing themselves
  searchUrl(a: Address, display: string): string;
  // what *we* would fetch to find the listing. may well be robots-disallowed, that's fine, we'll say so
  lookupUrl?(a: Address, display: string): string | undefined;
  // given a page we fetched, is there a listing link in it we should follow?
  findListing?(html: string, a: Address): string | undefined;
  parse(html: string, url: string): Parsed;
  // street view and friends: no photos to fetch, just a link + instructions
  linkOnly?: boolean;
};

export const ddg = (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;

export function isHost(url: string, hosts: string[]) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return hosts.some((x) => h === x || h.endsWith(`.${x}`));
  } catch {
    return false;
  }
}

function decodeEntities(s: string) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/gi, "/")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// every <script type="application/ld+json"> blob, parsed. broken ones get skipped quietly
export function jsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      const v = JSON.parse(m[1].trim());
      if (Array.isArray(v)) out.push(...v);
      else if (v && typeof v === "object" && "@graph" in v)
        out.push(...((v as { "@graph": unknown[] })["@graph"] ?? []));
      else out.push(v);
    } catch {
      // half the internet's json-ld is invalid. moving on
    }
  }
  return out;
}

export function scriptJson(html: string, id: string): unknown {
  const m = html.match(new RegExp(`<script[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, "i"));
  if (!m) return;
  try {
    return JSON.parse(m[1]);
  } catch {
    return;
  }
}

export function metaContent(html: string, prop: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "gi");
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(decodeEntities(m[1]));
  return out;
}

// pull image urls out of json-ld image fields, whatever shape they come in
export function ldImages(nodes: unknown[]): string[] {
  const out: string[] = [];
  const take = (v: unknown) => {
    if (!v) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(take);
    else if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      take(o.contentUrl ?? o.url);
    }
  };
  const walk = (n: unknown, depth = 0) => {
    if (!n || typeof n !== "object" || depth > 4) return;
    const o = n as Record<string, unknown>;
    if ("image" in o) take(o.image);
    if ("photo" in o) take(o.photo);
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  nodes.forEach((n) => walk(n));
  return out;
}

export function ldDates(nodes: unknown[]): Dates {
  const dates: Dates = {};
  const walk = (n: unknown, depth = 0) => {
    if (!n || typeof n !== "object" || depth > 4) return;
    const o = n as Record<string, unknown>;
    if (typeof o.datePosted === "string" && !dates.listed) dates.listed = isoDate(o.datePosted);
    if (typeof o.dateSold === "string" && !dates.sold) dates.sold = isoDate(o.dateSold);
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  nodes.forEach((n) => walk(n));
  return dates;
}

export function isoDate(v: string | number | undefined): string | undefined {
  if (v === undefined || v === null || v === "") return;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

// every match of a cdn url pattern, entity-decoded and unescaped from json
export function grab(html: string, re: RegExp): string[] {
  const out: string[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const src = html.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  for (let m = g.exec(src); m; m = g.exec(src)) out.push(decodeEntities(m[0]));
  return out;
}

// collapse size variants of the same photo. keyFn maps a url to its "this is the same picture" id, and
// sizeFn guesses how big it is, so we keep the biggest as `url` and a smaller one as `thumb`
export function dedupe(urls: string[], keyFn: (u: string) => string, sizeFn: (u: string) => number): Photo[] {
  const byKey = new Map<string, string[]>();
  for (const u of urls) {
    if (!/^https:\/\//.test(u)) continue;
    const k = keyFn(u);
    const list = byKey.get(k) ?? [];
    if (!list.includes(u)) list.push(u);
    byKey.set(k, list);
  }
  return [...byKey.values()].map((list) => {
    const sorted = [...list].sort((a, b) => sizeFn(b) - sizeFn(a));
    const big = sorted[0];
    const small = sorted.find((u) => sizeFn(u) <= 800 && sizeFn(u) > 0) ?? sorted[sorted.length - 1];
    return { url: big, thumb: small };
  });
}

export const slugTitle = (s: string) =>
  s
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("-");
