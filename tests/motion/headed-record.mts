#!/usr/bin/env node
// Headed Chromium + Playwright recordVideo. Used when:
//  - Headless suppresses media playback (AR-spin <video> elements stay
//    blank even with muted+playsinline), AND
//  - AVFoundation screen capture isn't available (TCC screen-recording
//    permission revoked).
//
// Chrome runs headed at the given virtual-display coords, but recordVideo
// pulls the renderer's output via CDP so frames arrive regardless of where
// the OS draws the window. Output: recording.webm in --out, compatible
// with analyze.mts.

import { chromium as rawChromium } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
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
const extArg = arg('ext');
const winX = arg('window-x', '-2540');
const winY = arg('window-y', '-220');
const seconds = parseInt(arg('seconds', '15'), 10);
const windowW = parseInt(arg('window-w', '1280'), 10);
const windowH = parseInt(arg('window-h', '800'), 10);
if (!url || !outArg) { console.error('--url --out required'); process.exit(1); }
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });
const extDir = extArg ? resolve(extArg) : null;

const launchArgs = [
  `--window-position=${winX},${winY}`,
  `--window-size=${windowW},${windowH}`,
  '--mute-audio',
  '--hide-scrollbars',
  '--disable-blink-features=AutomationControlled',
  '--autoplay-policy=no-user-gesture-required',
];
if (extDir) launchArgs.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);

const context = await chromium.launchPersistentContext(join(outDir, '.userdata'), {
  headless: false,
  args: launchArgs,
  viewport: { width: windowW, height: windowH },
  recordVideo: { dir: outDir, size: { width: windowW, height: windowH } },
});
const page = await context.newPage();
if (extDir) await page.waitForTimeout(1500);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(seconds * 1000);

// Snapshot final state for debugging.
const debug = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('video')).map((v) => ({
    src: (v.currentSrc || v.src || '').slice(0, 120),
    paused: v.paused, currentTime: v.currentTime, readyState: v.readyState,
    stillVideo: v.dataset.stillVideo || null,
  }));
});
writeFileSync(join(outDir, 'debug-videos.json'), JSON.stringify(debug, null, 2));
console.log('videos:', JSON.stringify(debug, null, 2));

await page.screenshot({ path: join(outDir, 'final.png') }).catch(() => {});
await page.close();
await context.close();

const files = readdirSync(outDir).filter((f) => f.endsWith('.webm'));
if (files.length) renameSync(join(outDir, files[0]), join(outDir, 'recording.webm'));
// Synthesize a frame_times.json for analyze.mts (it derives from webm if missing).
writeFileSync(join(outDir, 'scroll_times.json'), JSON.stringify({ scrollTimes: [] }, null, 2));
