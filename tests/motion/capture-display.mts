#!/usr/bin/env node
// Non-headless Chromium capture via macOS AVFoundation. Run Chrome positioned
// on a BetterDisplay virtual display (or any invisible display), capture it
// with ffmpeg at up to 60fps, feed the frames through variance.mts to detect
// flicker that CDP screencast (capped at ~3fps in headless) cannot.
//
// Prereqs:
//   - BetterDisplay or equivalent virtual display (no photons anywhere)
//   - ffmpeg with avfoundation support (Homebrew build is fine)
//   - Know your virtual display's AVFoundation index (see list-displays.sh)
//   - Know the virtual display's macOS origin in pixel coords (--window-x/y)
//
// Usage: tsx capture-display.mts --url <url> --out <dir>
//                                --av-index <N>       # avfoundation device number
//                                --window-x <X> --window-y <Y>  # chrome position
//                                [--seconds <n>] [--fps <n>]
//                                [--cookies <json>] [--ext <ext-dir>]
//                                [--window-w 1280] [--window-h 800]

import { chromium as rawChromium, type Cookie, type Response } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
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
const avIndex = arg('av-index');
const winX = arg('window-x');
const winY = arg('window-y');
if (!url || !outArg || !avIndex || !winX || !winY) {
  console.error('required: --url --out --av-index --window-x --window-y');
  process.exit(1);
}
const outDir = resolve(outArg);
const seconds = parseInt(arg('seconds', '10'), 10);
const fps = parseInt(arg('fps', '60'), 10);
const cookiesFile = arg('cookies');
const extArg = arg('ext');
const extDir = extArg ? resolve(extArg) : null;
const windowW = parseInt(arg('window-w', '1280'), 10);
const windowH = parseInt(arg('window-h', '800'), 10);
// Scroll-then-sit: scroll through 4 viewport positions with short pauses, then
// sit for the remainder of the capture window. Captures in-view / lazy-load
// animations that pure sit-mode misses. Scroll timestamps are recorded so the
// analyzer can mask them.
const scrollThenSit = process.argv.includes('--scroll-then-sit');
// Use the system Chrome binary (not Playwright's Chromium-for-Testing). Real
// Chrome has a different TLS fingerprint that Cloudflare-protected sites like
// axios.com require even with valid cookies. Channel 'chrome' is set up by
// `npx playwright install chrome`.
const useSystemChrome = process.argv.includes('--system-chrome');

mkdirSync(outDir, { recursive: true });
const framesDir = join(outDir, 'frames');
mkdirSync(framesDir, { recursive: true });

// Launch Chromium NON-headless at the target display's pixel coordinates.
// Playwright forwards --window-position / --window-size to Chromium.
const launchArgs = [
  `--window-position=${winX},${winY}`,
  `--window-size=${windowW},${windowH}`,
  '--hide-scrollbars',
  '--mute-audio',
  // We rely on the OS to keep the compositor running at full rate since the
  // window is on a "real" (virtual) display, not headless.
  // Disable Chrome's `navigator.webdriver` exposure + automation banner so
  // Cloudflare-style bot walls accept the session even with valid cookies.
  '--disable-blink-features=AutomationControlled',
];
if (extDir) launchArgs.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);

const context = await chromium.launchPersistentContext(join(outDir, '.userdata'), {
  headless: false,
  channel: useSystemChrome ? 'chrome' : undefined,
  args: launchArgs,
  viewport: { width: windowW, height: windowH },
});

if (cookiesFile && existsSync(cookiesFile)) {
  const cookies: Cookie[] = JSON.parse(readFileSync(cookiesFile, 'utf8'));
  for (const c of cookies) if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax';
  for (const c of cookies) { try { await context.addCookies([c]); } catch {} }
}

const page = await context.newPage();
if (extDir) await page.waitForTimeout(1500);

let nav: Response | null = null;
try {
  nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) { console.error('goto failed:', (e as Error).message); }
try {
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, { timeout: 6000 });
} catch {}

writeFileSync(join(outDir, 'debug.json'), JSON.stringify({
  status: nav ? nav.status() : null,
  finalUrl: page.url(),
  title: await page.title().catch(() => null),
  bodyTextLength: await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0),
}, null, 2));

// Start ffmpeg capturing the target avfoundation display. "INDEX:none" = video
// from that display, no audio. A few macOS-specific details:
//   - Virtual displays report a retina (2×) backing buffer, so a 2560×1440
//     display comes out as 5120×2880 from avfoundation. We crop to Chrome's
//     1280×800 point window (= 2560×1600 pixels at 2× scale) at the top-left
//     of the display (Chrome was launched there), then scale to 1280×800 for
//     storage + compat with our other analyzers.
//   - Without -r on output, ffmpeg defaults to 1000fps VFR output and fills
//     with tens of thousands of duplicate frames. -r <fps> forces CFR.
//   - -pixel_format uyvy422 matches what avfoundation offers for screen caps.
const cropPx = `${windowW * 2}:${windowH * 2}:0:0`; // 2× for retina backing
const ffArgs = [
  '-hide_banner',
  '-f', 'avfoundation',
  '-framerate', String(fps),
  '-pixel_format', 'uyvy422',
  '-capture_cursor', '0',
  '-i', `${avIndex}:none`,
  '-t', String(seconds),
  '-vf', `crop=${cropPx},scale=${windowW}:${windowH}`,
  '-r', String(fps),
  '-q:v', '2',
  '-f', 'image2',
  join(framesDir, '%06d.jpg'),
];
console.log('ffmpeg', ffArgs.join(' '));
const tFfStart = Date.now();
const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
const done = new Promise<void>((res) => ff.on('exit', () => res()));

// Concurrent workload: scroll pattern (if requested) while ffmpeg captures.
// Scroll timestamps are in ffmpeg wall-clock (capture timeline) so the analyzer
// masks them correctly. ffmpeg may take a few hundred ms to start producing
// frames — our scroll timestamps will be slightly ahead of true frame-time,
// but the ±0.4s mask window absorbs that.
const scrollTimes: number[] = [];
if (scrollThenSit) {
  (async () => {
    // Let ffmpeg settle briefly before first scroll.
    await page.waitForTimeout(500);
    const positions = [600, 1200, 1800, 2400];
    for (const y of positions) {
      const t = (Date.now() - tFfStart) / 1000;
      scrollTimes.push(t);
      try { await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' }), y); } catch {}
      await page.waitForTimeout(1000);
    }
    // Remaining time of the capture window: just sit.
  })().catch((e) => console.error('scroll workload error:', (e as Error).message));
}

await done;
const tFfEnd = Date.now();
const dt = (tFfEnd - tFfStart) / 1000;

await page.close();
await context.close();

// Build frame_times.json assuming constant framerate. ffmpeg's image2 muxer
// writes one frame per input tick, so idx/fps is the capture-relative time.
const frameFiles = readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
const frameTimes = frameFiles.map((_f, idx) => ({ idx, t: idx / fps }));
writeFileSync(join(outDir, 'frame_times.json'), JSON.stringify({ frameTimes }, null, 2));
writeFileSync(join(outDir, 'scroll_times.json'), JSON.stringify({ scrollTimes }, null, 2));
console.log(`captured ${frameFiles.length} frames in ${dt.toFixed(1)}s (~${(frameFiles.length / dt).toFixed(1)} fps)`);
