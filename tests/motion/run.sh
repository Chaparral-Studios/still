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
#   REF=<git-ref> ./run.sh <url>            # compare against a specific ref
#
# Site cookies (for bypassing bot walls / auth): place a Playwright cookie
# JSON at tests/motion/cookies/<hostname>.json — it will be auto-loaded when
# the URL's hostname matches. Use decrypt-chrome-cookies.mjs to generate one.

set -euo pipefail

URL="${1:?usage: run.sh <url> [seconds]}"
SECONDS_RUN="${2:-20}"
MODE="${MODE:-compare}"
REF="${REF:-main}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REF_WT="/tmp/still-motion-ref-wt"

# Auto-pick cookies by hostname.
HOST="$(echo "$URL" | sed -E 's#https?://##; s#/.*##' | sed 's/^www\.//')"
COOKIES_FILE="$SCRIPT_DIR/cookies/${HOST}.json"
COOKIES_ARG=""
if [ -f "$COOKIES_FILE" ]; then
  COOKIES_ARG="--cookies $COOKIES_FILE"
  echo ">> using cookies: $COOKIES_FILE"
fi

SLUG="$(echo "$URL" | sed -E 's#https?://##; s#[/?&=:#]+#_#g' | cut -c1-80)"
STAMP="$(date +%Y%m%d_%H%M%S)"
RUN_DIR="$SCRIPT_DIR/reports/${SLUG}_${STAMP}"
mkdir -p "$RUN_DIR"

run_variant () {
  local name="$1"; local ext_arg="$2"
  local vdir="$RUN_DIR/$name"
  mkdir -p "$vdir"
  echo ">> recording: $name"
  node "$SCRIPT_DIR/record.mjs" --url "$URL" --out "$vdir" --seconds "$SECONDS_RUN" $COOKIES_ARG $ext_arg
  echo ">> analyzing: $name"
  node "$SCRIPT_DIR/analyze.mjs" --in "$vdir"
}

case "$MODE" in
  single)
    run_variant "current" "--ext $REPO_ROOT/web-extension"
    ;;
  baseline)
    run_variant "none" ""
    run_variant "current" "--ext $REPO_ROOT/web-extension"
    ;;
  compare|*)
    # Ensure ref worktree exists at $REF.
    if [ ! -d "$REF_WT" ]; then
      git -C "$REPO_ROOT" worktree add "$REF_WT" "$REF"
    else
      (cd "$REF_WT" && git fetch --quiet origin && git reset --hard "origin/$REF" 2>/dev/null || git reset --hard "$REF")
    fi
    run_variant "$REF" "--ext $REF_WT/web-extension"
    run_variant "current" "--ext $REPO_ROOT/web-extension"
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
      node -e "const s=require('$s'); console.log(\`| $name | \${s.frames} | \${s.meanMotion} | \${s.maxMotion} | \${s.movingFramesPct} |\`)"
    fi
  done
  echo ""
  echo "Heatmaps per variant in \`<variant>/heatmap.png\`."
} > "$REPORT"

echo ""
echo "=== $REPORT ==="
cat "$REPORT"
