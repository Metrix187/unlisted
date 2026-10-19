"""the attacker. builds a retrieval index out of "listing photos", re-shoots some of them as the photo a
person might share, runs scrub's defenses over those (via the real app code, see defend.mjs), and checks
how often off-the-shelf retrieval still finds the right room.

    uv run python fetch.py                 # once, grabs the photos
    uv run python run.py                   # everything else, writes results/leaderboard.md

stages are cached under eval/work/, so re-running only redoes what changed.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import random
import subprocess
import sys
from datetime import date
from pathlib import Path

import faiss
import numpy as np
import torch
from PIL import Image, ImageEnhance
from tqdm import tqdm
from transformers import AutoImageProcessor, AutoModel, CLIPModel, CLIPProcessor

HERE = Path(__file__).parent
ROOT = HERE.parent
DATA = HERE / "data"
WORK = HERE / "work"
RESULTS = HERE / "results"

DEFENSES = ["none", "metadata", "hotspots", "scrub", "noise", "scrub+noise"]
LABELS = {
    "none": "no defense",
    "metadata": "strip metadata only",
    "hotspots": "blur the hot spots",
    "scrub": "scrub background (default)",
    "noise": "matching noise only",
    "scrub+noise": "scrub background + matching noise",
}
KS = (1, 5, 20)

ATTACKERS = {
    "dinov2-base": ("facebook/dinov2-base", "dino"),
    "clip-b32": ("openai/clip-vit-base-patch32", "clip"),
    # the model matching noise is aimed at. white-box, so it's the best case for noise, not a fair fight
    "dinov2-small": ("facebook/dinov2-small", "dino"),
}


def tq(it, **kw):
    return tqdm(it, mininterval=5, ncols=80, **kw)


def manifest() -> list[dict]:
    with open(DATA / "manifest.csv", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def reshoot(src: Path, dest: Path, rng: random.Random) -> None:
    """stand-in for 'a different photo of the same room': crop in, tilt a little, shift the light,
    recompress. it's kinder to the attacker than real life (same moment, same furniture placement),
    which means anything that beats it here should beat it out there too."""
    im = Image.open(src).convert("RGB")
    w, h = im.size
    area = rng.uniform(0.55, 0.85)
    ar = rng.uniform(0.85, 1.18)
    cw = min(w, int(round((area * w * h * ar) ** 0.5)))
    ch = min(h, int(round((area * w * h / ar) ** 0.5)))
    x = rng.randint(0, w - cw)
    y = rng.randint(0, h - ch)
    im = im.crop((x, y, x + cw, y + ch)).rotate(rng.uniform(-4, 4), resample=Image.BICUBIC, expand=False)
    im = ImageEnhance.Brightness(im).enhance(rng.uniform(0.88, 1.12))
    im = ImageEnhance.Contrast(im).enhance(rng.uniform(0.9, 1.1))
    im = ImageEnhance.Color(im).enhance(rng.uniform(0.85, 1.15))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=rng.randint(75, 90))
    dest.write_bytes(buf.getvalue())


def stage_queries(rows: list[dict], seed: int) -> list[str]:
    out = WORK / "queries"
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    ids = [r["id"] for r in rows if r["role"] == "query"]
    for i in ids:
        dest = out / f"{i}.jpg"
        if not dest.exists():
            reshoot(DATA / "images" / f"{i}.jpg", dest, rng)
    return ids


def stage_defend(defenses: list[str], par: int, channel: str) -> None:
    harness = ROOT / "apps/scrub/dist-harness/harness.html"
    if not harness.exists():
        print("building the scrub harness…", file=sys.stderr)
        subprocess.run("pnpm --filter @unlisted/scrub build", shell=True, cwd=ROOT, check=True, env={**__import__("os").environ, "HARNESS": "1"})
    cmd = f'node eval/defend.mjs --in eval/work/queries --out eval/work/defended --defenses {",".join(defenses)} --par {par} --channel {channel}'
    subprocess.run(cmd, shell=True, cwd=ROOT, check=True)


class Embedder:
    def __init__(self, name: str, kind: str, device: str):
        self.kind = kind
        self.device = device
        if kind == "clip":
            self.model = CLIPModel.from_pretrained(name).to(device).eval()
            self.proc = CLIPProcessor.from_pretrained(name)
        else:
            self.model = AutoModel.from_pretrained(name).to(device).eval()
            self.proc = AutoImageProcessor.from_pretrained(name)

    @torch.no_grad()
    def __call__(self, paths: list[Path], bs: int = 64) -> np.ndarray:
        out = []
        for i in tq(range(0, len(paths), bs), desc="embed", leave=False):
            ims = [Image.open(p).convert("RGB") for p in paths[i : i + bs]]
            px = self.proc(images=ims, return_tensors="pt")["pixel_values"].to(self.device)
            if self.kind == "clip":
                e = self.model.get_image_features(pixel_values=px)
                # transformers 5 hands back an output object with the projected embedding in pooler_output
                if not torch.is_tensor(e):
                    e = e.pooler_output
            else:
                e = self.model(pixel_values=px).pooler_output
            out.append(torch.nn.functional.normalize(e, dim=-1).float().cpu().numpy())
        return np.concatenate(out)


def stage_score(rows: list[dict], qids: list[str], defenses: list[str], attackers: list[str]) -> dict:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    index_ids = [r["id"] for r in rows]
    pos = {i: n for n, i in enumerate(index_ids)}
    results: dict = {}
    for a in attackers:
        name, kind = ATTACKERS[a]
        emb = Embedder(name, kind, device)
        cache = WORK / "emb" / f"{a}-index.npy"
        cache.parent.mkdir(parents=True, exist_ok=True)
        if cache.exists() and np.load(cache).shape[0] == len(index_ids):
            X = np.load(cache)
        else:
            print(f"[{a}] embedding the index ({len(index_ids)})", file=sys.stderr)
            X = emb([DATA / "images" / f"{i}.jpg" for i in index_ids])
            np.save(cache, X)
        index = faiss.IndexFlatIP(X.shape[1])
        index.add(X)
        results[a] = {}
        for d in defenses:
            folder = WORK / "defended" / d
            have = [q for q in qids if (folder / f"{q}.jpg").exists()]
            if not have:
                continue
            Q = emb([folder / f"{q}.jpg" for q in have])
            _, I = index.search(Q, max(KS))
            truth = np.array([pos[q] for q in have])
            hits = {f"top{k}": float((I[:, :k] == truth[:, None]).any(1).mean()) for k in KS}
            top1 = {q: bool(I[n, 0] == truth[n]) for n, q in enumerate(have)}
            results[a][d] = {"n": len(have), **hits, "top1_by_query": top1}
            print(f"[{a}] {d:12s} " + "  ".join(f"top{k} {hits[f'top{k}']:.3f}" for k in KS), file=sys.stderr)
        del emb
        torch.cuda.empty_cache()
    return results


def noise_stats(defense: str) -> dict | None:
    log = WORK / "defended" / defense / "_log.jsonl"
    if not log.exists():
        return None
    applied, skipped, sims, ms = 0, 0, [], []
    for line in log.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        n = r.get("noise")
        if not n:
            continue
        if n.get("applied"):
            applied += 1
            sims.append(n["similarityAfter"])
            ms.append(r["ms"])
        else:
            skipped += 1
    if not applied and not skipped:
        return None
    return {
        "applied": applied,
        "skipped": skipped,
        "mean_self_similarity": float(np.mean(sims)) if sims else None,
        "median_ms": float(np.median(ms)) if ms else None,
    }


def person_found(defense: str) -> dict[str, bool]:
    log = WORK / "defended" / defense / "_log.jsonl"
    if not log.exists():
        return {}
    out = {}
    for line in log.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        if "person" in r:
            out[r["f"].removesuffix(".jpg")] = bool(r["person"])
    return out


def pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def leaderboard(results: dict, n_index: int, n_queries: int, defenses: list[str]) -> str:
    attackers = list(results)
    head = ["defense", *[f"{a} top-{k}" for a in attackers for k in KS]]
    lines = [
        "# is this real? (the leaderboard)",
        "",
        f"_generated by `eval/run.py` on {date.today().isoformat()}. don't hand-edit, re-run it._",
        "",
        f"attacker's index: **{n_index}** indoor photos from Open Images (CC BY 2.0). "
        f"queries: **{n_queries}** of those, re-shot (cropped, tilted, re-lit, re-compressed) to stand in for "
        "\"a different photo of the same room\", then run through each defense using the actual Scrub code "
        "in a headless browser. a hit means the attacker's top-k results contain the right room.",
        "",
        "lower is better for you.",
        "",
        "| " + " | ".join(head) + " |",
        "|" + "---|" * len(head),
    ]
    for d in defenses:
        cells = [LABELS[d]]
        for a in attackers:
            r = results[a].get(d)
            for k in KS:
                cells.append(pct(r[f"top{k}"]) if r else "–")
        lines.append("| " + " | ".join(cells) + " |")

    lines += ["", "## change vs. no defense (top-1)", "", "| defense | " + " | ".join(attackers) + " |", "|---|" + "---|" * len(attackers)]
    for d in defenses:
        if d == "none":
            continue
        cells = [LABELS[d]]
        for a in attackers:
            base, r = results[a].get("none"), results[a].get(d)
            cells.append(f"{100 * (r['top1'] - base['top1']):+.1f} pts" if base and r else "–")
        lines.append("| " + " | ".join(cells) + " |")

    # scrub blurs everything when it can't find a person, which is a different (and easier) defense than
    # "keep the person, lose the room". split it out so the headline number doesn't hide that
    split_rows = []
    for d in ("scrub", "scrub+noise"):
        found = person_found(d)
        if not found or d not in results[attackers[0]]:
            continue
        for label, want in (("person found, room blurred", True), ("no person found, whole photo blurred", False)):
            ids = [q for q, v in found.items() if v == want]
            cells = [f"{LABELS[d]}: {label} (n={len(ids)})"]
            for a in attackers:
                t1 = results[a][d].get("top1_by_query", {})
                hit = [t1[q] for q in ids if q in t1]
                cells.append(pct(sum(hit) / len(hit)) if hit else "–")
            split_rows.append("| " + " | ".join(cells) + " |")
    if split_rows:
        lines += [
            "",
            "## scrub, split by whether it found a person (top-1)",
            "",
            "| | " + " | ".join(attackers) + " |",
            "|---|" + "---|" * len(attackers),
            *split_rows,
        ]

    for d in ("noise", "scrub+noise"):
        s = noise_stats(d)
        if s:
            lines += [
                "",
                f"**{LABELS[d]}:** applied to {s['applied']} photos, skipped on {s['skipped']}. "
                + (f"mean dinov2-small self-similarity after noise: {s['mean_self_similarity']:.3f} (1.0 = untouched). " if s["mean_self_similarity"] is not None else "")
                + (f"median time per photo incl. analysis: {s['median_ms'] / 1000:.1f}s on webgpu." if s["median_ms"] else ""),
            ]
    lines += [
        "",
        "## how to read this",
        "",
        "- `dinov2-base` and `clip-b32` are the honest attackers: off-the-shelf models we didn't aim anything at.",
        "- `dinov2-small` is the exact model matching noise attacks, so its row is the noise's best case, not a "
        "fair test. compare it to the other two to see how well the noise transfers, and to the noise's own "
        "self-similarity number to see how much of it survives the attacker's resize + center crop.",
        "- this setup is *easier* for the attacker than real life (the query is a re-shot copy of the indexed "
        "photo, not a different photo taken months later). see `docs/LIMITATIONS.md`.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--defenses", default=",".join(DEFENSES))
    ap.add_argument("--attackers", default=",".join(ATTACKERS))
    ap.add_argument("--par", type=int, default=3)
    ap.add_argument("--channel", default="msedge")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--skip-defend", action="store_true")
    args = ap.parse_args()
    defenses = args.defenses.split(",")

    rows = manifest()
    qids = stage_queries(rows, args.seed)
    if not args.skip_defend:
        stage_defend(defenses, args.par, args.channel)
    results = stage_score(rows, qids, defenses, args.attackers.split(","))

    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "results.json").write_text(json.dumps({"index": len(rows), "queries": len(qids), "results": results, "noise": {d: noise_stats(d) for d in ("noise", "scrub+noise")}}, indent=2))
    (RESULTS / "leaderboard.md").write_text(leaderboard(results, len(rows), len(qids), defenses), encoding="utf-8")
    print(f"wrote {RESULTS / 'leaderboard.md'}", file=sys.stderr)


if __name__ == "__main__":
    main()
