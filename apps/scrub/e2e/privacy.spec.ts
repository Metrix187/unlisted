import { expect, test } from "@playwright/test";
import { inspectMetadata } from "../../../packages/vision/src/exif";
import {
  SCRUB,
  assertClean,
  cacheModels,
  pickFixture,
  saveOutput,
  scrubTo,
  waitForModels,
  watch,
} from "./helpers";

// the whole privacy promise in one place: during a scrub, nothing that looks like your photo leaves the
// browser. we watch every request the page, its web worker, and the service worker make

test("no request carries image bytes during a scrub", async ({ context, page }) => {
  await cacheModels(context);
  const seen = watch(context);
  await page.goto(SCRUB);
  await waitForModels(page);
  await pickFixture(page, "person-lounge.jpg");
  await scrubTo(page);
  await expect(page.getByTestId("after-caption")).toBeVisible();
  await page.getByTestId("again").click();
  await pickFixture(page, "kitchen.jpg");
  await scrubTo(page, { hotspots: true });
  assertClean(seen);
});

test("no webgpu: matching noise gets skipped, says why, and never fetches the model", async ({
  context,
  page,
}) => {
  // the default headless shell has no gpu adapter, which is exactly the case we want here
  await cacheModels(context);
  const seen = watch(context);
  await page.goto(SCRUB);
  await waitForModels(page);
  await pickFixture(page, "bedroom.jpg");
  await page.getByTestId("next").click();
  await page.getByTestId("t-noise").check();
  await page.getByTestId("scrub").click();
  await expect(page.getByTestId("before-after")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("note").filter({ hasText: "Matching noise skipped" })).toContainText("WebGPU");
  assertClean(seen);
  expect(seen.some((s) => s.host === "huggingface.co")).toBe(false);
});

test("the csp says the same thing the test does", async ({ page }) => {
  const res = await page.goto(SCRUB);
  const csp = res!.headers()["content-security-policy"];
  expect(csp).toContain(
    "connect-src 'self' https://storage.googleapis.com https://huggingface.co https://*.hf.co",
  );
  expect(csp).not.toMatch(/connect-src[^;]*\*(?!\.hf\.co)/);
});

test("metadata gets stripped, and the warning shows up", async ({ context, page }) => {
  await cacheModels(context);
  await page.goto(SCRUB);
  await waitForModels(page);
  await pickFixture(page, "bathroom-exif.jpg");
  await page.getByTestId("next").click();
  await page.getByTestId("t-meta").check();
  await expect(
    page.getByText("This alone won't stop photo-matching tools. They don't use metadata."),
  ).toBeVisible();
  await page.getByTestId("scrub").click();
  await expect(page.getByTestId("before-after")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("meta-line")).toContainText("They're gone from this one");
  const out = await saveOutput(page);
  const meta = inspectMetadata(out);
  expect(meta.format).toBe("jpeg");
  expect(meta).toMatchObject({ exif: false, gps: false, xmp: false, iptc: false });
});

test("a full scrub's output has no exif either", async ({ context, page }) => {
  await cacheModels(context);
  await page.goto(SCRUB);
  await waitForModels(page);
  await pickFixture(page, "bathroom-exif.jpg");
  await scrubTo(page);
  expect(inspectMetadata(await saveOutput(page))).toMatchObject({ exif: false, gps: false });
});
