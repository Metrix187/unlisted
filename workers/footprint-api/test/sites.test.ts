import { describe, expect, test } from "vitest";
import { normalize } from "../src/normalize";
import { SITES, siteForUrl } from "../src/sites";
import { apartments } from "../src/sites/apartments";
import { homes } from "../src/sites/homes";
import { realtor, realtorSlug } from "../src/sites/realtor";
import { redfin } from "../src/sites/redfin";
import { trulia } from "../src/sites/trulia";
import { zillow, zillowKey, zillowSize } from "../src/sites/zillow";
import { page } from "./helpers";

const addr = normalize("123 Example St, Springfield, IL 62701");

describe("zillow", () => {
  const r = zillow.parse(page("zillow"), "");
  test("pulls every photo out of gdpClientCache, one per picture", () => {
    expect(r.photos).toHaveLength(9);
    expect(r.photos[0].url).toMatch(/cc_ft_960\.jpg$/);
    expect(r.photos[0].thumb).toMatch(/cc_ft_384\.jpg$/);
  });
  test("dates + history", () => {
    expect(r.dates.listed).toBe("2024-03-02");
    expect(r.dates.sold).toBe("2021-06-16");
    expect(r.dates.history?.map((h) => h.event)).toContain("Sold");
  });
  test("size variants collapse", () => {
    const a = "https://photos.zillowstatic.com/fp/abc123-cc_ft_960.jpg";
    const b = "https://photos.zillowstatic.com/fp/abc123-p_e.jpg";
    expect(zillowKey(a)).toBe(zillowKey(b));
    expect(zillowSize(a)).toBeGreaterThan(zillowSize(b));
  });
  test("falls back to cdn urls when the json moves", () => {
    const html = [
      '<img src="https://photos.zillowstatic.com/fp/aaa111-cc_ft_960.jpg">',
      '<img src="https://photos.zillowstatic.com/fp/aaa111-p_e.jpg">',
      '<img src="https://photos.zillowstatic.com/fp/bbb222-p_e.jpg">',
    ].join("");
    expect(zillow.parse(html, "").photos).toHaveLength(2);
  });
  test("search url is the _rb form", () => {
    expect(zillow.searchUrl(addr.address, addr.display)).toBe(
      "https://www.zillow.com/homes/123-example-st-springfield-il-62701_rb/",
    );
  });
});

describe("redfin", () => {
  const r = redfin.parse(page("redfin"), "");
  test("json-ld + react state, deduped by photo id", () => {
    expect(r.photos).toHaveLength(7);
    expect(r.photos[0].url).toContain("/bigphoto/");
  });
  test("datePosted from json-ld", () => {
    expect(r.dates.listed).toBe("2021-04-29");
  });
});

describe("realtor", () => {
  const r = realtor.parse(page("realtor"), "");
  test("photos from redux state", () => {
    expect(r.photos).toHaveLength(6);
  });
  test("dates", () => {
    expect(r.dates).toMatchObject({ listed: "2021-04-30", sold: "2021-06-16" });
  });
  test("slug matches their url scheme", () => {
    expect(realtorSlug(addr.address)).toBe("123-Example-St_Springfield_IL_62701");
  });
});

describe("trulia", () => {
  const r = trulia.parse(page("trulia"), "");
  test("photos from homeDetails.media", () => {
    expect(r.photos).toHaveLength(6);
    expect(r.dates.sold).toBe("2021-06-16");
  });
});

describe("homes + apartments", () => {
  test("parse cdn urls when we do get a page", () => {
    const h = [
      '<script type="application/ld+json">{"@type":"SingleFamilyResidence","image":["https://images.homes.com/listings/102/1111111111-222222222.jpg?t=p"]}</script>',
      '<img src="https://images.homes.com/listings/102/1111111111-222222222.jpg?t=m">',
      '<img src="https://images.homes.com/listings/102/3333333333-444444444.jpg?t=p">',
    ].join("");
    const r = homes.parse(h, "");
    expect(r.photos).toHaveLength(2);
    expect(r.photos[0].thumb).toMatch(/\?t=m$/);
    const a = [
      '<img src="https://images1.apartments.com/i2/AbC-dEf/111/image.jpg">',
      '<img src="https://images1.apartments.com/i2/AbC-dEf/540/image.jpg">',
      '<img src="https://images1.apartments.com/i2/XyZ/540/image.jpg">',
    ].join("");
    expect(apartments.parse(a, "").photos).toHaveLength(2);
  });
});

test("siteForUrl knows every listing host and nothing else", () => {
  expect(siteForUrl("https://www.zillow.com/homedetails/x/1_zpid/")?.id).toBe("zillow");
  expect(siteForUrl("https://redfin.com/IL/x/y/home/1")?.id).toBe("redfin");
  expect(siteForUrl("https://evil-zillow.com/")).toBeUndefined();
  expect(SITES.map((s) => s.id)).toEqual([
    "zillow",
    "redfin",
    "realtor",
    "trulia",
    "homes",
    "apartments",
    "streetview",
  ]);
});
