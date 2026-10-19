"""grab the proxy index: indoor photos from open images (cc by 2.0, redistributable with credit).

writes eval/data/images/<id>.jpg (long side <= 768) and eval/data/manifest.csv with credits.
idempotent: already-downloaded images are skipped.

    uv run python fetch.py --index 3000 --queries 300
"""

from __future__ import annotations

import argparse
import csv
import io
import random
import sys
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image
from tqdm import tqdm

HERE = Path(__file__).parent
DATA = HERE / "data"
META = DATA / "meta"
IMAGES = DATA / "images"

BASE = "https://storage.googleapis.com/openimages"
FILES = {
    "val-labels": f"{BASE}/v7/oidv7-val-annotations-human-imagelabels.csv",
    "test-labels": f"{BASE}/v7/oidv7-test-annotations-human-imagelabels.csv",
    "val-meta": f"{BASE}/2018_04/validation/validation-images-with-rotation.csv",
    "test-meta": f"{BASE}/2018_04/test/test-images-with-rotation.csv",
}
S3 = {"val": "https://s3.amazonaws.com/open-images-dataset/validation/{}.jpg", "test": "https://s3.amazonaws.com/open-images-dataset/test/{}.jpg"}

# scene labels that mean "inside someone's home, or close enough"
ROOMS = {
    "/m/01j2bj": "bathroom",
    "/m/02_58j": "bedroom",
    "/m/03d2wd": "dining room",
    "/m/0d4wf": "kitchen",
    "/m/03f6tq": "living room",
    "/m/02rfdq": "interior design",
    "/m/06ht1": "room",
    "/m/02pv0pf": "nursery",
}
PEOPLE = {"/m/01g317", "/m/04yx4", "/m/03bt1vf", "/m/05r655", "/m/01bl7v"}


def download(url: str, dest: Path) -> None:
    if dest.exists():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {dest.name}", file=sys.stderr)
    urllib.request.urlretrieve(url, dest)


def load_candidates() -> list[dict]:
    rows: dict[str, dict] = {}
    for split in ("val", "test"):
        labels: dict[str, set[str]] = defaultdict(set)
        with open(META / Path(FILES[f"{split}-labels"]).name, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if float(r["Confidence"]) < 1:
                    continue
                if r["LabelName"] in ROOMS:
                    labels[r["ImageID"]].add(ROOMS[r["LabelName"]])
                elif r["LabelName"] in PEOPLE:
                    labels[r["ImageID"]].add("person")
        with open(META / Path(FILES[f"{split}-meta"]).name, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                tags = labels.get(r["ImageID"])
                if not tags or not (tags - {"person"}):
                    continue
                rows[r["ImageID"]] = {
                    "id": r["ImageID"],
                    "split": split,
                    "scenes": "|".join(sorted(tags - {"person"})),
                    "person": int("person" in tags),
                    "author": r["Author"],
                    "license": r["License"],
                    "source": r["OriginalLandingURL"],
                    "rotation": r.get("Rotation") or "0",
                }
    return sorted(rows.values(), key=lambda r: r["id"])


def fetch_one(row: dict) -> bool:
    dest = IMAGES / f"{row['id']}.jpg"
    if dest.exists():
        return True
    try:
        with urllib.request.urlopen(S3[row["split"]].format(row["id"]), timeout=30) as r:
            im = Image.open(io.BytesIO(r.read())).convert("RGB")
        rot = float(row["rotation"] or 0)
        if rot:
            im = im.rotate(-rot, expand=True)
        im.thumbnail((768, 768))
        if min(im.size) < 160:
            return False
        im.save(dest, quality=90)
        return True
    except Exception:
        return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", type=int, default=3000, help="how many photos in the attacker's index")
    ap.add_argument("--queries", type=int, default=300, help="how many of those get re-shot as queries")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    for name, url in FILES.items():
        download(url, META / Path(url).name)

    cands = load_candidates()
    rng = random.Random(args.seed)
    rng.shuffle(cands)
    people = [c for c in cands if c["person"]]
    print(f"{len(cands)} indoor candidates, {len(people)} with people", file=sys.stderr)

    # queries come from the with-people pile (that's the realistic "selfie in my room" case), and every
    # query's source photo is in the index. the rest of the index is distractors
    picked_q = people[: args.queries * 2]
    rest = [c for c in cands if c not in picked_q]
    picked = picked_q + rest[: max(0, args.index - len(picked_q))]

    IMAGES.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(16) as ex:
        ok = list(tqdm(ex.map(fetch_one, picked), total=len(picked), desc="images"))
    got = [r for r, k in zip(picked, ok) if k]
    queries = [r for r in got if r in picked_q][: args.queries]
    qids = {q["id"] for q in queries}

    with open(DATA / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["id", "role", "split", "scenes", "person", "author", "license", "source"])
        w.writeheader()
        for r in got[: args.index]:
            w.writerow({k: r[k] for k in w.fieldnames if k in r} | {"role": "query" if r["id"] in qids else "index"})
    print(f"index {min(len(got), args.index)} images, {len(queries)} queries -> {DATA / 'manifest.csv'}", file=sys.stderr)


if __name__ == "__main__":
    main()
