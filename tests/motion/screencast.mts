#!/usr/bin/env node
// High-framerate recorder using Chrome DevTools Protocol's Page.startScreencast.
// Captures JPEGs at ~30-60fps via WebSocket stream — required for detecting
// 10-60 Hz pixel flicker that frame-to-frame analyzers miss.
//
// Lossless PNG is not a CDP screencast option; JPEG quality=95 is visually
// near-lossless and catches flicker signal well. For pure subpixel-AA jitter
// detection, use record.mts --png-capture (lossless but only ~5fps).
//
// Output layout matches record.mts so analyze.mts / inspect.mts / variance.mts
// can all read it.
//
// Usage: tsx screencast.mts --url <url> --out <dir> [--seconds <n>]
//                           [--cookies <json>] [--ext <extension-dir>]

import { chromium as rawChromium, type Cookie, type Response } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
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
const seconds = parseInt(arg('seconds', '10'), 10);
const cookiesFile = arg('cookies');
const extArg = arg('ext');
const extDir = extArg ? resolve(extArg) : null;
const quality = parseInt(arg('quality', '95'), 10);

mkdirSync(outDir, { recursive: true });
const viewport = { width: 1280, height: 800 };

// Flag soup required to get a real high-fps screencast in headless-new:
//   - Keep GPU on: --disable-gpu drops compositor to ~2 fps.
//   - disable-backgrounding-occluded-windows: prevents Chrome from pausing us
//     because the window "isn't visible" (it never is — we're headless).
//   - disable-renderer-backgrounding + disable-background-timer-throttling:
//     keeps rAF running at full rate. Without these, rAF is clamped to ~1 Hz.
const launchArgs = [
  '--headless=new',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];
if (extDir) {
  launchArgs.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
}

const context = await chromium.launchPersistentContext(join(outDir, '.userdata'), {
  headless: false,
  args: launchArgs,
  viewport,
});

// Headless compositor only ticks when something "needs" painting. Without a
// driver it produces ~2 fps during steady-state browsing, which is way below
// what we need for flicker detection. Force the compositor to tick every frame
// by mutating an offscreen element in a rAF loop. The element is fixed at
// position -9999px so it never appears in the captured viewport — it does not
// affect the measured pixels, only the paint cadence.
await context.addInitScript(() => {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;pointer-events:none;';
  let toggled = false;
  const install = () => {
    if (!document.documentElement) return;
    document.documentElement.appendChild(el);
    const tick = () => {
      toggled = !toggled;
      el.style.opacity = toggled ? '0.999' : '1';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if (document.documentElement) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
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

// Set up the screencast via CDP.
const client = await context.newCDPSession(page);
const framesDir = join(outDir, 'frames');
mkdirSync(framesDir, { recursive: true });
const frameTimes: { idx: number; t: number }[] = [];
let idx = 0;
const tStart = Date.now();
let lastLog = tStart;

// CDP emits screencastFrame events at ~the compositor rate (up to 60fps).
// We MUST ACK each frame or the browser stops sending. The ACK is cheap, so the
// rate is limited by WebSocket throughput + our disk write speed (fine on SSD).
client.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata?: { timestamp?: number } }) => {
  const t = (Date.now() - tStart) / 1000;
  const p = join(framesDir, String(idx).padStart(6, '0') + '.jpg');
  writeFileSync(p, Buffer.from(frame.data, 'base64'));
  frameTimes.push({ idx, t });
  idx++;
  // Fire-and-forget ack (don't await — keeps pipeline full).
  client.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  // Progress every second.
  if (Date.now() - lastLog > 1000) {
    const fps = idx / ((Date.now() - tStart) / 1000);
    console.log(`  captured ${idx} frames (${fps.toFixed(1)} fps)`);
    lastLog = Date.now();
  }
});

await client.send('Page.startScreencast', {
  format: 'jpeg',
  quality,
  maxWidth: viewport.width,
  maxHeight: viewport.height,
});

await page.waitForTimeout(seconds * 1000);

await client.send('Page.stopScreencast').catch(() => {});
// Drain any in-flight frames briefly.
await page.waitForTimeout(200);

await page.close();
await context.close();

writeFileSync(join(outDir, 'frame_times.json'), JSON.stringify({ frameTimes }, null, 2));
writeFileSync(join(outDir, 'scroll_times.json'), JSON.stringify({ scrollTimes: [] }, null, 2));
const fpsTotal = frameTimes.length ? frameTimes.length / seconds : 0;
console.log(`wrote ${frameTimes.length} frames (~${fpsTotal.toFixed(1)} fps) to ${framesDir}`);
