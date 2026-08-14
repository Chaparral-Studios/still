# Publishing Still to the Chrome Web Store

Everything the submission needs lives in this directory. `listing.md` is the
copy-paste source for every text field; this file is the order of operations.

## Build the upload zip

```bash
npm run store:package        # → dist/still-chrome-<version>.zip
```

The store requires `manifest.json` at the **zip root**, not nested inside a
folder — the script zips the contents of `web-extension/`, checks the manifest
parses, and syntax-checks each script before packing. It prints the archive
listing so you can confirm `manifest.json` is at the top level.

## Regenerate screenshots

```bash
npm run store:screenshots    # → store/chrome/screenshots/*.png (1280×800)
```

Runs headless Chromium only — nothing paints to a display. It generates the
demo page's animated GIFs with ffmpeg into `store/chrome/.build/` (gitignored,
so no animated asset is ever committed), captures the demo page with and
without the extension loaded, and composes the labelled comparison.

Requires `ffmpeg` on PATH.

## One-time setup

1. **Register as a developer** — https://chrome.google.com/webstore/devconsole,
   one-time US$5 fee, paid with the Google account that will own the listing.
   Use an account you will keep: transferring a published item later is
   awkward.
2. **Host the privacy policy.** The store requires a public URL, not a file.
   The page is already written and committed at `docs/privacy.html`, so the
   only step left is to serve it: repository **Settings → Pages → Deploy from
   branch → `main` → `/docs`**.

   The URL becomes `https://chaparral-studios.github.io/still/privacy.html`.
   Open it before submitting — a 404 here is a guaranteed rejection.

## Submit

1. Developer Console → **Add new item** → upload the zip.
2. **Store listing** tab — name, short description, detailed description,
   category (Accessibility), language, screenshots, 128×128 icon. All the text
   is in `listing.md`.
3. **Privacy practices** tab — single purpose, the permission justifications
   (one per permission, all in `listing.md`), "No" to every data-collection
   category, all three certification checkboxes, and the privacy policy URL.
4. **Distribution** — Public, all regions (or start Unlisted if you want to
   test the install flow before it is findable).
5. **Submit for review.**

## What to expect from review

Broad host permissions (`<all_urls>`) plus `webRequest` put this item in the
manual review lane rather than the fast automated one. Typical turnaround is a
few days; two to three weeks happens. The justification text matters — reviewers
reject vague answers like "needed for the extension to work", which is why the
strings in `listing.md` each name the one feature the permission serves.

If it is rejected, the notice names the specific policy section. Fix, bump
`version` in `manifest.json`, rebuild the zip, resubmit — the review clock
restarts.

## Updating later

1. Bump `"version"` in `web-extension/manifest.json` (the store rejects a
   re-upload of an existing version number).
2. `npm run store:package`
3. Upload the new zip to the existing item, then **Submit for review** again.
   Updates to an item with broad permissions are re-reviewed, but usually
   faster than the first submission.

## Note on the other stores

The same `web-extension/` directory is the source for all targets: Safari via
`npm run convert:ios` / `convert:macos` (see the repo README for the tag-driven
App Store release flow), and Firefox via addons.mozilla.org, which accepts the
same zip but reviews `webRequest` under its own rules.
