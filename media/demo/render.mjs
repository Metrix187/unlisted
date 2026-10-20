// renders media/demo/index.html frame by frame and pipes it into ffmpeg.
//
//   node media/demo/render.mjs                         all three formats, 60 fps
//   node media/demo/render.mjs --format reel --fps 30
//   node media/demo/render.mjs --stills 2,9.5,19,31    pngs of those seconds instead, for eyeballing
//
// needs ffmpeg on PATH and edge (or pass --channel chromium). output lands in media/demo/out/
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const SIZES = { landscape: [1920, 1080], reel: [1080, 1920], feed: [1080, 1350] };
const formats = arg("format", "landscape,reel,feed").split(",");
const FPS = Number(arg("fps", "60"));
const stills = arg("stills", "").split(",").filter(Boolean).map(Number);
const channel = arg("channel", "msedge");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: channel === "chromium" ? undefined : channel });
try {
  for (const f of formats) {
    const [W, H] = SIZES[f];
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => console.error(`[${f}] page error:`, e.message));
    await page.goto(`${pathToFileURL(join(HERE, "index.html")).href}?format=${f}`);
    await page.evaluate(() => window.ready);
    const dur = await page.evaluate(() => window.DUR);
    const cdp = await page.context().newCDPSession(page);
    const grab = async () =>
      Buffer.from(
        (await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true })).data,
        "base64",
      );

    if (stills.length) {
      for (const t of stills) {
        await page.evaluate((t) => window.seek(t), t);
        writeFileSync(join(OUT, `still-${f}-${t}.png`), await grab());
      }
      console.log(`[${f}] ${stills.length} stills`);
      await page.close();
      continue;
    }

    const file = join(OUT, `unlisted-demo-${f}-${W}x${H}.mp4`);
    // png in, h.264 out. crf 16 + slow is overkill on purpose: instagram re-encodes, so give it a clean source
    const ff = spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        String(FPS),
        "-c:v",
        "png",
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "16",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-movflags",
        "+faststart",
        "-r",
        String(FPS),
        file,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    const done = new Promise((res, rej) =>
      ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))),
    );
    const n = Math.round(dur * FPS);
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      await page.evaluate((t) => window.seek(t), i / FPS);
      if (!ff.stdin.write(await grab())) await new Promise((r) => ff.stdin.once("drain", r));
      if (i % (FPS * 5) === 0)
        console.log(
          `[${f}] ${(i / FPS).toFixed(0)}s / ${dur}s  (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`,
        );
    }
    ff.stdin.end();
    await done;
    console.log(`[${f}] wrote ${file}`);
    await page.close();
  }
} finally {
  await browser.close();
}
