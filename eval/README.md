# eval

the attacker, so the defenses get numbers instead of adjectives.

## what it does

1. **index** (`fetch.py`): ~3,000 indoor photos from [Open Images](https://storage.googleapis.com/openimages/web/index.html)
   (validation + test splits, human-verified scene labels like bathroom / bedroom / kitchen / living room /
   interior design). Open Images lists them as CC BY 2.0, so they're fine to use and redistribute with
   credit; `data/manifest.csv` keeps author + source for every one. these play the "listing photos".
2. **queries** (`run.py`): 300 of the index photos that have people in them, re-shot: cropped to 55–85% of
   the area, tilted up to 4°, re-lit, re-colored, re-compressed. that's the stand-in for "a different photo
   of the same room".
3. **defenses** (`defend.mjs`): every query goes through the real scrub code (a `HARNESS=1` build of
   `apps/scrub`, driven by headless Edge with WebGPU): none, metadata strip, hot-spot blur, full background
   scrub, matching noise alone, and scrub + noise.
4. **attack**: embed the index and the defended queries with DINOv2-base, CLIP ViT-B/32, and DINOv2-small
   (the model the noise targets), FAISS inner-product search, top-1/5/20 hit rate.
5. writes `results/leaderboard.md` and `results/results.json`.

## running

```bash
uv sync                      # torch with cuda 12.4 on windows/linux
uv run python fetch.py
uv run python run.py         # --par 3 pages in parallel, --channel msedge by default
uv run python run.py --skip-defend   # just re-score what's already in work/defended
```

everything intermediate lives in `work/` (gitignored) and is reused on re-runs: re-shot queries,
defended images, index embeddings, and a browser profile that keeps the models cached.

## knobs worth knowing

- `--channel`: the browser playwright uses. Edge is the default because it's the one that gets a real GPU
  adapter headless on windows. on a machine without that, noise defenses get skipped (and say so in
  `work/defended/<defense>/_log.jsonl`).
- `fetch.py --index / --queries`: sizes. more index photos = more distractors = harder for the attacker.

## tools

`tools/dino_reference.py` dumps a pytorch DINOv2-small embedding for the fixture, used by the opt-in tfjs
parity test in `packages/vision/test/dino.test.ts`.
