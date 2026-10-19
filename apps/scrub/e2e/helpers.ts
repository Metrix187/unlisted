import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Page, type Request, expect } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
export const SCRUB = "http://localhost:4173";
export const FIXTURES = join(here, "..", "..", "..", "packages", "vision", "fixtures");
const CACHE = join(here, "..", "..", "..", "node_modules", ".cache", "unlisted-models");

// mediapipe models (~26mb) get downloaded once per machine and replayed from disk after that, so the
// suite doesn't hammer google's bucket. requests still show up in the network log, they're just answered
// locally. dinov2 (88mb) is left alone: pushing a body that big through route.fulfill takes the whole
// browser down
export async function cacheModels(ctx: BrowserContext) {
  mkdirSync(CACHE, { recursive: true });
  await ctx.route(/storage\.googleapis\.com\/mediapipe-models/, async (route) => {
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

const ALLOWED_HOSTS = [/^localhost:4173$/, /^storage\.googleapis\.com$/, /^huggingface\.co$/, /\.hf\.co$/];

type Seen = { url: string; method: string; body: number; image: boolean; host: string };

function looksLikeImage(b: Buffer) {
  if (b.length < 4) return false;
  const jpeg = b[0] === 0xff && b[1] === 0xd8;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const webp = b.subarray(8, 12).toString("ascii") === "WEBP";
  const b64 = /\/9j\/|iVBORw0KGgo/.test(b.toString("latin1"));
  return jpeg || png || webp || b64 || b.includes(Buffer.from([0xff, 0xd8, 0xff]));
}

export function watch(ctx: BrowserContext) {
  const seen: Seen[] = [];
  const record = (r: Request) => {
    const body = r.postDataBuffer() ?? Buffer.alloc(0);
    const u = new URL(r.url());
    if (u.protocol === "blob:" || u.protocol === "data:") return; // local, never leaves the tab
    seen.push({
      url: r.url(),
      method: r.method(),
      body: body.length,
      image: looksLikeImage(body),
      host: u.host,
    });
  };
  ctx.on("request", record);
  return seen;
}

export function assertClean(seen: Seen[]) {
  expect(seen.length).toBeGreaterThan(0);
  for (const s of seen) {
    expect(s.image, `image bytes in a request to ${s.url}`).toBe(false);
    expect(s.body, `${s.method} ${s.url} carried a ${s.body}-byte body`).toBe(0);
    expect(
      ALLOWED_HOSTS.some((re) => re.test(s.host)),
      `request to unexpected host ${s.host}`,
    ).toBe(true);
    expect(s.url.length, `suspiciously long url ${s.url.slice(0, 80)}…`).toBeLessThan(2048);
  }
}
