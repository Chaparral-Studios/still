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
for screen in NSScreen.screens {
  let f = screen.frame
  let name = screen.localizedName
  print("  name: \(name)")
  print("    origin: (\(Int(f.origin.x)), \(Int(f.origin.y)))")
  print("    size: \(Int(f.size.width))x\(Int(f.size.height))")
}
SWIFT_EOF

echo ""
echo "=== ffmpeg AVFoundation devices ==="
ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | grep -E '\[AVFoundation.*\] \[[0-9]+\]' || echo "  (ffmpeg not installed or no devices)"

echo ""
echo "Use the display origin (x,y) for --window-x / --window-y of capture-display.mts,"
echo "and the AVFoundation index for --av-index (the numbers like [0], [1] in the second list)."
