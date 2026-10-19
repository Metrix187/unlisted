import { expect, test } from "vitest";
import app from "../src/index";

test("health", async () => {
  const res = await app.request("/health");
  expect(await res.json()).toEqual({ ok: true });
});
