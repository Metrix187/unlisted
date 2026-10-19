#!/usr/bin/env bash
# ships both apps to cloudflare pages and the api to workers.
#
#   ./deploy.sh          dry run: checks, builds, `wrangler deploy --dry-run`. touches nothing remote
#   ./deploy.sh --yes    the real thing
#
# needs `wrangler login` (or CLOUDFLARE_API_TOKEN) for --yes. project names can be overridden:
#   PAGES_SCRUB=my-scrub PAGES_FOOTPRINT=my-footprint ./deploy.sh --yes
set -euo pipefail

YES=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    -h | --help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $a" >&2
      exit 2
      ;;
  esac
done

cd "$(dirname "$0")"
PAGES_SCRUB=${PAGES_SCRUB:-unlisted-scrub}
PAGES_FOOTPRINT=${PAGES_FOOTPRINT:-unlisted-footprint}
KV_TITLE=${KV_TITLE:-unlisted-footprint-cache}
wr() { pnpm --filter @unlisted/footprint-api exec wrangler "$@"; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "checks"
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test

FOOTPRINT_ORIGIN="https://${PAGES_FOOTPRINT}.pages.dev"

if [ "$YES" = 0 ]; then
  say "dry run (pass --yes to actually deploy)"
  wr deploy --dry-run --outdir .wrangler/dry-run
  pnpm --filter @unlisted/scrub build
  VITE_API_URL="https://unlisted-footprint-api.example.workers.dev" pnpm --filter @unlisted/footprint build
  echo
  echo "would deploy:"
  echo "  worker  unlisted-footprint-api (kv: $KV_TITLE, ALLOWED_ORIGINS=$FOOTPRINT_ORIGIN)"
  echo "  pages   $PAGES_SCRUB      <- apps/scrub/dist"
  echo "  pages   $PAGES_FOOTPRINT  <- apps/footprint/dist"
  exit 0
fi

say "kv namespace"
KV_ID=$(wr kv namespace list 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const list = JSON.parse(s.slice(s.indexOf("[")));
    const hit = list.find((n) => n.title === process.argv[1]);
    if (hit) process.stdout.write(hit.id);
  });' "$KV_TITLE" || true)
if [ -z "$KV_ID" ]; then
  KV_ID=$(wr kv namespace create "$KV_TITLE" 2>&1 | grep -oE '[0-9a-f]{32}' | head -1)
fi
[ -n "$KV_ID" ] || { echo "couldn't find or create the kv namespace" >&2; exit 1; }
echo "kv: $KV_ID"

say "worker"
# same config with the real kv id swapped in. the committed one keeps its placeholder
sed "s/^id = \"0\{32\}\"/id = \"$KV_ID\"/" workers/footprint-api/wrangler.toml >workers/footprint-api/wrangler.deploy.toml
trap 'rm -f workers/footprint-api/wrangler.deploy.toml' EXIT
OUT=$(wr deploy -c wrangler.deploy.toml --var "ALLOWED_ORIGINS:$FOOTPRINT_ORIGIN" 2>&1 | tee /dev/stderr)
API_URL=$(printf '%s' "$OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -n "$API_URL" ] || { echo "couldn't read the worker url out of wrangler's output" >&2; exit 1; }
echo "api: $API_URL"

say "apps"
pnpm --filter @unlisted/scrub build
VITE_API_URL="$API_URL" pnpm --filter @unlisted/footprint build

for p in "$PAGES_SCRUB" "$PAGES_FOOTPRINT"; do
  wr pages project create "$p" --production-branch main >/dev/null 2>&1 || true
done
wr pages deploy ../../apps/scrub/dist --project-name "$PAGES_SCRUB" --branch main --commit-dirty=true
wr pages deploy ../../apps/footprint/dist --project-name "$PAGES_FOOTPRINT" --branch main --commit-dirty=true

say "done"
echo "scrub:     https://${PAGES_SCRUB}.pages.dev"
echo "footprint: $FOOTPRINT_ORIGIN"
echo "api:       $API_URL"
