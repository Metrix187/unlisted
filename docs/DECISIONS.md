# decisions

calls that got made along the way, mostly where the plan met reality. newest stuff is at the bottom of
each section.

## repo + tooling

- **repo root is this folder** (`D:\scrub` on sky's box), pushed as `unlisted` on github. the layout in the
  brief had `unlisted/` as the root; same thing, different folder name.
- **node 24 locally, node 22 in ci.** `engines` says `>=22`, nothing uses 24-only features.
- **biome instead of eslint + prettier.** one dependency, fast, does both. a few of its a11y rules are off
  where they misfire on things like a `<canvas aria-hidden>`.
- **wrangler's kv id in `wrangler.toml` is a placeholder.** it only has to be real for deploys, and
  `deploy.sh` creates the namespace and swaps the id in on the fly.

## scrub / vision

- **matching noise uses a hand-ported dinov2-small in tfjs, not transformers.js.** transformers.js runs
  onnxruntime-web, which can only go forward. fgsm needs the gradient of the embedding with respect to the
  pixels, so i ported the model (patch embed, 12 blocks, layer scale, the bicubic position-grid resize) to
  tfjs ops and load the same `facebook/dinov2-small` safetensors from hugging face. parity test against
  pytorch: cosine 1.0000 on the fixture. pinned to commit `ed25f3a3`.
- **the attack:** iterative fgsm (sign steps, i.e. pgd-lite) on the cls embedding, maximizing cosine
  distance from the original. ε = 4/255, 10 steps, α = 1/255. the perturbation lives on a 112×112 grid and
  gets bilinearly upsampled, because smooth noise survives the attacker's own resize/crop better than
  per-pixel speckle. whole frame squashed to 224×224 (no center crop) so the edges get covered too.
- **the attack starts from a random point in the ε-ball**, not from zero. at δ = 0 the image is as similar
  to itself as it can get, so the gradient there is exactly zero. webgpu's float fuzz happened to nudge it
  off that spot; the wasm backend computes it exactly and the "noise" came out as a no-op (similarity
  0.99999994). caught by the eval, fixed with a uniform random start, verified on both backends.
- **noise needs webgpu by default.** on the wasm backend it was ~27 s per step, so ~4.5 minutes per photo.
  that's not something to spring on someone, so without webgpu the step gets skipped and the done screen
  says why. `?slow` in the url forces the wasm path for anyone who wants to wait.
- **mediapipe runs in a module worker via a small shim.** its loader wants `importScripts()`, which module
  workers don't have. the vite plugin in `packages/vision/vite-plugin.ts` serves an esm copy of the loader
  (with one strict-mode fix: it declares a function inside an `if`), and the worker hands mediapipe the
  factory with an empty loader path so it skips the import step. the alternative was a classic worker,
  which vite can't do with imports in dev.
- **models are cached by the worker with the Cache API**, not by the service worker. that keeps the sw
  simple and works the same in dev and prod. the sw precaches the app shell and both wasm runtimes.
- **people get segmented twice.** the selfie multiclass model (as specced) is great at close-ups and bad at
  a person across a room. so efficientdet also looks for people/pets, and each one gets a cropped deeplab v3
  pass that's pasted back into the mask. deeplab also covers cats and dogs properly. adds 2.7 mb of model.
- **detection runs tiled** (full frame + 2×2 overlapping tiles). efficientdet-lite0 squeezes everything to
  320 px and small people just disappear. a containment-based nms merges the tiles back.
- **no art detector.** coco has no "painting" class. art mostly shows up through the gabor pattern map
  (framed prints are high-texture), plus clocks/vases/books as "decor". the weights from the brief are
  there (`WEIGHTS` in `heat.ts`), the art weight just rarely fires on its own.
- **the gabor map looks for patterns, not edges**: geometric mean of orthogonal orientation responses, so a
  single edge cancels and a grid (tile, wallpaper, rugs) lights up.
- **"plain backdrop" is a two-way switch under the big button**, not a fourth toggle. the brief asked for
  exactly three toggles and also a clean-backdrop option; this kept both.
- **lighthouse dropped its pwa category in v12**, so "lighthouse pwa installable" gets checked two ways:
  the e2e suite asks chrome directly (`Page.getInstallabilityErrors` over cdp, the same check lighthouse
  used, empty list = installable) for both apps on every ci run, and lighthouse 11.7.1 (the last version
  with the category) scored both apps 1.0 on pwa on 2026-10-19. to re-run that one by hand, with both
  previews up: `npx lighthouse@11.7.1 http://localhost:4173 --only-categories=pwa --chrome-flags=--headless=new`.
- **the csp lives in three places:** a meta tag, cloudflare pages' `_headers`, and the vite preview server
  (so e2e tests run against the real headers). it's header-delivered csp that actually binds the web
  worker, the meta tag alone wouldn't.
- **output is always jpeg at q 0.92**, capped at 2560 px on the long side. that's what makes metadata
  stripping a given (canvas re-encode) and keeps the full-res blur affordable.

## footprint

- **we identify as `Unlisted/0.1 (+repo url)` and obey robots.txt, and that means live lookups mostly come
  back blocked.** as of october 2026:
  - zillow: `Disallow: /homes/` for everyone, which is their address search. detail pages are allowed but
    perimeterx answers a non-browser with a captcha.
  - redfin: `/stingray/` (their search api) is disallowed. detail pages allowed, but 403 for us.
  - trulia: `/search` and `/json/search` disallowed, perimeterx on everything else.
  - realtor.com: address-only detail urls are allowed by robots, then it answers 429.
  - homes.com + apartments.com: akamai 403s us before we can even read robots.txt.

  we don't spoof a browser user agent or route through proxies to get around any of that. so the honest
  live result is "here's a link, go look yourself", and the ui is built around showing that clearly.
  everything works end to end against the fixtures, and against a live site the moment it lets us in.
- **the "live" test case is the live code path hitting the real sites and getting blocked**, which is what
  the definition of done can actually mean right now. `curl -X POST localhost:8787/lookup` with any real
  address shows it.
- **pasted listing urls are supported** and skip the search step (the address is read back out of the url
  slug so the other sites still get deep links).
- **the kv cache never stores listing urls.** they have the street address baked into the slug. on a cache
  hit, links fall back to search links rebuilt from the request.
- **search deep links go to duckduckgo** (`"address" site:redfin.com`) where a site has no linkable search
  url. the person opens that themselves.
- **the image proxy only fetches from cdns whose robots.txt allows it.** zillow's photo cdn has no
  robots.txt; redfin's and realtor's say `Disallow: /` to `*`. so zillow photos go through the worker (the
  cdn sees us, not you, and the page can read pixels for the inside/outside badge), the rest load as plain
  `<img>`s with `referrerpolicy=no-referrer`, and may show up without a badge.
- **"mark as requested" keys localStorage on a hash of the address**, so the address isn't sitting in
  localStorage in plain text either.
- **the headline counts photos per site, no cross-site dedupe.** trulia mostly mirrors zillow's photos; each
  copy is a separate thing to get taken down, so they're counted separately.
- **fixture mode:** the made-up "123 Example St, Springfield, IL 62701" always answers from synthetic pages
  shaped like each site's real markup, with real robots.txt snapshots, so the robots logic still runs.
  homes.com and apartments.com play the bot wall.
- **photo search (mode 2) can't prebuild reverse-image urls for a local photo.** every engine's by-url
  search needs the image at a public url, and putting it at one means uploading it, which we won't. so we
  copy it to the clipboard and open each engine's upload page. listing photos that are already public could
  use by-url search; not wired into the grid yet.
- **rate limiting is per worker isolate** (a minimum gap per host). good enough for politeness at our
  scale; a durable object would be the next step if traffic ever made it matter.

## eval

- **open images instead of ade20k.** ade20k's terms are research-only; open images is cc by 2.0, so it's
  redistributable with credit. we use the human-verified indoor scene labels from the validation and test
  splits (bathroom, bedroom, kitchen, living room, dining room, interior design, room, nursery).
- **queries are re-shot copies of index photos** (crop 55–85% of the area, ±4° tilt, light/color jitter,
  jpeg q 75–90). real multi-view datasets of homes (scannet, matterport, structured3d) aren't
  redistributable. this makes the attacker's job easier than real life, which is the conservative direction
  for judging defenses.
- **queries are photos with people in them**, since "a photo of me at home" is the case scrub is for.
- **headless edge, not chromium,** drives the harness, because it's the only playwright channel that gets a
  real webgpu adapter headless on windows. chromium's headless gets swiftshader.
- **noise defenses run one page at a time.** three headless pages each holding dinov2 on an 8 gb laptop gpu
  wedged the gpu driver hard enough that `nvidia-smi` hung (it recovered on its own). one page does ~3 s
  per photo, which is fine.
- **dinov2-small is in the attacker list on purpose:** it's the model the noise targets, so it shows the
  noise's best case next to the two models it wasn't aimed at.

## process

- the scrub three-screen commit shows up twice in history: the second one is lint fixes that got committed
  with the same message after a chained command didn't stop on a lint failure. left it rather than force-push.
