# unlisted

**Reduce the background clues in photos you share from home.**

Unlisted explores one specific risk: a photo's visible room details may be matched to rental or
real-estate listing photos associated with an address. Scrub reduces those details; Footprint helps
you check listing sites manually and find removal guidance. Neither tool can tell you that you are safe.
We have not tested these defenses against Raven, GeoSpy, or other proprietary systems.

- **Scrub** (`apps/scrub`) — pick a photo, see what in the room would give it away, tap once to blur the
  room out from behind you, share. runs entirely in your browser. the photo never leaves your device.
- **Footprint** (`apps/footprint` + `workers/footprint-api`) — manual search links and per-site removal
  guides. Automated lookups are largely blocked. Addresses are sent to a Cloudflare Worker for lookup;
  the code avoids storing the address, but Cloudflare handles the request. This part is not on-device.
  The made-up demo address uses fixtures, not live listing results.

both are installable PWAs. there are no accounts, no settings, and no analytics.

Scrub processes photo pixels locally after model downloads (~26 MB initially; ~88 MB extra for
experimental matching noise). Its heat map and score are heuristics, not calibrated security assessments.
Review the subject edges and result before sharing. See [limitations](docs/LIMITATIONS.md).

**try them:** [unlisted-scrub.pages.dev](https://unlisted-scrub.pages.dev) ·
[unlisted-footprint.pages.dev](https://unlisted-footprint.pages.dev) (the demo address shows what a
lookup looks like without using yours).

**source and feedback:** [repository](https://github.com/Metrix187/unlisted) ·
[report a reproducible issue](https://github.com/Metrix187/unlisted/issues).
Please include your browser/version and safe reproduction steps. Do not post home addresses,
private photos, or other people's personal information in public issues.

## what it can't do

the short version, the long one is in [docs/LIMITATIONS.md](docs/LIMITATIONS.md):

- **we can't tell you whether Raven (or anyone) already has you.** checking that would mean building
  Raven: scraping every listing site into a giant photo index. that's the thing we're defending against,
  so we didn't.
- scrub blurs the room, not you. whatever's in the sharp part of the photo (you, what you're wearing,
  anything you're holding, a bit of window behind your shoulder) still goes out.
- footprint mostly can't look for you. the listing sites block automated lookups, we respect that, so for
  most sites it hands you a link and the takedown steps instead of a photo grid. the demo address shows what
  it looks like when a site does answer.
- the matching noise is still an experiment. on its own it only dents the number. stacked on a scrub it
  helps a lot against DINOv2-style matchers and less against CLIP (see the numbers below). it's aimed at
  one model family, and needs WebGPU.

## is this real?

the defenses are measured, not vibes. `eval/` builds a retrieval attacker (DINOv2-base and CLIP ViT-B/32
over a FAISS index of 3,000 indoor photos) and runs every defense through the actual Scrub code in a
headless browser. full table: **[eval/results/leaderboard.md](eval/results/leaderboard.md)**.

top-1 hit rate (how often the attacker's first guess is the right room), 300 queries, 3,000-photo index:

| | DINOv2-base | CLIP B/32 |
|---|---|---|
| no defense | 100% | 99.3% |
| strip metadata only | 100% | 99.3% |
| blur the hot spots | 98.3% | 88.3% |
| **scrub background** (the big button) | **55.7%** | **38.7%** |
| ↳ when it found a person to keep (245 of 300) | 66.5% | 47.3% |
| matching noise only | 91.3% | 95.7% |
| scrub background + matching noise | 14.7% | 24.0% |
| ↳ when it found a person to keep (245 of 300) | 18.0% | 29.4% |

what that says, plainly:

- **the scrub is the only thing that really moves the number, and it doesn't make you safe.** with you in
  the photo and the room blurred behind you, a strong off-the-shelf model still finds the room two times in
  three. it's much better than nothing. it is not invisibility.
- **metadata stripping does nothing against this kind of matching.** zero points.
- **hot-spot blur barely helps.** keeping the room keeps most of what a matcher needs.
- **matching noise alone is a dent, not a defense.** it's trained against the resize-and-crop a matcher
  does, so it survives that now, but DINOv2-base still finds the room 91% of the time and CLIP 96%. on top
  of a scrub it's a different story against DINOv2-base (55.7% → 14.7%), and a smaller one against CLIP
  (38.7% → 24.0%). that gap is the honest bit: the noise is aimed at DINOv2-small, base is its bigger
  sibling, CLIP is a different family. an attacker on some other model gets less of the benefit.
- and this test is *easier* for the attacker than real life in one way (the query is a re-shot copy of the
  indexed photo) and harder in another (real indexes are millions of photos, ours is 3,000). see
  [LIMITATIONS](docs/LIMITATIONS.md#the-eval).

## running it

needs node 22+, pnpm, and (for the eval) [uv](https://docs.astral.sh/uv/).

```bash
pnpm install
pnpm dev
```

that starts three things:

| what | where |
|---|---|
| scrub | http://localhost:5173 |
| footprint | http://localhost:5174 |
| footprint api (`wrangler dev`, local kv) | http://localhost:8787 |

in footprint, try the made-up demo address **123 Example St, Springfield, IL 62701**. it answers from
fixtures instead of the internet, so you see the full grid. any other address goes to the real sites.

scrub downloads its models on first load (~26 MB, ~88 MB more the first time you turn on matching noise)
and keeps them in the browser, so after that it works with no connection.

### tests

```bash
pnpm lint
pnpm typecheck
pnpm test        # unit tests: vision, the worker, footprint
pnpm e2e         # playwright, against production builds with the real CSP + service workers
```

the e2e suite includes the privacy checks: a test that watches every network request during real scrubs
and fails on anything carrying image bytes, an EXIF/GPS strip test, and (in `pnpm test`) a test that greps
everything the worker could have kept for any piece of an address.

the matching-noise e2e needs a real GPU, so it's opt-in: `E2E_NOISE=1 pnpm e2e` (uses Edge, which is the
browser that gets a real WebGPU adapter headless).

### the eval

```bash
cd eval
uv sync
uv run python fetch.py      # ~3,000 photos from Open Images, CC BY 2.0
uv run python run.py        # re-shoots, defends, attacks, writes results/leaderboard.md
```

it builds a special harness build of scrub (`HARNESS=1`) and drives it with headless Edge, so the photos
go through exactly what ships. takes ~45 minutes on a laptop GPU. `eval/README.md` has the details.

## deploying

cloudflare pages for the two apps, workers + kv for the api.

```bash
./deploy.sh          # dry run: checks, builds, wrangler --dry-run. touches nothing remote
./deploy.sh --yes    # actually deploys (needs `wrangler login`)
```

it creates the kv namespace if it doesn't exist, deploys the worker with `ALLOWED_ORIGINS` set to the
footprint pages domain, builds footprint against the worker's url, and pushes both apps.

## adding a site to footprint

1. **`workers/footprint-api/src/sites/<site>.ts`**: export a `Site` (see `sites/common.ts`). you need
   `searchUrl` (a link a person can open), `parse(html)` (photos + dates out of a listing page), and
   optionally `lookupUrl` / `findListing` if the site has a search page robots.txt lets us read.
   `common.ts` has helpers for json-ld, `__NEXT_DATA__`, cdn-url grabbing and collapsing size variants.
2. add it to `SITES` in `sites/index.ts`. if its photo cdn allows crawling, add the host to `PROXY_HOSTS`.
3. **a fixture**: a synthetic page in `fixtures/pages/<site>.html` shaped like the real one (made-up
   address, photos pointing at `https://fixtures.unlisted.test/...`), wire it into `src/fixtures.ts`, and
   run `pnpm --filter @unlisted/footprint-api gen:fixtures`. if the site has a robots.txt, save a snapshot
   in `fixtures/robots/<host>.txt`.
4. **a parse test** in `test/sites.test.ts`.
5. **a removal guide**: `docs/REMOVAL/<site>.md`. footprint renders it as-is; `{{address}}`,
   `{{listingUrl}}` and `{{listingLink}}` get filled in, and a fenced ` ```email ` block becomes a
   copy-able message. edit these freely, no code involved.

## layout

```
apps/scrub            the photo scrubber (vite + preact pwa)
apps/footprint        the listing-photo finder (vite + preact pwa)
workers/footprint-api cloudflare worker (hono): /lookup, /img, per-site fetchers + fixtures
packages/vision       segmentation, heat map, exposure score, scrub, dinov2 + fgsm, all in a web worker
packages/ui           shared tokens and the handful of components both apps use
eval/                 the retrieval attacker + leaderboard (python, uv)
docs/                 DECISIONS, LIMITATIONS, and the per-site removal guides
```

## license

[WTFPUP](LICENSE), do what you want. fixture and eval photos are from Open Images under CC BY 2.0, credits
in `packages/vision/fixtures/ATTRIBUTION.md`, `workers/footprint-api/fixtures/photos/ATTRIBUTION.md`, and
`eval/data/manifest.csv` (generated by `fetch.py`).
