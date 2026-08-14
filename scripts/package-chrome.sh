#!/usr/bin/env bash
# Build the Chrome Web Store upload zip from web-extension/.
#
# The store expects manifest.json at the ZIP ROOT — not nested under a
# folder — so this zips the directory CONTENTS, not the directory.
#
# Usage: ./scripts/package-chrome.sh   →  dist/still-chrome-<version>.zip
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/web-extension"
DIST="$REPO_ROOT/dist"

VERSION=$(node -p "require('$SRC/manifest.json').version")
OUT="$DIST/still-chrome-$VERSION.zip"

mkdir -p "$DIST"
rm -f "$OUT"

# Fail early on the mistakes that cost a review round-trip.
node -e "JSON.parse(require('fs').readFileSync('$SRC/manifest.json','utf8'))" \
  || { echo "manifest.json is not valid JSON"; exit 1; }
for f in content.js background.js main-world-patch.js popup.js; do
  node --check "$SRC/$f" || { echo "syntax error in $f"; exit 1; }
done

# -x excludes: macOS metadata, and `_metadata/` — the indexed-ruleset directory
# Chrome WRITES INTO the unpacked folder when you load it locally. That name is
# reserved by the store and shipping it fails the upload. Everything the
# manifest references (icons/, rules/, host-rules.json, popup.*) is included.
cd "$SRC"
zip -r -q "$OUT" . \
  -x ".*" -x "__MACOSX/*" -x "*/.DS_Store" -x ".DS_Store" -x "*.map" \
  -x "_metadata/*" -x "_metadata"

if unzip -l "$OUT" | grep -q "_metadata"; then
  echo "ERROR: _metadata leaked into the zip"; exit 1
fi

echo "built $OUT"
unzip -l "$OUT" | tail -n +4 | head -30
echo
echo "size: $(du -h "$OUT" | cut -f1)   (store limit: 2GB, review is faster when small)"
echo "verify before upload: manifest.json must be listed at the top level above."
