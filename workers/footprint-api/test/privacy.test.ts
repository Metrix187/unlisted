import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FetchFn } from "../src/http";
import { makeApp } from "../src/index";
import { MemoryKV, page, photo, robotsFile } from "./helpers";

// "footprint never persists an address", as a test. we run a pile of lookups, then go through everything
// the worker could have kept (kv, the robots cache, console output) looking for any piece of the address

const LOGS: string[] = [];
beforeEach(() => {
  LOGS.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      LOGS.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

const fetch: FetchFn = async (url) => {
  const u = new URL(url);
  if (u.pathname === "/robots.txt") {
    try {
      return new Response(robotsFile(u.host));
    } catch {
      return new Response("", { status: 404 });
    }
  }
  if (u.host === "www.redfin.com") return new Response(page("redfin"));
  return new Response(page("perimeterx"), { status: 403 });
};

const INPUTS = [
  "123 Example St, Springfield, IL 62701",
  "4821 Imaginary Lane, Apt 7, Shelbyville, Tennessee 37160",
  "https://www.redfin.com/IL/Springfield/77-Pretend-Ave-62702/home/99999999",
  "https://www.zillow.com/homedetails/9-Fictional-Ct-Ogdenville-OR-97477/88888888_zpid/",
];

// every way a piece of those addresses could show up, in any case
const NEEDLES = [
  "example st",
  "123-example",
  "imaginary",
  "4821",
  "shelbyville",
  "37160",
  "pretend",
  "62702",
  "fictional",
  "ogdenville",
  "97477",
  "springfield",
  "62701",
];

test("nothing about an address survives the request", async () => {
  const kv = new MemoryKV();
  const app = makeApp({ fetch, gapMs: 0, photo });
  for (const address of INPUTS) {
    // twice, so the cache-hit path runs too
    for (let i = 0; i < 2; i++) {
      const res = await app.request(
        "/lookup",
        {
          method: "POST",
          body: JSON.stringify({ address }),
          headers: { "content-type": "application/json" },
        },
        { CACHE: kv },
      );
      expect(res.status).toBe(200);
    }
  }
  // and the error path
  await app.request(
    "/lookup",
    { method: "POST", body: JSON.stringify({ address: "99 Nowhere Special" }) },
    { CACHE: kv },
  );

  const everything = `${kv.dump()}\n${LOGS.join("\n")}`.toLowerCase();
  for (const n of NEEDLES) expect(everything, `found "${n}" in stored state or logs`).not.toContain(n);

  // kv keys are hashes or robots origins, nothing else
  for (const k of kv.store.keys())
    expect(k).toMatch(/^(lookup:v1:[0-9a-f]{64}|robots:https:\/\/[a-z0-9.-]+)$/);
  // and the cached value only has the fields we promised
  for (const [k, v] of kv.store) {
    if (!k.startsWith("lookup:")) continue;
    const parsed = JSON.parse(v) as { sites: Record<string, unknown>[] };
    for (const s of parsed.sites)
      expect(Object.keys(s).sort()).toEqual(
        ["blocked", "dates", "photoCount", "photos", "reason", "site"].filter((f) => f in s).sort(),
      );
    expect(v).not.toContain("listingUrl");
    expect(v).not.toContain("searchUrl");
  }
});

test("the response still has the address in it (that's the user's own request, not storage)", async () => {
  const app = makeApp({ fetch, gapMs: 0, photo });
  const res = await app.request(
    "/lookup",
    {
      method: "POST",
      body: JSON.stringify({ address: INPUTS[0] }),
      headers: { "content-type": "application/json" },
    },
    { CACHE: new MemoryKV() },
  );
  expect(((await res.json()) as { address: string }).address).toBe("123 Example St, Springfield, IL 62701");
});
