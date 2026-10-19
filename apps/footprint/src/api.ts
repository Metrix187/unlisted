declare const __API__: string;

export const API = __API__.replace(/\/$/, "");

export type Photo = { url: string; thumb: string };
export type SiteResult = {
  site: "zillow" | "redfin" | "realtor" | "trulia" | "homes" | "apartments" | "streetview";
  name: string;
  listingUrl: string;
  searchUrl: string;
  photoCount: number;
  photos: Photo[];
  dates: { listed?: string; sold?: string; history?: { date: string; event: string }[] };
  blocked: boolean;
  reason?: "robots" | "bot-wall" | "not-found" | "error" | "link-only";
};
export type LookupResult = { address: string; sites: SiteResult[]; cached: boolean; fetchedAt: string };

export async function lookup(address: string): Promise<LookupResult> {
  const res = await fetch(`${API}/lookup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? "Lookup failed. Try again in a minute.");
  return body as LookupResult;
}

// cdns the worker is allowed to fetch from (their robots.txt says ok). everything else loads straight
// from the listing site in an <img> with no referrer
const PROXIED = ["photos.zillowstatic.com", "fixtures.unlisted.test"];

export function thumbSrc(u: string): { src: string; proxied: boolean } {
  try {
    if (PROXIED.includes(new URL(u).hostname))
      return { src: `${API}/img?u=${encodeURIComponent(u)}`, proxied: true };
  } catch {
    // fall through
  }
  return { src: u, proxied: false };
}
