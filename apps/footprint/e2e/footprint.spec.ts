import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const FOOTPRINT = "http://localhost:4174";
const DEMO = "123 Example St, Springfield, IL 62701";

async function find(page: Page, address = DEMO) {
  await page.goto(FOOTPRINT);
  await page.getByTestId("address").fill(address);
  await page.getByTestId("find").click();
  await expect(page.getByTestId("headline")).toBeVisible();
}

test("demo address: the grid, the count, and who blocked us", async ({ page }) => {
  await find(page, "123 example street springfield illinois 62701");
  await expect(page.getByTestId("headline")).toHaveText(
    "We found 28 photos of your home on 4 sites. 22 are interior.",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("tile")).toHaveCount(28);
  for (const site of ["zillow", "redfin", "realtor", "trulia"])
    await expect(page.getByTestId(`site-${site}`)).toBeVisible();
  await expect(page.getByText("Homes.com blocked us — open it yourself:")).toBeVisible();
  await expect(page.getByText("Apartments.com blocked us — open it yourself:")).toBeVisible();
});

test("take-down cards, and 'mark as requested' sticks without storing the address", async ({ page }) => {
  await find(page);
  await page.getByTestId("takedown").click();
  for (const s of ["zillow", "redfin", "realtor", "trulia", "homes", "apartments", "streetview"])
    await expect(page.getByTestId(`card-${s}`)).toBeVisible();
  await expect(page.getByTestId("card-zillow")).toContainText("9 photos, 7 of the inside");
  await expect(page.getByTestId("card-zillow")).toContainText("Owner View");
  await expect(page.getByTestId("card-zillow").locator("pre")).toContainText(
    "123 Example St, Springfield, IL 62701",
  );

  await page.getByTestId("req-zillow").check();
  await page.reload();
  await find(page);
  await page.getByTestId("takedown").click();
  await expect(page.getByTestId("req-zillow")).toBeChecked();
  await expect(page.getByTestId("req-redfin")).not.toBeChecked();

  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).toContain("footprint:req:");
  expect(stored.toLowerCase()).not.toContain("example");
  expect(stored).not.toContain("62701");
});

test("bad input gets a readable error", async ({ page }) => {
  await page.goto(FOOTPRINT);
  await page.getByTestId("address").fill("somewhere nice");
  await page.getByTestId("find").click();
  await expect(page.getByRole("note")).toContainText("Couldn't read that address");
});

test("photo search never sends the photo anywhere", async ({ context, page }) => {
  const bodies: string[] = [];
  page.on("request", (r) => {
    const b = r.postDataBuffer();
    if (b?.length) bodies.push(r.url());
  });
  // keep the test off the real search engines
  await context.route(/lens\.google|bing\.com|tineye|yandex/, (r) => r.fulfill({ body: "ok" }));
  await page.goto(FOOTPRINT);
  await page.getByTestId("photo-mode").click();
  await expect(page.getByTestId("photo-privacy")).toBeVisible();
  await page
    .getByTestId("photo-file")
    .setInputFiles(
      join(import.meta.dirname, "..", "..", "..", "packages", "vision", "fixtures", "kitchen.jpg"),
    );
  const popup = page.waitForEvent("popup");
  await page.getByTestId("engine-tineye").click();
  await (await popup).close();
  expect(bodies).toEqual([]);
});

test("is installable", async ({ context, page }) => {
  await page.goto(FOOTPRINT);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as {
    installabilityErrors: { errorId: string }[];
  };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);
});
