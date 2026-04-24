#!/usr/bin/env node
// Headless recorder. Never paints to a display.
// Usage: tsx record.ts --url <url> --out <dir> [--ext <extension-dir>] [--seconds <n>] [--cookies <json>]

import { chromium as rawChromium, type Cookie, type Response } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, existsSync, renameSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const chromium = addExtra(rawChromium);
chromium.use(StealthPlugin());

function arg(name: string): string | undefined;
function arg(name: string, fallback: string): string;
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg('url');
const outArg = arg('out');
if (!url || !outArg) { console.error('--url and --out required'); process.exit(1); }
const outDir = resolve(outArg);
const extArg = arg('ext');
const extDir = extArg ? resolve(extArg) : null;
const seconds = parseInt(arg('seconds', '30'), 10);
const cookiesFile = arg('cookies');
const noScroll = process.argv.includes('--no-scroll');
// "scroll-then-sit" mode: scroll through a handful of viewport positions with
// short pauses, then sit still for the rest of the duration. Catches animations
// that are triggered by new content coming into view (IntersectionObserver-driven
// carousels, lazy-loaded Lottie, in-view parallax) which idle sit-mode misses.
const scrollThenSit = process.argv.includes('--scroll-then-sit');
// PNG-capture mode: instead of a lossy VP8 WebM, write a PNG per tick. Losseless,
// no chroma subsampling — required for detecting sub-1-luminance-unit signal
// (subpixel AA jitter, slow hue drift). Only valid with --no-scroll for now.
const pngCapture = process.argv.includes('--png-capture');
if (pngCapture && !noScroll) {
  console.error('--png-capture currently requires --no-scroll (sit mode)');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const viewport = { width: 1280, height: 800 };

// To load an MV3 extension we need a persistent context with the new headless mode.
const launchArgs = [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--mute-audio',
];
if (extDir) {
  launchArgs.push(`--disable-extensions-except=${extDir}`);
  launchArgs.push(`--load-extension=${extDir}`);
}

const userDataDir = join(outDir, '.userdata');
mkdirSync(userDataDir, { recursive: true });

const context = await chromium.launchPersistentContext(userDataDir, {
  // We set Playwright's `headless: false` so it doesn't pass its own `--headless`
  // flag (which would disable MV3 extension loading). The actual offscreen
  // rendering comes from `--headless=new` in launchArgs — nothing ever paints
  // to a display. Net effect: extension loads AND no screen output.
  headless: false,
  args: launchArgs,
  viewport,
  // Skip WebM in PNG-capture mode to halve the work and ensure no encoder
  // interference with the screenshot stream.
  ...(pngCapture ? {} : { recordVideo: { dir: outDir, size: viewport } }),
});

if (cookiesFile && existsSync(cookiesFile)) {
  const cookies: Cookie[] = JSON.parse(readFileSync(cookiesFile, 'utf8'));
  let ok = 0, bad = 0;
  for (const c of cookies) {
    const originalSameSite = c.sameSite;
    // Playwright rejects sameSite=None without secure=true; silently downgrade.
    if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax';
    try { await context.addCookies([c]); ok++; }
    catch (e) {
      bad++;
      console.log('reject', c.name, c.domain, `sameSite=${originalSameSite}`, (e as Error).message.slice(0, 80));
    }
  }
  console.log(`loaded ${ok} cookies, rejected ${bad}`);
}

const page = await context.newPage();
// Video timeline starts at newPage(). Anchor scroll timestamps here.
const tVideoStart = Date.now();

// Give the extension's service worker a moment to spin up.
if (extDir) await page.waitForTimeout(1500);

let nav: Response | null = null;
try {
  nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) {
  console.error('goto failed:', (e as Error).message);
}
// Wait for actual content — goto on a JS-challenge page returns immediately with
// an empty body; we want the real page before starting the measurement window.
// 6s is a reasonable upper bound for challenge → hydration to complete.
try {
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, { timeout: 6000 });
} catch {}
const debug = {
  status: nav ? nav.status() : null,
  finalUrl: page.url(),
  title: await page.title().catch(() => null),
  bodyTextLength: await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0),
  bodyTextSample: await page.evaluate(() => (document.body?.innerText || '').slice(0, 300)).catch(() => null),
};
writeFileSync(join(outDir, 'debug.json'), JSON.stringify(debug, null, 2));
await page.screenshot({ path: join(outDir, 'debug-initial.png'), fullPage: false }).catch(() => {});

const scrollTimes: number[] = [];
if (pngCapture) {
  // Lossless PNG capture loop at ~10fps best-effort. page.screenshot reads the
  // compositor buffer via CDP without triggering a repaint, so this shouldn't
  // itself cause motion. Frame timestamps are recorded relative to capture
  // start (reset here so analysis lines up with captures, not page.goto).
  const framesDir = join(outDir, 'frames');
  mkdirSync(framesDir, { recursive: true });
  const tCaptureStart = Date.now();
  const frameTimes: { idx: number; t: number }[] = [];
  const endAt = tCaptureStart + seconds * 1000;
  let idx = 0;
  while (Date.now() < endAt) {
    const t = (Date.now() - tCaptureStart) / 1000;
    const p = join(framesDir, String(idx).padStart(6, '0') + '.png');
    await page.screenshot({ path: p, fullPage: false });
    frameTimes.push({ idx, t });
    idx++;
    await page.waitForTimeout(100);
  }
  writeFileSync(join(outDir, 'frame_times.json'), JSON.stringify({ frameTimes }, null, 2));
} else if (noScroll) {
  // Pure sit: isolates ambient animation, no viewport changes.
  await page.waitForTimeout(seconds * 1000);
} else if (scrollThenSit) {
  // Scroll through 4 viewport positions with short pauses to trigger in-view
  // animations, then sit still for the remaining budget. Any motion after the
  // final scroll is settle-triggered animation (lazy carousels, parallax,
  // IntersectionObserver callbacks) that idle sit-mode would never see.
  const positions = [600, 1200, 1800, 2400];
  const scrollPhase = 1.0; // 1s per scroll step
  for (const y of positions) {
    const t = (Date.now() - tVideoStart) / 1000;
    scrollTimes.push(t);
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' }), y);
    await page.waitForTimeout(scrollPhase * 1000);
  }
  const sitBudget = Math.max(1, seconds - positions.length * scrollPhase);
  await page.waitForTimeout(sitBudget * 1000);
} else {
  // Continuous-scroll mode: scroll every 3s for the full duration.
  const steps = Math.max(1, Math.floor(seconds / 3));
  for (let i = 0; i < steps; i++) {
    const t = (Date.now() - tVideoStart) / 1000;
    scrollTimes.push(t);
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), i * 600);
    await page.waitForTimeout(3000);
  }
}
writeFileSync(join(outDir, 'scroll_times.json'), JSON.stringify({ scrollTimes }, null, 2));

await page.close();
await context.close();

if (pngCapture) {
  console.log('wrote', join(outDir, 'frames'));
} else {
  // Playwright names the video with a random id; rename to recording.webm.
  const files = readdirSync(outDir).filter((f) => f.endsWith('.webm'));
  if (files.length) {
    renameSync(join(outDir, files[0]), join(outDir, 'recording.webm'));
    console.log('wrote', join(outDir, 'recording.webm'));
  } else {
    console.error('no video produced');
    process.exit(2);
  }
}
