// Which writer sets data-still-user-play on ad videos? Records, per frame:
//  - every pointerdown/keydown/touchstart seen at document capture phase,
//    with isTrusted (content.js's gesture tracker has no isTrusted check)
//  - every HTMLMediaElement.play() call with navigator.userActivation.isActive
//    at call time (the main-world patch's criterion)
// Usage: tsx probe-userplay.mts <url> <extDir> [cookiesFile] [seconds]
import { chromium as rawChromium, type Cookie } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const chromium = addExtra(rawChromium);
chromium.use(StealthPlugin());

const url = process.argv[2] || 'https://www.whathifi.com';
const extDir = resolve(process.argv[3] || 'web-extension');
const cookiesFile = process.argv[4];
const seconds = parseInt(process.argv[5] || '60', 10);

const context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'still-probe-')), {
  headless: false,
  args: [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
  ],
  viewport: { width: 1280, height: 800 },
});

await context.addInitScript(() => {
  const W = window as any;
  W.__gestureEvts = [];
  W.__playCalls = [];
  ['pointerdown', 'keydown', 'touchstart', 'mousedown', 'click'].forEach((t) => {
    try {
      document.addEventListener(t, (e) => {
        W.__gestureEvts.push({ type: t, isTrusted: e.isTrusted, t: performance.now() });
      }, { capture: true, passive: true });
    } catch {}
  });
  try {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      W.__playCalls.push({
        t: performance.now(),
        activation: !!(navigator.userActivation && navigator.userActivation.isActive),
        src: (this.currentSrc || this.src || '').slice(0, 100),
        markAlready: this.hasAttribute && this.hasAttribute('data-still-user-play'),
      });
      return orig.apply(this, arguments as any);
    };
  } catch {}
});

if (cookiesFile && existsSync(cookiesFile)) {
  const cookies: Cookie[] = JSON.parse(readFileSync(cookiesFile, 'utf8'));
  for (const c of cookies) {
    if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax';
    try { await context.addCookies([c]); } catch {}
  }
}

const page = await context.newPage();
await page.waitForTimeout(1500);
try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { console.error('goto:', (e as Error).message); }
for (const y of [600, 1200, 2000, 1200]) {
  await page.waitForTimeout(3000);
  await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' }), y).catch(() => {});
}
await page.waitForTimeout(Math.max(1, seconds - 12) * 1000);

let framesSeen = 0;
let framesReported = 0;
for (const frame of page.frames()) {
  framesSeen++;
  try {
    const r = await Promise.race([
      frame.evaluate(() => {
        const W = window as any;
        const vids = [...document.querySelectorAll('video')].map((v) => ({
          paused: v.paused, userPlay: v.hasAttribute('data-still-user-play'),
          src: (v.currentSrc || v.src || '').slice(0, 100),
        }));
        return { evts: W.__gestureEvts || [], plays: W.__playCalls || [], vids };
      }),
      new Promise<null>((res) => setTimeout(() => res(null), 1500)),
    ]);
    if (r && (r.evts.length || r.plays.length || r.vids.length)) {
      framesReported++;
      console.log('FRAME', frame.url().slice(0, 130));
      console.log(JSON.stringify(r, null, 1));
    }
  } catch {}
}
console.log(`DONE frames=${framesSeen} reported=${framesReported}`);
await context.close();
