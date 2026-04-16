#!/bin/bash
# Generate placeholder icons for the Still extension.
# Requires ImageMagick (brew install imagemagick).
# Writes into web-extension/icons/ regardless of cwd.

set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
out_dir="$script_dir/../web-extension/icons"
cd "$out_dir"

for size in 16 32 48 128; do
  convert -size ${size}x${size} xc:'#4A90D9' \
    -gravity center -fill white -font Helvetica-Bold \
    -pointsize $((size * 6 / 10)) \
    -annotate +0+0 'S' \
    "icon-${size}.png"
done

echo "Icons generated at $out_dir"
