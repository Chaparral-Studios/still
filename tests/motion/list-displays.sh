#!/usr/bin/env bash
# Print connected displays with their macOS coordinate origins + sizes, and the
# AVFoundation device indices ffmpeg uses to capture them. After creating a
# virtual display in BetterDisplay, run this to find the right values to pass to
# capture-display.mts.

set -euo pipefail

echo "=== macOS displays (from system_profiler) ==="
system_profiler SPDisplaysDataType -json 2>/dev/null | python3 -c '
import json, sys
data = json.load(sys.stdin)
for gpu in data.get("SPDisplaysDataType", []):
    for d in gpu.get("spdisplays_ndrvs", []):
        name = d.get("_name", "(unknown)")
        res = d.get("_spdisplays_resolution", d.get("spdisplays_pixels", "?"))
        origin = d.get("spdisplays_display_origin", "?")
        main = " [MAIN]" if d.get("spdisplays_main") == "spdisplays_yes" else ""
        mirror = " [MIRROR]" if d.get("spdisplays_mirror") == "spdisplays_yes" else ""
        virtual = " [VIRTUAL]" if "virtual" in name.lower() or "betterdisplay" in name.lower() else ""
        print(f"  name: {name}{main}{mirror}{virtual}")
        print(f"    resolution: {res}")
        print(f"    origin: {origin}")
' 2>/dev/null || echo "  (could not parse system_profiler output)"

echo ""
echo "=== ffmpeg AVFoundation devices ==="
ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | grep -E '\[AVFoundation.*\] \[[0-9]+\]' || echo "  (ffmpeg not installed or no devices)"

echo ""
echo "Use the display origin (x,y) for --window-x / --window-y of capture-display.mts,"
echo "and the AVFoundation index for --av-index (the numbers like [0], [1] in the second list)."
