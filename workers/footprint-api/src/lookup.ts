import { type FetchFn, Polite } from "./http";
import { type Address, addressFromListingUrl, normalize, sha256 } from "./normalize";
import { type Dates, type Photo, SITES, type SiteId, siteForUrl } from "./sites";

export type SiteResult = {
  site: SiteId;
  name: string;
  listingUrl: string;
  searchUrl: string;
  photoCount: number;
  photos: Photo[];
  dates: Dates;
  blocked: boolean;
  reason?: "robots" | "bot-wall" | "not-found" | "error" | "link-only";
};

export type LookupResult = {
  address: string; // display form, echoed back for the ui. never stored
  sites: SiteResult[];
  cached: boolean;
  fetchedAt: string;
};

// what goes in kv. photo urls, counts, dates, why a site was blocked. no address, no listing urls
// (those have the street baked into the slug), nothing that maps back to a person
type Cached = {
  v: 1;
  ts: string;
  sites: Pick<SiteResult, "site" | "photoCount" | "photos" | "dates" | "blocked" | "reason">[];
};

export type Env = {
  CACHE?: KVNamespace;
  FIXTURES?: string;
  ASSETS?: Fetcher;
};

export type Deps = {
  fetch: FetchFn;
  gapMs?: number;
  // fixture mode: maps (site, canonical address) to a canned listing url, skipping the search step
  fixtureListing?: (site: SiteId, canonical: string) => string | undefined;
};

export class InputError extends Error {}

export function parseInput(raw: string): {
  address: Address;
  display: string;
  canonical: string;
  pasted?: string;
} {
  const input = raw.trim();
  if (!input) throw new InputError("Type an address or paste a listing link.");
  if (input.length > 500) throw new InputError("That's a bit long for an address.");
  if (/^https?:\/\//i.test(input)) {
    if (!siteForUrl(input))
      throw new InputError(
        "We can read Zillow, Redfin, Realtor.com, Trulia, Homes.com and Apartments.com links.",
      );
    const fromSlug = addressFromListingUrl(input);
    if (!fromSlug)
      throw new InputError("Couldn't read the address out of that link. Try typing the address instead.");
    return { ...normalize(fromSlug), pasted: input };
  }
  try {
    return normalize(input);
  } catch (e) {
    throw new InputError(`Couldn't read that address: ${(e as Error).message}.`);
  }
}

export async function lookup(raw: string, env: Env, deps: Deps): Promise<LookupResult> {
  const { address, display, canonical, pasted } = parseInput(raw);
  const key = `lookup:v1:${await sha256(canonical)}`;

  const cached = await env.CACHE?.get(key);
  if (cached) {
    const c = JSON.parse(cached) as Cached;
    return {
      address: display,
      cached: true,
      fetchedAt: c.ts,
      sites: c.sites.map((s) => {
        const site = SITES.find((x) => x.id === s.site)!;
        const searchUrl = site.searchUrl(address, display);
        const listingUrl = pasted && siteForUrl(pasted)?.id === s.site ? pasted : searchUrl;
        return { ...s, name: site.name, searchUrl, listingUrl };
      }),
    };
  }

  const polite = new Polite(deps.fetch, { gapMs: deps.gapMs, robotsCache: env.CACHE });
  const sites = await Promise.all(
    SITES.map(async (site): Promise<SiteResult> => {
      const searchUrl = site.searchUrl(address, display);
      const base = {
        site: site.id,
        name: site.name,
        searchUrl,
        listingUrl: searchUrl,
        photoCount: 0,
        photos: [],
        dates: {},
      };
      if (site.linkOnly) return { ...base, blocked: false, reason: "link-only" };

      let target = pasted && siteForUrl(pasted)?.id === site.id ? pasted : undefined;
      target ??= deps.fixtureListing?.(site.id, canonical);
      if (!target) {
        const lookupUrl = site.lookupUrl?.(address, display);
        if (!lookupUrl) return { ...base, blocked: true, reason: "robots" };
        const res = await polite.get(lookupUrl);
        if (!res.ok) return { ...base, blocked: true, reason: res.reason };
        // some lookups land right on the listing (realtor), some return a link to follow
        target = site.findListing?.(res.text, address) ?? res.url;
        if (target === res.url) {
          const parsed = site.parse(res.text, res.url);
          return {
            ...base,
            listingUrl: res.url,
            photos: parsed.photos,
            photoCount: parsed.photos.length,
            dates: parsed.dates,
            blocked: false,
          };
        }
      }
      const page = await polite.get(target);
      if (!page.ok) return { ...base, listingUrl: target, blocked: true, reason: page.reason };
      const parsed = site.parse(page.text, page.url);
      if (!parsed.photos.length) return { ...base, listingUrl: target, blocked: false, reason: "not-found" };
      return {
        ...base,
        listingUrl: target,
        photos: parsed.photos,
        photoCount: parsed.photos.length,
        dates: parsed.dates,
        blocked: false,
      };
    }),
  );

  const ts = new Date().toISOString();
  const toStore: Cached = {
    v: 1,
    ts,
    sites: sites.map(({ site, photoCount, photos, dates, blocked, reason }) => ({
      site,
      photoCount,
      photos,
      dates,
      blocked,
      reason,
    })),
  };
  await env.CACHE?.put(key, JSON.stringify(toStore), { expirationTtl: 86_400 });
  return { address: display, sites, cached: false, fetchedAt: ts };
}
