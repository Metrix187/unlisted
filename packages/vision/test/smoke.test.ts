import { expect, test } from "vitest";
import { VISION_VERSION } from "../src/index";

test("package loads", () => {
  expect(VISION_VERSION).toBe("0.1.0");
});
