// applies scrub's defenses to every query photo by driving the real app code (apps/scrub/harness.html)
// in a headless browser. same worker, same models, same output encoding as the button people press.
//
//   node eval/defend.mjs --in eval/work/queries --out eval/work/defended --defenses metadata,hotspots,scrub,noise
//
// edge is the default channel because it's the one playwright browser that gets a real webgpu adapter
// headless on windows. without webgpu the noise defense gets skipped, same as in the app.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

const IN = resolve(arg("in", join(ROOT, "eval/work/queries")));
const OUT = resolve(arg("out", join(ROOT, "eval/work/defended")));
const DEFENSES = arg("defenses", "none,metadata,hotspots,scrub,noise,scrub+noise").split(",");
// "msedge" for real webgpu on windows, "none" for playwright's bundled headless chromium (cpu only)
const CHANNEL = arg("channel", "msedge");
const PAR = Number(arg("par", "3"));
const PORT = Number(arg("port", "4180"));
const LIMIT = Number(arg("limit", "0"));
// --slow lets noise run on the wasm backend when there's no webgpu (same as ?slow in the app). minutes per photo
const SLOW = process.argv.includes("--slow");

const OPTS = {
  metadata: { mode: "metadata" },
  hotspots: { mode: "hotspots" },
  scrub: { mode: "background", backdrop: "blur" },
  noise: { mode: "metadata", noise: true },
  "scrub+noise": { mode: "background", backdrop: "blur", noise: true },
};

async function waitFor(url, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

const files = readdirSync(IN)
  .filter((f) => f.endsWith(".jpg"))
  .sort()
  .slice(0, LIMIT || undefined);

const jobs = [];
for (const d of DEFENSES) {
  mkdirSync(join(OUT, d), { recursive: true });
  for (const f of files) {
    const dest = join(OUT, d, f);
    if (existsSync(dest)) continue;
    if (d === "none") copyFileSync(join(IN, f), dest);
    else jobs.push({ d, f, dest });
  }
}
console.log(`${files.length} photos x ${DEFENSES.length} defenses, ${jobs.length} to do`);
if (!jobs.length) process.exit(0);

if (!existsSync(join(ROOT, "apps/scrub/dist-harness/harness.html"))) {
  console.error("build the harness first: HARNESS=1 pnpm --filter @unlisted/scrub build");
  process.exit(1);
}
const base = `http://localhost:${PORT}`;
// an orphaned preview from an earlier run (or another checkout) on this port means strictPort quietly
// fails and we'd be measuring whatever code *that* one serves. ask me how i know
const busy = await fetch(base).then(
  (r) => (r.body?.cancel(), true),
  () => false,
);
if (busy) {
  console.error(`something is already listening on :${PORT}. kill it or pass --port`);
  process.exit(1);
}
const server = spawn("pnpm", ["--filter", "@unlisted/scrub", "exec", "vite", "preview", "--outDir", "dist-harness", "--port", String(PORT), "--strictPort"], {
  cwd: ROOT,
  shell: true,
  stdio: "ignore",
});

try {
  await waitFor(`${base}/harness.html`);
  // persistent profile so the models stay in the Cache API between runs
  const ctx = await chromium.launchPersistentContext(join(ROOT, `eval/work/browser-profile-${CHANNEL}`), {
    channel: CHANNEL === "none" ? undefined : CHANNEL,
    headless: true,
    // the cpu run keeps chrome off the gpu entirely (swiftshader for the bits that want gl)
    args: CHANNEL === "none" ? ["--disable-gpu"] : ["--enable-unsafe-webgpu"],
  });
  const pages = await Promise.all(
    Array.from({ length: PAR }, async () => {
      const p = await ctx.newPage();
      await p.goto(`${base}/harness.html`);
      await p.waitForFunction(() => window.harness);
      await p.evaluate(() => window.harness.ready());
      return p;
    }),
  );
  const gpu = await pages[0].evaluate(async () => !!(await navigator.gpu?.requestAdapter()));
  console.log(`webgpu: ${gpu ? "yes" : "NO (noise defenses will be skipped)"}`);

  let done = 0;
  const t0 = Date.now();
  const worker = async (page) => {
    while (jobs.length) {
      const { d, f, dest } = jobs.shift();
      const b64 = readFileSync(join(IN, f)).toString("base64");
      try {
        const r = await page.evaluate(([img, opts]) => window.harness.run(img, opts), [b64, { ...OPTS[d], slow: SLOW }]);
        writeFileSync(dest, Buffer.from(r.image, "base64"));
        appendFileSync(join(OUT, d, "_log.jsonl"), `${JSON.stringify({ f, ms: r.ms, score: r.score, person: r.hasPerson, noise: r.noise })}\n`);
      } catch (e) {
        appendFileSync(join(OUT, d, "_log.jsonl"), `${JSON.stringify({ f, error: String(e).slice(0, 300) })}\n`);
      }
      done++;
      if (done % 25 === 0 || SLOW) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`${done} done, ${jobs.length} left, ${rate.toFixed(2)}/s`);
      }
    }
  };
  await Promise.all(pages.map(worker));
  await ctx.close();
} finally {
  // taskkill /t first: killing the cmd.exe wrapper on its own leaves vite running with no parent, and then
  // there's no tree left for /t to walk. that's how the orphans got there in the first place
  if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
  else server.kill();
}
