# Still — Browser Extension

A cross-browser extension that blocks animated images (GIF, WebP, APNG), replacing them with a static placeholder.

## Architecture

- `web-extension/` — The core cross-browser extension (Manifest V3)
  - `content.js` — Content script injected at `document_start` in all frames. Detects and replaces animated images via multiple strategies: CSS pre-hide on animated-looking URLs (src/srcset/picture), regex on URLs, partial-fetch byte inspection for WebP/APNG (fail-closed: hidden while checking) and PNG/SVG/AVIF (fail-open: visible while checking), HEAD requests for extensionless URLs, per-URL probe memoization, MutationObserver for dynamic content, and `src` setter override to prevent page JS from restoring animations. Videos are re-paused unless playback was user-initiated (`data-still-user-play`). Animated canvases are frozen by `main-world-patch.js` (draw-call/tick classifier); content.js counts them on the badge via the `data-still-canvas` attribute and owns the `data-still-off` enable/allowlist signal on `<html>` — which it also defends against page writes (the attribute is page-visible DOM).
  - `background.js` — Service worker. Manages state (enabled toggle, per-site allowlist), badge counts, cross-origin HEAD probes for content scripts, and webRequest header interception (Chrome/Firefox only; Safari lacks webRequest and relies on content script probing).
  - `popup.html/js/css` — Extension popup UI with global toggle and per-site allowlist toggle.
  - `manifest.json` — MV3 manifest. The gif/webp/apng `declarativeNetRequest` rulesets ship **disabled** (the redirect-to-SVG broke spacer detection); all image blocking happens in the content script. Only the gstatic AR-video ruleset is enabled (network-level block).
  - `rules/` — declarativeNetRequest rulesets for gif/webp/apng (disabled) and gstatic AR videos (enabled).
  - `icons/` — Extension icons + frozen.svg placeholder.

- `Still/` — Xcode project for Safari iOS (generated via `safari-web-extension-converter`)
- `StillMac/` — Xcode project for Safari macOS
- `xcode/` — Another Xcode project variant (iOS, newer)

- `tests/` — Playwright tests (`freeze.spec.js`) running in Chromium
- `blockerList.json` — Safari Content Blocker rules (used by the iOS Content Blocker extension target)

## Commands

```bash
# Run tests
npm test                    # or: npx playwright test
npm run test:headed         # headed mode

# Motion testing harness — headless, safe for migraine-sensitive iteration.
# Records a site in headless Chromium and frame-diffs the video. See
# tests/motion/README.md for the full cookie-capture + run flow.
./tests/motion/run.sh <url>                    # compare current tree vs main
MODE=baseline ./tests/motion/run.sh <url>      # add a no-extension run
MODE=single   ./tests/motion/run.sh <url>      # current tree only

# Convert web extension to Safari Xcode projects
npm run convert:ios
npm run convert:macos
npm run convert:all
```

## Release process

`main` is the development trunk — merging here does NOT ship. Xcode Cloud's
"Default" workflow is configured to trigger on **tag pushes matching `v*`**
(Start Conditions → Tag Changes). Until a tag is pushed, nothing goes to
App Store Connect or TestFlight.

To cut a release:

```bash
# on main, after the changes you want to ship are merged
git tag v1.2.0
git push origin v1.2.0
# → Xcode Cloud archives, submits to App Store Connect, posts to TestFlight Internal
```

Do not push tags casually. Do not re-enable the "Branch Changes: main"
start condition — it would make every merge ship.

## Important

- **Always close the iOS Simulator when done with it.** The user does not want to see animated GIFs on screen. Shut down simulators (`xcrun simctl shutdown`) and kill any local servers after taking screenshots.

## Key Patterns

- **Browser API compatibility**: Uses `typeof browser !== 'undefined' ? browser : chrome` and wraps callback APIs in Promises to handle Safari (Promise-based) and Chrome (callback-based) differences.
- **Image replacement**: Animated images get their `src` set to an inline SVG placeholder (pause icon). The `src` setter is then overridden via `Object.defineProperty` to prevent page JS from swapping it back. CSS `visibility:hidden` hides images during detection; `data-still` attribute tracks state (`replacing`, `replaced`, `probing`, `static`).
- **Canvas freezing**: `main-world-patch.js` wraps `getContext`/draw methods (and `Worker.postMessage` for OffscreenCanvas tick feeds) and freezes a canvas only on a *sustained* run of paints — `data-still-canvas` marks the result (`frozen` = draws no-op'd from the next frame boundary; `frozen-worker` = hidden). Click/keydown on a canvas exempts it (games/maps); wheel/scroll deliberately does not. `data-still-off` on `<html>` is the cross-world disable signal, written and defended by content.js.
- **Testing**: Tests mock the `browser` API via `addInitScript`, inject `content.js` via `addScriptTag`, and use a local HTTP server for fixtures (`canvas.spec.js` uses `data:` URLs instead — `setContent` would drop the main-world patch's document-level listeners). The content script exposes `window.__still` for test access; the main-world patch exposes `window.__stillCanvas`.
