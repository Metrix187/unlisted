import { describe, expect, test } from "vitest";
import type { SiteResult } from "../api";
import { GUIDES, renderGuide } from "./removal";

const site = (over: Partial<SiteResult>): SiteResult => ({
  site: "zillow",
  name: "Zillow",
  listingUrl: "https://www.zillow.com/homedetails/123-Example-St-Springfield-IL-62701/1_zpid/",
  searchUrl: "https://www.zillow.com/homes/123-example-st-springfield-il-62701_rb/",
  photoCount: 9,
  photos: [],
  dates: {},
  blocked: false,
  ...over,
});

describe("removal guides", () => {
  test("there's a guide for every site", () => {
    expect(Object.keys(GUIDES).sort()).toEqual(
      ["apartments", "homes", "realtor", "redfin", "streetview", "trulia", "zillow"].sort(),
    );
  });

  test("placeholders get filled, emails get pulled out", () => {
    const { html, emails } = renderGuide(site({}), "123 Example St, Springfield, IL 62701");
    expect(html).not.toContain("{{");
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain(">the listing<");
    expect(emails).toHaveLength(1);
    expect(emails[0]).toContain("123 Example St, Springfield, IL 62701");
    expect(emails[0]).toContain("/homedetails/");
  });

  test("blocked sites link to a search instead", () => {
    const s = site({ blocked: true, reason: "robots", listingUrl: "https://www.zillow.com/homes/x_rb/" });
    expect(renderGuide(s, "x").html).toContain(">search for your home<");
  });

  test("street view has steps but no email", () => {
    const { html, emails } = renderGuide(site({ site: "streetview", name: "Google Street View" }), "x");
    expect(html).toContain("Report a problem");
    expect(emails).toHaveLength(0);
  });
});
