import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Page, expect } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
export const SCRUB = "http://localhost:4173";
export const FIXTURES = join(here, "..", "..", "..", "packages", "vision", "fixtures");
const CACHE = join(here, "..", "..", "..", "node_modules", ".cache", "unlisted-models");

// model weights are ~110mb all in. download each once per machine and replay from disk after that, so
// the suite doesn't hammer google's bucket. requests still show up in the network log, they're just
// answered locally
export async function cacheModels(ctx: BrowserContext) {
  mkdirSync(CACHE, { recursive: true });
  await ctx.route(/storage\.googleapis\.com\/mediapipe-models|huggingface\.co\/facebook/, async (route) => {
    const url = route.request().url();
    const file = join(CACHE, createHash("sha1").update(url).digest("hex"));
    if (!existsSync(file)) {
      const res = await route.fetch();
      if (!res.ok()) return route.fulfill({ response: res });
      writeFileSync(file, await res.body());
    }
    await route.fulfill({
      status: 200,
      body: readFileSync(file),
      headers: { "content-type": "application/octet-stream", "access-control-allow-origin": "*" },
    });
  });
}

export async function waitForModels(page: Page) {
  await expect(page.getByText("Getting the on-device models ready")).toHaveCount(0, { timeout: 90_000 });
  await expect(page.getByTestId("drop")).toBeEnabled();
}

// the worker caches models with the Cache API as they land. going offline before all three are in there
// is a test bug, not an app bug
export async function waitForModelCache(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const c = await caches.open("unlisted-models-v1");
          return (await c.keys()).length;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

export async function pickFixture(page: Page, name: string) {
  await page.getByTestId("file").setInputFiles(join(FIXTURES, name));
  await expect(page.getByTestId("caption")).toBeVisible({ timeout: 60_000 });
}

export async function scrubTo(page: Page, opts: { metaOnly?: boolean; hotspots?: boolean } = {}) {
  await page.getByTestId("next").click();
  if (opts.metaOnly) await page.getByTestId("t-meta").check();
  if (opts.hotspots) await page.getByTestId("t-hotspots").check();
  await page.getByTestId("scrub").click();
  await expect(page.getByTestId("before-after")).toBeVisible({ timeout: 90_000 });
}

export async function saveOutput(page: Page): Promise<Buffer> {
  const dl = page.waitForEvent("download");
  await page.getByTestId("save").click();
  const d = await dl;
  const path = await d.path();
  return readFileSync(path);
}
