import { expect, test } from "@playwright/test";
import { SCRUB, cacheModels, pickFixture, scrubTo, waitForModelCache, waitForModels } from "./helpers";

test("works fully offline after the first visit", async ({ context, page }) => {
  await cacheModels(context);
  await page.goto(SCRUB);
  await waitForModels(page);
  await waitForModelCache(page);
  // wait until the service worker owns the page, otherwise there's nothing to serve us offline
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) =>
        navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }),
      );
    }
  });

  await context.unrouteAll({ behavior: "ignoreErrors" });
  await context.setOffline(true);
  await page.reload();
  await waitForModels(page);
  await pickFixture(page, "person-lounge.jpg");
  await scrubTo(page);
  await expect(page.getByTestId("after-caption")).toBeVisible();
});

test("is installable", async ({ context, page }) => {
  await cacheModels(context);
  await page.goto(SCRUB);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as {
    installabilityErrors: { errorId: string }[];
  };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);

  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href;
    return (await fetch(href)).json();
  });
  expect(manifest.share_target).toMatchObject({ method: "POST", enctype: "multipart/form-data" });
  expect(manifest.share_target.params.files[0].accept).toContain("image/*");
});

test("install prompt never shows before a scrub", async ({ context, page }) => {
  await cacheModels(context);
  await page.goto(SCRUB);
  await waitForModels(page);
  await expect(page.getByRole("button", { name: "Install" })).toHaveCount(0);
});
