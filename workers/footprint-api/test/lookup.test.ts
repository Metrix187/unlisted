import { describe, expect, test } from "vitest";
import type { FetchFn } from "../src/http";
import { makeApp } from "../src/index";
import type { LookupResult } from "../src/lookup";
import { MemoryKV, page, photo, robotsFile } from "./helpers";

const post = (app: ReturnType<typeof makeApp>, address: string, env: object) =>
  app.request(
    "/lookup",
    { method: "POST", body: JSON.stringify({ address }), headers: { "content-type": "application/json" } },
    env,
  );

// a pretend internet: real robots snapshots, bot walls where the real sites put them
function fakeNet(log: string[] = []): FetchFn {
  return async (url) => {
    log.push(url);
    const u = new URL(url);
    if (u.pathname === "/robots.txt") {
      try {
        return new Response(robotsFile(u.host));
      } catch {
        return new Response("", { status: 404 });
      }
    }
    if (u.host === "www.realtor.com") return new Response("slow down", { status: 429 });
    if (u.host.endsWith("zillow.com") || u.host.endsWith("trulia.com"))
      return new Response(page("perimeterx"), { status: 403 });
    return new Response(page("akamai-denied"), { status: 403 });
  };
}

describe("fixture address", () => {
  test("returns a full grid from the fixtures", async () => {
    const app = makeApp({ photo });
    const res = await post(app, "123 example street, springfield, illinois 62701", { CACHE: new MemoryKV() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LookupResult;
    const by = Object.fromEntries(body.sites.map((s) => [s.site, s]));
    expect(by.zillow).toMatchObject({ blocked: false, photoCount: 9 });
    expect(by.redfin).toMatchObject({ blocked: false, photoCount: 7 });
    expect(by.realtor).toMatchObject({ blocked: false, photoCount: 6 });
    expect(by.trulia).toMatchObject({ blocked: false, photoCount: 6 });
    expect(by.homes).toMatchObject({ blocked: true, reason: "bot-wall" });
    expect(by.apartments).toMatchObject({ blocked: true, reason: "bot-wall" });
    expect(by.streetview).toMatchObject({ reason: "link-only" });
    expect(by.zillow.listingUrl).toContain("/homedetails/");
    expect(by.zillow.dates.sold).toBe("2021-06-16");
    expect(body.address).toBe("123 Example St, Springfield, IL 62701");
  });

  test("second lookup comes out of the cache", async () => {
    const kv = new MemoryKV();
    const app = makeApp({ photo });
    await post(app, "123 Example St, Springfield, IL 62701", { CACHE: kv });
    const again = (await (
      await post(app, "123 EXAMPLE ST SPRINGFIELD IL 62701", { CACHE: kv })
    ).json()) as LookupResult;
    expect(again.cached).toBe(true);
    expect(again.sites.find((s) => s.site === "zillow")?.photoCount).toBe(9);
  });
});

describe("real addresses against the (pretend) real internet", () => {
  test("robots-disallowed searches come back blocked, not failed", async () => {
    const log: string[] = [];
    const app = makeApp({ fetch: fakeNet(log), gapMs: 0 });
    const body = (await (
      await post(app, "500 Nowhere Rd, Springfield, IL 62702", { CACHE: new MemoryKV() })
    ).json()) as LookupResult;
    const by = Object.fromEntries(body.sites.map((s) => [s.site, s]));
    expect(by.zillow).toMatchObject({ blocked: true, reason: "robots" });
    expect(by.redfin).toMatchObject({ blocked: true, reason: "robots" });
    expect(by.trulia).toMatchObject({ blocked: true, reason: "robots" });
    expect(by.realtor).toMatchObject({ blocked: true, reason: "bot-wall" });
    expect(by.homes).toMatchObject({ blocked: true, reason: "bot-wall" });
    // robots said no, so we never even asked for the page
    expect(log.some((u) => u.includes("zillow.com/homes/"))).toBe(false);
    expect(log.some((u) => u.includes("/stingray/"))).toBe(false);
    // and every blocked site still hands back a link people can open themselves
    for (const s of body.sites) expect(s.listingUrl).toMatch(/^https:\/\//);
  });

  test("pasted zillow link: robots ok, then the bot wall", async () => {
    const app = makeApp({ fetch: fakeNet(), gapMs: 0 });
    const url = "https://www.zillow.com/homedetails/500-Nowhere-Rd-Springfield-IL-62702/99999999_zpid/";
    const body = (await (await post(app, url, { CACHE: new MemoryKV() })).json()) as LookupResult;
    const z = body.sites.find((s) => s.site === "zillow")!;
    expect(z).toMatchObject({ blocked: true, reason: "bot-wall", listingUrl: url });
    expect(body.address).toBe("500 Nowhere Rd, Springfield, IL 62702");
  });

  test("pasted link that parses: photos come back", async () => {
    const fetch: FetchFn = async (url) =>
      new URL(url).pathname === "/robots.txt"
        ? new Response(robotsFile("www.redfin.com"))
        : new Response(page("redfin"));
    const app = makeApp({ fetch, gapMs: 0 });
    const body = (await (
      await post(app, "https://www.redfin.com/IL/Springfield/500-Nowhere-Rd-62702/home/99999999", {})
    ).json()) as LookupResult;
    expect(body.sites.find((s) => s.site === "redfin")).toMatchObject({ blocked: false, photoCount: 7 });
  });
});

describe("input", () => {
  test.each([
    ["", 400],
    ["just some words", 400],
    ["https://example.com/house", 400],
  ])("%j -> %i with a readable message", async (address, status) => {
    const res = await post(makeApp(), address, {});
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toMatch(/[a-z]/i);
  });
});

describe("/img", () => {
  test("serves fixture photos with cors", async () => {
    const app = makeApp({ photo });
    const res = await app.request(
      `/img?u=${encodeURIComponent("https://fixtures.unlisted.test/zillow/fp-kitchen-2-cc_ft_384.jpg")}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
  });

  test("refuses hosts we don't proxy", async () => {
    const res = await makeApp().request(`/img?u=${encodeURIComponent("https://evil.example/x.jpg")}`);
    expect(res.status).toBe(403);
  });

  test("checks robots before fetching an image", async () => {
    const fetch: FetchFn = async (url) =>
      new URL(url).pathname === "/robots.txt"
        ? new Response("User-agent: *\nDisallow: /")
        : new Response("img", { headers: { "content-type": "image/jpeg" } });
    const res = await makeApp({ fetch }).request(
      `/img?u=${encodeURIComponent("https://photos.zillowstatic.com/fp/a-p_e.jpg")}`,
    );
    expect(res.status).toBe(403);
  });
});
