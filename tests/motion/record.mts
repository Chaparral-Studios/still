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
  recordVideo: { dir: outDir, size: viewport },
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
const debug = {
  status: nav ? nav.status() : null,
  finalUrl: page.url(),
  title: await page.title().catch(() => null),
  bodyTextSample: await page.evaluate(() => (document.body?.innerText || '').slice(0, 300)).catch(() => null),
};
writeFileSync(join(outDir, 'debug.json'), JSON.stringify(debug, null, 2));
await page.screenshot({ path: join(outDir, 'debug-initial.png'), fullPage: false }).catch(() => {});

// Scroll through the page to trigger lazy-loaded motion. Timestamps are seconds
// since newPage() so they line up with ffmpeg's pts_time on the recording.
const scrollTimes: number[] = [];
const steps = Math.max(1, Math.floor(seconds / 3));
for (let i = 0; i < steps; i++) {
  const t = (Date.now() - tVideoStart) / 1000;
  scrollTimes.push(t);
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), i * 600);
  await page.waitForTimeout(3000);
}
writeFileSync(join(outDir, 'scroll_times.json'), JSON.stringify({ scrollTimes }, null, 2));

await page.close();
await context.close();

// Playwright names the video with a random id; rename to recording.webm.
const files = readdirSync(outDir).filter((f) => f.endsWith('.webm'));
if (files.length) {
  renameSync(join(outDir, files[0]), join(outDir, 'recording.webm'));
  console.log('wrote', join(outDir, 'recording.webm'));
} else {
  console.error('no video produced');
  process.exit(2);
}
