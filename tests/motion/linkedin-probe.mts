#!/usr/bin/env node
// One-off live probe for the LinkedIn scroll-autoplay report (2026-07-28).
// Headless (never paints). Loads the real extension + session cookies, scrolls
// the feed like a reading user, and logs every video play/pause event plus
// 1 Hz state samples — to observe whether an IntersectionObserver-triggered
// play slips past content.js on the real site.
// Usage: npx tsx tests/motion/linkedin-probe.mts

import { chromium as rawChromium, type Cookie } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const chromium = addExtra(rawChromium);
chromium.use(StealthPlugin());

const REPO = resolve(import.meta.dirname, '..', '..');
const EXT = join(REPO, 'web-extension');
const COOKIES = join(import.meta.dirname, 'cookies', 'linkedin.com.json');
const OUT = join(import.meta.dirname, 'reports', `linkedin-probe_${Date.now()}`);
mkdirSync(OUT, { recursive: true });

const viewport = { width: 1280, height: 800 };
// REUSE_USERDATA: path to a prior run's .userdata — carries the rotated (live)
// LinkedIn session, avoiding another cookie replay that would kill the session.
const reuseUserdata = process.env.REUSE_USERDATA;
const context = await chromium.launchPersistentContext(reuseUserdata || join(OUT, '.userdata'), {
  headless: false, // real headless comes from --headless=new; MV3 needs this combo
  args: [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  ],
  viewport,
  recordVideo: { dir: OUT, size: viewport },
});

if (!reuseUserdata && existsSync(COOKIES)) {
  const cookies: Cookie[] = JSON.parse(readFileSync(COOKIES, 'utf8'));
  for (const c of cookies) {
    if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax';
    try { await context.addCookies([c]); } catch {}
  }
}

const page = await context.newPage();
const consoleErrors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 200)));

// Main-world event log, installed before any page script runs.
await page.addInitScript(() => {
  const log: any[] = [];
  (window as any).__probeLog = log;
  const entry = (ev: Event, kind: string) => {
    const v = ev.target as HTMLVideoElement;
    if (!v || v.tagName !== 'VIDEO') return;
    log.push({
      t: Math.round(performance.now()),
      kind,
      src: (v.currentSrc || v.src || '').slice(0, 80),
      marked: v.hasAttribute('data-still-user-play'),
      activation: (navigator as any).userActivation?.isActive ?? null,
      currentTime: +v.currentTime.toFixed(2),
    });
  };
  document.addEventListener('play', (e) => entry(e, 'play'), true);
  document.addEventListener('pause', (e) => entry(e, 'pause'), true);
});

await page.waitForTimeout(1500); // extension service worker spin-up
await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(5000);

// Bail immediately if the session bounced to login — don't scroll a login
// page for 100 s or hammer a dead session.
const landing = await page.evaluate(() => location.href);
if (/\/login|\/checkpoint|\/authwall/.test(landing)) {
  await page.screenshot({ path: join(OUT, 'login-bounce.png') }).catch(() => {});
  console.log('BOUNCED to', landing);
  await context.close();
  process.exit(2);
}

const samples: any[] = [];
const sample = async (phase: string) => {
  const s = await page.evaluate(() => ({
    t: Math.round(performance.now()),
    scrollY: Math.round(window.scrollY),
    playPatched: !HTMLMediaElement.prototype.play.toString().includes('native code'),
    stillOff: document.documentElement.hasAttribute('data-still-off'),
    videos: [...document.querySelectorAll('video')].map((v) => ({
      playing: !v.paused && !v.ended,
      currentTime: +v.currentTime.toFixed(2),
      marked: v.hasAttribute('data-still-user-play'),
      top: Math.round(v.getBoundingClientRect().top),
      h: Math.round(v.getBoundingClientRect().height),
      src: (v.currentSrc || v.src || '').slice(0, 60),
    })),
  })).catch(() => null);
  if (s) samples.push({ phase, ...s });
};

// window.scrollBy doesn't move this page (scrollY pinned at 0 — LinkedIn
// scrolls an inner container). Instead, bring each video post into the
// viewport directly with scrollIntoView — still scripted, still zero user
// activation, and it guarantees the feed's IntersectionObserver sees it.
// Dwell 8 s per video, sampling at 1 Hz.
const scrollDiag = await page.evaluate(() => ({
  scrollHeight: document.documentElement.scrollHeight,
  htmlOverflow: getComputedStyle(document.documentElement).overflowY,
  bodyOverflow: getComputedStyle(document.body).overflowY,
}));
console.log('scrollDiag:', JSON.stringify(scrollDiag));

for (let round = 0; round < 8; round++) {
  const moved = await page.evaluate((idx) => {
    const vids = [...document.querySelectorAll('video')];
    const v = vids[idx];
    if (!v) return false;
    v.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    return true;
  }, round);
  if (!moved) break;
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1000);
    await sample(`video${round}`);
  }
}

const events = await page.evaluate(() => (window as any).__probeLog);
const pageInfo = await page.evaluate(() => ({
  url: location.href,
  bodyChars: document.body?.innerHTML.length ?? -1,
  bodyTextStart: (document.body?.innerText || '').slice(0, 200),
})).catch((e) => ({ error: String(e) }));
await page.screenshot({ path: join(OUT, 'final.png') }).catch(() => {});
writeFileSync(join(OUT, 'probe.json'), JSON.stringify({ pageInfo, consoleErrors: consoleErrors.slice(0, 30), events, samples }, null, 1));
console.log('pageInfo:', JSON.stringify(pageInfo));
console.log('consoleErrors:', consoleErrors.length);
console.log('events:', events.length, 'samples:', samples.length);
console.log('out:', OUT);
await context.close();
