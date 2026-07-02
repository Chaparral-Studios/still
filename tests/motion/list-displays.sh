#!/usr/bin/env bash
# Print connected displays with their macOS coordinate origins + sizes, and the
# AVFoundation device indices ffmpeg uses to capture them. After creating a
# virtual display in BetterDisplay, run this to find the right values to pass to
# capture-display.mts.

set -euo pipefail

echo "=== macOS displays (NSScreen origin + size) ==="
# system_profiler doesn't surface coordinate origins reliably; a Swift one-liner
# against NSScreen does. Bash-style heredoc piped into `swift -` runs inline.
swift - <<'SWIFT_EOF' 2>/dev/null
import Cocoa
// NSScreen frames are COCOA coordinates (origin bottom-left of primary, Y up).
// Chromium --window-position and `screencapture -R` use TOP-LEFT-origin global
// coordinates (Y down). Passing the raw Cocoa origin for a display that sits
// below/above the primary puts the window OFF-SCREEN, and macOS clamps it onto
// a visible display — which flashed a page on the user's real screen once
// (2026-07-01). Print both; only the converted one is safe for --window-x/y.
let primaryH = NSScreen.screens.first?.frame.size.height ?? 0
for screen in NSScreen.screens {
  let f = screen.frame
  let name = screen.localizedName
  let topLeftY = Int(primaryH - (f.origin.y + f.size.height))
  print("  name: \(name)")
  print("    cocoa origin (do NOT use): (\(Int(f.origin.x)), \(Int(f.origin.y)))")
  print("    TOP-LEFT origin (use for --window-x/y): (\(Int(f.origin.x)), \(topLeftY))")
  print("    size: \(Int(f.size.width))x\(Int(f.size.height))")
}
SWIFT_EOF

echo ""
echo "=== ffmpeg AVFoundation devices ==="
ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | grep -E '\[AVFoundation.*\] \[[0-9]+\]' || echo "  (ffmpeg not installed or no devices)"

echo ""
echo "Use the TOP-LEFT origin (x,y) for --window-x / --window-y of capture-display.mts,"
echo "and the AVFoundation index for --av-index (the numbers like [0], [1] in the second list)."
echo "ALWAYS verify placement with a static about:blank window + screencapture of the"
echo "main display BEFORE loading any real site headed (migraine safety)."
