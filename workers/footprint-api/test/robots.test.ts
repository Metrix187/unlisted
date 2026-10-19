import { describe, expect, test } from "vitest";
import { looksWalled } from "../src/http";
import { isAllowed, parseRobots, robotsFromResponse } from "../src/robots";
import { page, robotsFile } from "./helpers";

const lines = (...l: string[]) => l.join("\n");

describe("robots parser", () => {
  test("longest match wins, allow wins ties", () => {
    const r = parseRobots(
      lines("User-agent: *", "Disallow: /homes/", "Allow: /homes/for_sale/$", "Disallow: /a", "Allow: /a"),
    );
    expect(isAllowed(r, "https://x.com/homes/123_rb/")).toBe(false);
    expect(isAllowed(r, "https://x.com/homes/for_sale/")).toBe(true);
    expect(isAllowed(r, "https://x.com/homes/for_sale/extra")).toBe(false);
    expect(isAllowed(r, "https://x.com/a")).toBe(true);
    expect(isAllowed(r, "https://x.com/other")).toBe(true);
  });

  test("a group naming us beats the * group", () => {
    const r = parseRobots(lines("User-agent: *", "Disallow: /", "", "User-agent: Unlisted", "Allow: /"));
    expect(isAllowed(r, "https://x.com/anything")).toBe(true);
  });

  test("wildcards", () => {
    const r = parseRobots(lines("User-agent: *", "Disallow: /*?searchQueryState=*", "Disallow: /*.pdf$"));
    expect(isAllowed(r, "https://x.com/foo?searchQueryState=1")).toBe(false);
    expect(isAllowed(r, "https://x.com/a/b.pdf")).toBe(false);
    expect(isAllowed(r, "https://x.com/a/b.pdf?x")).toBe(true);
  });

  test("4xx means no rules, 5xx means hands off", () => {
    expect(isAllowed(robotsFromResponse(404, ""), "https://x.com/a")).toBe(true);
    expect(isAllowed(robotsFromResponse(503, ""), "https://x.com/a")).toBe(false);
  });
});

describe("real robots.txt snapshots", () => {
  test("zillow: no address search, detail pages ok", () => {
    const z = parseRobots(robotsFile("www.zillow.com"));
    expect(isAllowed(z, "https://www.zillow.com/homes/123-example-st-springfield-il-62701_rb/")).toBe(false);
    expect(
      isAllowed(z, "https://www.zillow.com/homedetails/123-Example-St-Springfield-IL-62701/1_zpid/"),
    ).toBe(true);
  });
  test("redfin: stingray is off limits, listing pages aren't", () => {
    const r = parseRobots(robotsFile("www.redfin.com"));
    expect(isAllowed(r, "https://www.redfin.com/stingray/do/location-autocomplete?location=x")).toBe(false);
    expect(isAllowed(r, "https://www.redfin.com/IL/Springfield/123-Example-St-62701/home/1")).toBe(true);
  });
  test("realtor: address-only detail urls are fine", () => {
    const r = parseRobots(robotsFile("www.realtor.com"));
    expect(
      isAllowed(r, "https://www.realtor.com/realestateandhomes-detail/123-Example-St_Springfield_IL_62701"),
    ).toBe(true);
  });
  test("trulia: search is out", () => {
    const t = parseRobots(robotsFile("www.trulia.com"));
    expect(isAllowed(t, "https://www.trulia.com/json/search/location/?query=x")).toBe(false);
  });
});

test("bot walls get recognized", () => {
  expect(looksWalled(200, page("perimeterx"))).toBe(true);
  expect(looksWalled(403, page("akamai-denied"))).toBe(true);
  expect(looksWalled(429, "")).toBe(true);
  expect(looksWalled(200, page("zillow"))).toBe(false);
});
