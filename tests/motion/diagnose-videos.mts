#!/usr/bin/env node
// Headless video diagnostic. Never paints to a display.
// Loads the extension, visits a URL, and reports the play state + Still
// attributes of every <video> (including shadow roots), sampled twice so we
// can see currentTime advancing.
// Usage: npx tsx tests/motion/diagnose-videos.mts --url <url> [--ext <dir>] [--cookies <json>] [--seconds <n>] [--scroll]

import { chromium as rawChromium, type Cookie } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const chromium = addExtra(rawChromium);
chromium.use(StealthPlugin());

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg('url');
if (!url) { console.error('--url required'); process.exit(1); }
const extArg = arg('ext');
const extDir = extArg ? resolve(extArg) : null;
const cookiesFile = arg('cookies');
const seconds = parseInt(arg('seconds', '12')!, 10);
const doScroll = process.argv.includes('--scroll');

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

const userDataDir = join(tmpdir(), `still-diagnose-${process.pid}`);
mkdirSync(userDataDir, { recursive: true });

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false, // real headless comes from --headless=new; see record.mts
  args: launchArgs,
  viewport: { width: 1280, height: 800 },
});

if (cookiesFile && existsSync(cookiesFile)) {
  const cookies: Cookie[] = JSON.parse(readFileSync(cookiesFile, 'utf8'));
  let ok = 0;
  for (const c of cookies) {
    if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax';
    try { await context.addCookies([c]); ok++; } catch {}
  }
  console.log(`loaded ${ok} cookies`);
}

const page = await context.newPage();
if (extDir) await page.waitForTimeout(1500);

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) {
  console.error('goto failed:', (e as Error).message);
}
try {
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, { timeout: 8000 });
} catch {}

console.log('finalUrl:', page.url());
console.log('title:', await page.title().catch(() => '?'));

if (doScroll) {
  for (const y of [400, 800]) {
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' }), y);
    await page.waitForTimeout(1500);
  }
  // Bring the first video into the middle of the viewport so
  // IntersectionObserver-driven autoplay actually fires.
  await page.evaluate(`(() => {
    const v = document.querySelector('video');
    if (v) window.scrollTo({ top: v.getBoundingClientRect().top + scrollY - innerHeight / 3, behavior: 'instant' });
  })()`);
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(seconds * 1000);

// Passed as a string: tsx's esbuild transform injects a __name helper into
// nested functions, which doesn't exist inside the page (Playwright serializes
// the function source verbatim).
const SAMPLE_JS = `(() => {
  const vids = [];
  const walk = (root) => {
    root.querySelectorAll('video').forEach((v) => vids.push(v));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);
  return {
    htmlAttrs: {
      stillOff: document.documentElement.hasAttribute('data-still-off'),
    },
    videos: vids.map((v, i) => ({
      i,
      paused: v.paused,
      currentTime: v.currentTime,
      muted: v.muted,
      autoplayAttr: v.hasAttribute('autoplay'),
      playsinline: v.hasAttribute('playsinline'),
      loop: v.loop,
      readyState: v.readyState,
      src: (v.currentSrc || v.src || '').slice(0, 120),
      userPlayMark: v.hasAttribute('data-still-user-play'),
      stillVideo: v.dataset.stillVideo || null,
      inViewport: (() => { const r = v.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; })(),
      rect: (() => { const r = v.getBoundingClientRect(); return { t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    })),
  };
})()`;

const sample = () => page.evaluate(SAMPLE_JS) as Promise<any>;

const s1 = await sample();
await page.waitForTimeout(2500);
const s2 = await sample();

console.log('data-still-off on <html>:', s2.htmlAttrs.stillOff);
console.log(`videos found: ${s2.videos.length}`);
for (const v of s2.videos) {
  const before = s1.videos[v.i];
  const advanced = before ? (v.currentTime - before.currentTime) : NaN;
  console.log(JSON.stringify({ ...v, advancedBy: Number(advanced.toFixed(2)) }));
}

// Count img replacements too, for context on whether the content script ran.
const imgStates = await page.evaluate(`(() => {
  const counts = {};
  document.querySelectorAll('img[data-still]').forEach((im) => {
    counts[im.dataset.still] = (counts[im.dataset.still] || 0) + 1;
  });
  return counts;
})()`);
console.log('img[data-still] counts (content script activity):', JSON.stringify(imgStates));
await context.close();
rmSync(userDataDir, { recursive: true, force: true });
