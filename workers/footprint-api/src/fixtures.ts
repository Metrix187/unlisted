import { PAGES, PHOTOS, ROBOTS } from "./fixtures.generated";
import type { FetchFn } from "./http";
import type { SiteId } from "./sites";

// the demo address. type it in (or any spelling of it) and every site answers from fixtures/ instead of
// the internet. made up, obviously
export const FIXTURE_ADDRESS = "123 Example St, Springfield, IL 62701";
export const FIXTURE_CANONICAL = "123 example st, springfield, il 62701";
export const FIXTURE_HOST = "fixtures.unlisted.test";

const LISTINGS: Partial<Record<SiteId, string>> = {
  zillow: "https://www.zillow.com/homedetails/123-Example-St-Springfield-IL-62701/00000001_zpid/",
  redfin: "https://www.redfin.com/IL/Springfield/123-Example-St-62701/home/00000001",
  realtor:
    "https://www.realtor.com/realestateandhomes-detail/123-Example-St_Springfield_IL_62701_M00000-00001",
  trulia: "https://www.trulia.com/home/123-example-st-springfield-il-62701--00000001",
  homes: "https://www.homes.com/property/123-example-st-springfield-il/0000000001/",
  apartments: "https://www.apartments.com/123-example-st-springfield-il/0000001/",
};

export function fixtureListing(site: SiteId, canonical: string) {
  return canonical === FIXTURE_CANONICAL ? LISTINGS[site] : undefined;
}

const PAGE_FOR: Record<string, string> = {
  [LISTINGS.zillow!]: "zillow",
  [LISTINGS.redfin!]: "redfin",
  [LISTINGS.realtor!]: "realtor",
  [LISTINGS.trulia!]: "trulia",
};
// costar's two sites play the part of the bot wall
const WALLED = new Set(["www.homes.com", "www.apartments.com"]);

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// stands in for fetch() in fixture mode. robots files are real snapshots, so robots rules still bite
export const fixtureFetch: FetchFn = async (url) => {
  const u = new URL(url);
  if (WALLED.has(u.host)) return html(PAGES["akamai-denied"], 403);
  if (u.pathname === "/robots.txt") {
    const t = ROBOTS[u.host];
    return t
      ? new Response(t, { headers: { "content-type": "text/plain" } })
      : new Response("", { status: 404 });
  }
  const page = PAGE_FOR[url];
  if (page) return html(PAGES[page]);
  return html("<h1>not found</h1>", 404);
};

// map a fixture photo url back to its file. longest name wins so fp-kitchen-2 doesn't resolve to fp-kitchen
export function fixturePhotoFile(url: string): string | undefined {
  const path = new URL(url).pathname.replace(/_/g, "-");
  let best: string | undefined;
  for (const name of PHOTOS) if (path.includes(name) && (!best || name.length > best.length)) best = name;
  return best ? `${best}.jpg` : undefined;
}
