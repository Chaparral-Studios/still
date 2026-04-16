#!/usr/bin/env bash
# Motion comparison harness.
#
# Default: compare current working tree's extension against `main`'s extension.
# Records both headlessly, frame-diffs the videos, emits a report.
#
# Usage:
#   ./run.sh <url> [seconds]                # compare HEAD vs main
#   MODE=single ./run.sh <url>              # just current tree
#   MODE=baseline ./run.sh <url>            # add a "no extension" run
#   MODE=sit ./run.sh <url> [seconds]       # no scrolling: isolates ambient motion
#   MODE=sit-sweep ./run.sh <url>           # sit at 5/15/60s: catches slow cycles
#   MODE=scroll-sit ./run.sh <url> [sec]    # scroll through 4 positions, then sit:
#                                           # catches in-view/lazy-load animations
#   MODE=sit-png ./run.sh <url> [sec]       # lossless PNG capture, sit mode:
#                                           # catches sub-encoder-floor signal
#                                           # (subpixel AA jitter, slow hue drift)
#   REF=<git-ref> ./run.sh <url>            # compare against a specific ref
#
# SIT mode produces the purest "is this page animating?" signal — scrolling
# otherwise dominates the score. Try different seconds values to catch
# animations on different timescales (5s for fast loops, 30s for slow crossfades).
#
# Site cookies (for bypassing bot walls / auth): place a Playwright cookie
# JSON at tests/motion/cookies/<hostname>.json — it will be auto-loaded when
# the URL's hostname matches. Use decrypt-chrome-cookies.mts to generate one.

set -euo pipefail

URL="${1:?usage: run.sh <url> [seconds]}"
SECONDS_RUN="${2:-20}"
MODE="${MODE:-compare}"
REF="${REF:-main}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Hash the repo root so multiple clones or users on one machine don't collide.
REPO_HASH="$(echo -n "$REPO_ROOT" | shasum | cut -c1-8)"
REF_WT="${TMPDIR:-/tmp}/still-motion-ref-wt-${REPO_HASH}"

# Auto-pick cookies by hostname.
HOST="$(echo "$URL" | sed -E 's#https?://##; s#/.*##' | sed 's/^www\.//')"
COOKIES_FILE="$SCRIPT_DIR/cookies/${HOST}.json"
COOKIES_ARGS=()
if [ -f "$COOKIES_FILE" ]; then
  COOKIES_ARGS=(--cookies "$COOKIES_FILE")
  echo ">> using cookies: $COOKIES_FILE"
fi

SLUG="$(echo "$URL" | sed -E 's#https?://##; s#[/?&=:#]+#_#g' | cut -c1-80)"
STAMP="$(date +%Y%m%d_%H%M%S)"
RUN_DIR="$SCRIPT_DIR/reports/${SLUG}_${STAMP}"
mkdir -p "$RUN_DIR"

# run_variant <name> [extra args passed through to record.mts]
run_variant () {
  local name="$1"; shift
  local vdir="$RUN_DIR/$name"
  mkdir -p "$vdir"
  echo ">> recording: $name"
  npx tsx "$SCRIPT_DIR/record.mts" --url "$URL" --out "$vdir" --seconds "$SECONDS_RUN" ${COOKIES_ARGS[@]+"${COOKIES_ARGS[@]}"} "$@"
  echo ">> analyzing: $name"
  npx tsx "$SCRIPT_DIR/analyze.mts" --in "$vdir"
}

case "$MODE" in
  single)
    run_variant "current" --ext "$REPO_ROOT/web-extension"
    ;;
  baseline)
    run_variant "none"
    run_variant "current" --ext "$REPO_ROOT/web-extension"
    ;;
  sit)
    run_variant "none" --no-scroll
    run_variant "current" --no-scroll --ext "$REPO_ROOT/web-extension"
    ;;
  sit-sweep)
    # Sit at three durations. Short (5s) catches fast loops; medium (15s) catches
    # mid-cycle animations; long (60s) catches slow breathing/tint cycles.
    for dur in 5 15 60; do
      SECONDS_RUN="$dur"
      run_variant "none_${dur}s"    --no-scroll
      run_variant "current_${dur}s" --no-scroll --ext "$REPO_ROOT/web-extension"
    done
    ;;
  scroll-sit)
    run_variant "none"    --scroll-then-sit
    run_variant "current" --scroll-then-sit --ext "$REPO_ROOT/web-extension"
    ;;
  sit-png)
    run_variant "none"    --no-scroll --png-capture
    run_variant "current" --no-scroll --png-capture --ext "$REPO_ROOT/web-extension"
    ;;
  compare|*)
    # Ensure ref worktree exists at $REF.
    if [ ! -d "$REF_WT" ]; then
      git -C "$REPO_ROOT" worktree add "$REF_WT" "$REF"
    else
      # Use git -C so we never rely on cd; that way a failure can't accidentally
      # run reset --hard in the caller's working tree.
      git -C "$REF_WT" fetch --quiet origin || true   # tolerate offline
      git -C "$REF_WT" reset --hard "origin/$REF" \
        || git -C "$REF_WT" reset --hard "$REF"
    fi
    run_variant "$REF" --ext "$REF_WT/web-extension"
    run_variant "current" --ext "$REPO_ROOT/web-extension"
    ;;
esac

# Summary report.
REPORT="$RUN_DIR/report.md"
{
  echo "# Motion report: $URL"
  echo ""
  echo "Recorded $SECONDS_RUN s headless. Motion = mean YAVG of inter-frame difference (0 = no motion). Scroll moments are masked."
  echo ""
  echo "| variant | frames | meanMotion | maxMotion | movingFrames% |"
  echo "|---------|-------:|-----------:|----------:|--------------:|"
  for v in "$RUN_DIR"/*/; do
    name="$(basename "$v")"
    s="$v/summary.json"
    if [ -f "$s" ]; then
      jq -r --arg n "$name" '"| \($n) | \(.frames) | \(.meanMotion) | \(.maxMotion) | \(.movingFramesPct) |"' "$s"
    fi
  done
  echo ""
  echo "Heatmaps per variant in \`<variant>/heatmap.png\`."
} > "$REPORT"

echo ""
echo "=== $REPORT ==="
cat "$REPORT"
