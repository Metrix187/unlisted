import { devices, test } from "@playwright/test";
import { SCRUB, cacheModels, pickFixture, scrubTo, waitForModels } from "./helpers";

// mediapipe guesses whether OffscreenCanvas exists from the user agent. an iphone UA without "Version/17+"
// (ios 16 safari, and chrome/firefox/edge on iphone, which say CriOS/FxiOS) sent it to
// document.createElement inside our worker, and the photo never opened. the sniff is the bug, not the
// engine, so chromium wearing an iphone UA is enough to catch it coming back
const UAS = {
  "chrome on iphone":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  "safari on ios 16":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
};
// drop defaultBrowserType or the whole describe quietly switches to webkit
const { defaultBrowserType: _, ...iphone } = devices["iPhone 14"];

for (const [name, userAgent] of Object.entries(UAS)) {
  test.describe(name, () => {
    test.use({ ...iphone, userAgent });

    test("a photo opens and scrubs", async ({ context, page }) => {
      await cacheModels(context);
      await page.goto(SCRUB);
      await waitForModels(page);
      await pickFixture(page, "person-living.jpg");
      await scrubTo(page);
    });
  });
}
