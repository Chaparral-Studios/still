# Still — Browser Extension

A cross-browser extension that blocks animated images (GIF, WebP, APNG), replacing them with a static placeholder.

## Architecture

- `web-extension/` — The core cross-browser extension (Manifest V3)
  - `content.js` — Content script injected at `document_start`. Detects and replaces animated images via multiple strategies: regex on URLs, partial-fetch byte inspection for WebP/APNG, HEAD requests for extensionless URLs, MutationObserver for dynamic content, and `src` setter override to prevent page JS from restoring animations.
  - `background.js` — Service worker. Manages state (enabled toggle, per-site allowlist), badge counts, and optional webRequest header interception (Chrome/Firefox only; Safari falls back to content script probing).
  - `popup.html/js/css` — Extension popup UI with global toggle and per-site allowlist toggle.
  - `manifest.json` — MV3 manifest. Uses `declarativeNetRequest` to block `.gif` at network level; `.webp`/`.apng` rulesets exist but are disabled (content script handles those with animation detection).
  - `rules/` — declarativeNetRequest rulesets for gif/webp/apng.
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

# Convert web extension to Safari Xcode projects
npm run convert:ios
npm run convert:macos
npm run convert:all
```

## Important

- **Always close the iOS Simulator when done with it.** The user does not want to see animated GIFs on screen. Shut down simulators (`xcrun simctl shutdown`) and kill any local servers after taking screenshots.

## Key Patterns

- **Browser API compatibility**: Uses `typeof browser !== 'undefined' ? browser : chrome` and wraps callback APIs in Promises to handle Safari (Promise-based) and Chrome (callback-based) differences.
- **Image replacement**: Animated images get their `src` set to an inline SVG placeholder (pause icon). The `src` setter is then overridden via `Object.defineProperty` to prevent page JS from swapping it back. CSS `visibility:hidden` hides images during detection; `data-still` attribute tracks state (`replacing`, `replaced`, `probing`, `static`).
- **Testing**: Tests mock the `browser` API via `addInitScript`, inject `content.js` via `addScriptTag`, and use a local HTTP server for fixtures. The content script exposes `window.__still` for test access.
