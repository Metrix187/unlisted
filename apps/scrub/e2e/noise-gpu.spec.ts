import { expect, test } from "@playwright/test";
import { SCRUB, assertClean, cacheModels, pickFixture, waitForModels, watch } from "./helpers";

// needs edge (the only playwright channel that gets a real webgpu adapter headless) and a gpu, so it's
// opt-in: E2E_NOISE=1 pnpm e2e
test.skip(!process.env.E2E_NOISE, "set E2E_NOISE=1 on a machine with a gpu and edge installed");
test.use({ channel: "msedge" });

test("matching noise stays local too", async ({ context, page }) => {
  test.setTimeout(10 * 60_000);
  await cacheModels(context);
  const seen = watch(context);
  await page.goto(SCRUB);
  await waitForModels(page);
  await pickFixture(page, "bedroom.jpg");
  await page.getByTestId("next").click();
  await page.getByTestId("t-noise").check();
  await page.getByTestId("scrub").click();
  await expect(page.getByTestId("before-after")).toBeVisible({ timeout: 9 * 60_000 });
  await expect(page.getByTestId("noise-line")).toContainText("DINOv2-small embedding cosine similarity");
  assertClean(seen);
  // the model came from hugging face, and that's the only reason we talked to it
  expect(seen.some((s) => s.host === "huggingface.co")).toBe(true);
});
