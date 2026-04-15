# Motion testing harness

Headlessly records a website, frame-diffs the video, and reports whether
the Still extension is blocking motion. Nothing ever paints to your display
— safe for migraine-sensitive testing.

## Files

- `record.mts` — Playwright headless recorder (optional extension load, optional cookies).
- `analyze.mts` — ffmpeg frame-diff, emits `motion.csv`, `heatmap.png`, `summary.json`.
- `run.sh` — orchestrator; default mode compares current tree vs `main`.
- `decrypt-chrome-cookies.mts` — pulls cookies for a domain from your local
  Chrome profile, decrypts with macOS Keychain, writes a Playwright JSON.

TypeScript scripts are run via `tsx` — no build step, no emit. Scoped
`tsconfig.json` in this directory.

Reports land in `reports/<slug>_<timestamp>/`.

## Prerequisites

- `ffmpeg` on PATH (`brew install ffmpeg`).
- `npm install` at repo root (installs Playwright + stealth plugin).

## Quick start

```bash
# Baseline: no extension vs current tree
MODE=baseline ./tests/motion/run.sh https://example.com 20

# Compare current tree against main (default)
./tests/motion/run.sh https://example.com 20

# Just record current tree
MODE=single ./tests/motion/run.sh https://example.com 20

# Compare against a different git ref
REF=some-branch ./tests/motion/run.sh https://example.com 20
```

## Testing sites behind bot walls or auth

Some sites (Amazon, e.g.) block headless browsers. If you've already visited
the site in Chrome, you can pull your session cookies:

```bash
# 1. Find which Chrome profile you use (most recent Cookies mtime).
ls -lt ~/Library/Application\ Support/Google/Chrome/*/Cookies

# 2. Pull + decrypt cookies for the domain. First run prompts Keychain once —
#    click "Always Allow" when macOS asks about "Chrome Safe Storage".
mkdir -p tests/motion/cookies
npx tsx tests/motion/decrypt-chrome-cookies.mts \
  --profile "Profile 3" \
  --domain amazon.com \
  --out tests/motion/cookies/amazon.com.json

# 3. Run — run.sh auto-picks cookies by hostname.
./tests/motion/run.sh https://www.amazon.com 20
```

Cookie JSONs are gitignored.

## Interpreting results

`meanMotion` — average per-frame pixel difference after scroll frames are
masked. Lower is better. `0.0` means the page was visually static.

`maxMotion` — largest single-frame delta. A high max with a low mean often
means one big layout shift or popup, not ongoing animation.

`heatmap.png` — cumulative max-over-time of inter-frame differences. Shows
*where* on the page motion happened. Safe to open (it's a still image).

`motion.csv` — per-frame `(t, motion)` if you want to plot.

## Gotchas

- Amazon (and similar) serve different pages on different visits — lazy
  loading, A/B tests, time-of-day content. Expect run-to-run variance of
  ~0.5 on `meanMotion`. Run 3–5× before concluding a change helped or hurt.
- Scroll masking assumes the video timeline starts at `newPage()`. If you
  change `record.mts`, keep the `tVideoStart` anchor correct or the scroll
  mask will drift.
- The `ref` worktree at `/tmp/still-motion-ref-wt` is reused across runs.
  Delete it if you want a clean checkout.
