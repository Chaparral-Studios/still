#!/usr/bin/env bash
# Scout for a Google search term that reliably triggers AR/video shopping
# previews in the no-extension baseline. Records ONLY the "none" variant
# (cuts run time in half) and stops as soon as meanMotion clears the
# threshold — that's our reproduction case.
#
# Required env: AV_INDEX, WINDOW_X, WINDOW_Y (see list-displays.sh).
# Optional env: SECONDS_RUN (default 25), MOTION_THRESHOLD (default 2.0).
#
# Usage:
#   AV_INDEX=3 WINDOW_X=-2540 WINDOW_Y=-220 ./tests/motion/scout.sh
#
# After a hit, run the full comparison:
#   AV_INDEX=3 WINDOW_X=-2540 WINDOW_Y=-220 \
#     MODE=flicker-scroll ./tests/motion/run.sh "<hit-url>" 25

set -euo pipefail

: "${AV_INDEX:?AV_INDEX required}"
: "${WINDOW_X:?WINDOW_X required}"
: "${WINDOW_Y:?WINDOW_Y required}"
SECONDS_RUN="${SECONDS_RUN:-25}"
THRESH="${MOTION_THRESHOLD:-2.0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COOKIES="$SCRIPT_DIR/cookies/google.com.json"
COOKIES_ARGS=()
[ -f "$COOKIES" ] && COOKIES_ARGS=(--cookies "$COOKIES")

STAMP="$(date +%Y%m%d_%H%M%S)"
SCOUT_DIR="$SCRIPT_DIR/reports/_scout_${STAMP}"
mkdir -p "$SCOUT_DIR"

# Search terms where AR / 3D / video product previews are most likely.
# Ordered by guess of likelihood-of-firing.
TERMS=(
  "nike+air+force+1"
  "iphone+15+pro"
  "ps5+console"
  "samsung+galaxy+s24"
  "macbook+pro+m3"
  "apple+watch"
  "ikea+sofa"
  "lego+technic"
  "tesla+model+3"
  "robot+vacuum"
  "kitchenaid+stand+mixer"
  "rolex+submariner"
  "adidas+ultraboost"
  "dyson+v15"
  "wireless+earbuds"
)

echo "scouting ${#TERMS[@]} terms, threshold meanMotion>${THRESH}, seconds=${SECONDS_RUN}"
echo "results in $SCOUT_DIR"
echo ""

HIT_URL=""
HIT_MOTION=""
for term in "${TERMS[@]}"; do
  url="https://www.google.com/search?q=$term"
  vdir="$SCOUT_DIR/$term"
  mkdir -p "$vdir"
  echo "=== $term ==="

  # Use system Chrome — Google's SERP composition (Shopping/AR carousels)
  # depends on the TLS fingerprint, and Playwright's bundled Chromium-for-
  # Testing gets a stripped layout (no Shopping carousel, no AR videos).
  npx tsx "$SCRIPT_DIR/capture-display.mts" \
    --url "$url" --out "$vdir" --seconds "$SECONDS_RUN" \
    --av-index "$AV_INDEX" --window-x "$WINDOW_X" --window-y "$WINDOW_Y" \
    --scroll-then-sit --system-chrome \
    ${COOKIES_ARGS[@]+"${COOKIES_ARGS[@]}"} \
    > "$vdir/capture.log" 2>&1 || { echo "  capture failed"; continue; }
  npx tsx "$SCRIPT_DIR/analyze.mts" --in "$vdir" > "$vdir/analyze.log" 2>&1 || true

  if [ -f "$vdir/summary.json" ]; then
    motion="$(jq -r '.meanMotion' "$vdir/summary.json")"
    echo "  meanMotion = $motion"
    # Bash float compare via awk — POSIX has no float ops natively.
    if awk -v m="$motion" -v t="$THRESH" 'BEGIN { exit (m+0 > t+0) ? 0 : 1 }'; then
      HIT_URL="$url"
      HIT_MOTION="$motion"
      echo ""
      echo "** HIT: motion>${THRESH} on '$term' **"
      echo "    url = $url"
      echo "    dir = $vdir"
      break
    fi
  else
    echo "  (no summary)"
  fi
done

echo ""
if [ -n "$HIT_URL" ]; then
  echo "Reproduction term found. To run the full comparison:"
  echo "  AV_INDEX=$AV_INDEX WINDOW_X=$WINDOW_X WINDOW_Y=$WINDOW_Y \\"
  echo "    MODE=flicker-scroll $SCRIPT_DIR/run.sh \"$HIT_URL\" $SECONDS_RUN"
else
  echo "No hit. All ${#TERMS[@]} terms had meanMotion<=${THRESH}."
  echo "Inspect frames in: $SCOUT_DIR/<term>/frames/"
fi
