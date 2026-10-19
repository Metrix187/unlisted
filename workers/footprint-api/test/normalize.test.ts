import { describe, expect, test } from "vitest";
import {
  AddressError,
  addressFromListingUrl,
  canonical,
  display,
  normalize,
  parseAddress,
  sha256,
} from "../src/normalize";

// every address in here is made up. "springfield" because every state has one

describe("parseAddress", () => {
  test("the long, polite version", () => {
    expect(parseAddress("123 North Main Street, Apartment 4B, Springfield, Illinois 62701-1234")).toEqual({
      number: "123",
      predir: "n",
      street: "main",
      suffix: "st",
      postdir: undefined,
      unit: "4b",
      city: "springfield",
      state: "il",
      zip: "62701",
    });
  });

  test.each([
    ["123 North Main Street, Apt. 4B, Springfield, Illinois 62701-1234"],
    ["123 n main st #4b, springfield, il 62701"],
    ["123 N. MAIN ST. UNIT 4B, SPRINGFIELD IL 62701"],
    ["123 n main st apt 4b springfield il 62701"],
    ["  123   north  main   st , #4B , Springfield ,  IL  62701 "],
  ])("%s -> one canonical form", (input) => {
    expect(normalize(input).canonical).toBe("123 n main st unit 4b, springfield, il 62701");
  });

  test("suffixes get usps-abbreviated", () => {
    expect(canonical(parseAddress("9 Elm Boulevard, Shelbyville, TN 37160"))).toBe(
      "9 elm blvd, shelbyville, tn 37160",
    );
    expect(canonical(parseAddress("9 Oak Terrace, Shelbyville, TN"))).toBe("9 oak ter, shelbyville, tn");
    expect(canonical(parseAddress("9 Maple Parkway, Shelbyville, TN"))).toBe("9 maple pkwy, shelbyville, tn");
  });

  test("post-directionals", () => {
    const a = parseAddress("500 Lake Shore Dr West, Springfield, MO 65801");
    expect(a).toMatchObject({ street: "lake shore", suffix: "dr", postdir: "w" });
  });

  test("ordinal words become numbers", () => {
    expect(canonical(parseAddress("77 First Avenue, Springfield, OR 97477"))).toBe(
      "77 1st ave, springfield, or 97477",
    );
  });

  test("two-word states and saint/st cities line up", () => {
    expect(normalize("1 Main St, Saint Paul, North Carolina").canonical).toBe(
      normalize("1 main st, st paul, nc").canonical,
    );
  });

  test("street names that look like suffixes stay put", () => {
    const a = parseAddress("42 Park Ave, Springfield, MA 01103");
    expect(a).toMatchObject({ street: "park", suffix: "ave" });
  });

  test("bad input fails loudly, not weirdly", () => {
    expect(() => parseAddress("")).toThrow(AddressError);
    expect(() => parseAddress("Main St, Springfield, IL")).toThrow(/house number/);
    expect(() => parseAddress("123 Main St, Springfield")).toThrow(/state/);
  });

  test("display is human-friendly", () => {
    expect(display(parseAddress("123 n main st #4b springfield il 62701"))).toBe(
      "123 N Main St #4B, Springfield, IL 62701",
    );
  });
});

describe("addressFromListingUrl", () => {
  test.each([
    ["https://www.zillow.com/homedetails/123-Example-St-Springfield-IL-62701/00000001_zpid/"],
    ["https://www.redfin.com/IL/Springfield/123-Example-St-62701/home/00000001"],
    ["https://www.realtor.com/realestateandhomes-detail/123-Example-St_Springfield_IL_62701_M00000-00001"],
    ["https://www.trulia.com/home/123-example-st-springfield-il-62701--00000001"],
  ])("%s", (url) => {
    const addr = addressFromListingUrl(url);
    expect(addr).toBeTruthy();
    expect(normalize(addr!).canonical).toBe("123 example st, springfield, il 62701");
  });

  test("random urls are ignored", () => {
    expect(addressFromListingUrl("https://example.com/whatever")).toBeUndefined();
    expect(addressFromListingUrl("not a url")).toBeUndefined();
  });
});

test("sha256 is the boring hex digest", async () => {
  expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
