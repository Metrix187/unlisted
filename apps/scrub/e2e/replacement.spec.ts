import { expect, test } from "@playwright/test";
import { SCRUB, cacheModels, pickFixture, scrubTo, waitForModels } from "./helpers";

test("a replacement that cannot open preserves the previous photo", async ({ context, page }) => {
  await cacheModels(context);
  await page.goto(SCRUB);
  await waitForModels(page);
  await pickFixture(page, "person-lounge.jpg");
  const original = await page.getByTestId("photo").locator("img").getAttribute("src");
  await page.getByTestId("file").setInputFiles({
    name: "broken.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("This is an invalid JPEG used for the replacement regression."),
  });
  await expect(page.getByRole("note")).toContainText("That photo didn't open");
  await expect(page.getByTestId("photo").locator("img")).toHaveAttribute("src", original!);
  const previewAvailable = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url!;
    try {
      await image.decode();
      return true;
    } catch {
      return false;
    }
  }, original);
  expect(previewAvailable).toBe(true);
  await scrubTo(page, { metaOnly: true });
  await expect(page.getByTestId("before-after")).toBeVisible();
  const previousOutput = await page.getByTestId("before-after").locator("img").first().getAttribute("src");
  await page.getByRole("button", { name: "Try different settings" }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await pickFixture(page, "kitchen.jpg");
  await expect(page.getByTestId("photo").locator("img")).not.toHaveAttribute("src", original!);
  const released = await page.evaluate(
    async (urls) => {
      return Promise.all(
        urls.map(async (url) => {
          const image = new Image();
          image.src = url!;
          try {
            await image.decode();
            return false;
          } catch {
            return true;
          }
        }),
      );
    },
    [original, previousOutput],
  );
  expect(released).toEqual([true, true]);
});
