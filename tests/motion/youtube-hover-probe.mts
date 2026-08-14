// Does YouTube's hover preview survive the extension? Loads a YouTube page
// headlessly with the extension, hovers video thumbnails with real mouse
// moves (no clicks — hover must not count as a gesture), then reports every
// <video> (paused state, currentTime, data-still-user-play) AND every
// animated-thumbnail <img> (an_webp / .webp — channel pages hover-animate a
// WebP instead of, or before, a video preview).
// Usage: tsx youtube-hover-probe.mts [extDir] [seconds] [url]
import { chromium as rawChromium } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const chromium = addExtra(rawChromium);
chromium.use(StealthPlugin());

const extDir = resolve(process.argv[2] || 'web-extension');
const hoverSecs = parseInt(process.argv[3] || '6', 10);
// Search results rather than the homepage by default: logged-out, the
// homepage is an empty "Try searching" shell, while results always render
// thumbnails and hover-preview them.
const url = process.argv[4] || 'https://www.youtube.com/results?search_query=nature+documentary';

const context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'still-probe-')), {
  headless: false,
  args: [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
  ],
  viewport: { width: 1280, height: 800 },
});

// CDP pages report navigator.userActivation.isActive === true with zero
// input (see linkedin-video.spec.js) — stub it off to model a real hover,
// which grants no activation. STUB_ACTIVATION=0 disables the stub.
if (process.env.STUB_ACTIVATION !== '0') {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'userActivation', {
      get() { return { isActive: false, hasBeenActive: false }; }
    });
  });
}

await context.addInitScript(() => {
  const W = window as any;
  W.__playCalls = [];
  try {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      W.__playCalls.push({
        t: Math.round(performance.now()),
        activation: !!(navigator.userActivation && navigator.userActivation.isActive),
        src: (this.currentSrc || this.src || '').slice(0, 80),
      });
      return orig.apply(this, arguments as any);
    };
  } catch {}
});

const page = await context.newPage();
await page.waitForTimeout(1500);
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) { console.error('goto:', (e as Error).message); }
await page.waitForTimeout(4000);

// Dismiss the consent wall if one appears (EU/logged-out); a click here is
// fine — it's >2s before we hover.
for (const sel of ['button[aria-label*="Reject"]', 'button[aria-label*="Accept all"]']) {
  try { await page.click(sel, { timeout: 1500 }); console.log('consent clicked:', sel); break; } catch {}
}
await page.waitForTimeout(3000); // let any click-gesture window (2s) expire

// Old polymer markup (search/home) + new view-model markup (channel pages).
const thumbs = page.locator([
  'ytd-video-renderer a#thumbnail',
  'ytd-rich-item-renderer a#thumbnail',
  'ytd-compact-video-renderer a#thumbnail',
  'ytd-grid-video-renderer a#thumbnail',
  'yt-lockup-view-model yt-thumbnail-view-model',
  'ytm-shorts-lockup-view-model',
].join(', '));
const n = await thumbs.count();
console.log('thumbnails found:', n, '| title:', await page.title());

const snapshot = () => page.evaluate(() => {
  const W = window as any;
  return {
    playCalls: W.__playCalls,
    videos: [...document.querySelectorAll('video')].map((v) => ({
      paused: v.paused,
      currentTime: Math.round(v.currentTime * 100) / 100,
      userPlayMark: v.hasAttribute('data-still-user-play'),
      readyState: v.readyState,
      still: v.getAttribute('data-still-video') || v.getAttribute('data-still') || null,
      src: (v.currentSrc || v.src || '').slice(0, 90),
    })),
    // Replaced imgs carry the SVG placeholder as src, so they no longer
    // match the an_webp filter below — count them separately.
    replacedImgs: document.querySelectorAll('img[data-still="replaced"]').length,
    // Animated-thumbnail imgs: YouTube hover-swaps in an an_webp URL.
    animImgs: [...document.querySelectorAll('img')]
      .filter((im) => /an_webp|\.webp|\.gif/i.test(im.currentSrc || im.src || ''))
      .map((im) => ({
        still: im.getAttribute('data-still'),
        visible: !!(im.offsetWidth && getComputedStyle(im).visibility !== 'hidden'),
        src: (im.currentSrc || im.src || '').slice(0, 110),
      })),
  };
});

// CLICK_FIRST=1: reproduce the sticky-mark leak — click empty page space
// (a real pointerdown), hover a thumbnail inside the 2s gesture window so
// that preview legitimately plays and earns the mark, then check whether
// LATER hovers (far outside any gesture) also play on the reused element.
if (process.env.CLICK_FIRST === '1' && n > 0) {
  const box0 = await thumbs.nth(0).boundingBox();
  if (box0) {
    await page.mouse.click(640, 60); // masthead dead space — a gesture, no navigation
    console.log('clicked page, hovering inside gesture window...');
    await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2, { steps: 6 });
    await page.waitForTimeout(4000);
    console.log('in-window hover (mark expected):', JSON.stringify((await snapshot()).videos));
    await page.mouse.move(20, 500);
    await page.waitForTimeout(3000); // gesture window well expired
  }
}

for (let i = 0; i < Math.min(n, 3); i++) {
  const box = await thumbs.nth(i).boundingBox().catch(() => null);
  if (!box) continue;
  console.log(`hovering thumb ${i} for ${hoverSecs}s...`);
  // Real mouse moves, in steps, like a human sliding onto the thumbnail.
  await page.mouse.move(box.x - 40, box.y - 40);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await page.waitForTimeout(hoverSecs * 1000);
  console.log(JSON.stringify(await snapshot(), null, 1));
  await page.mouse.move(20, 500); // hover off between thumbs
  await page.waitForTimeout(800);
}
await context.close();
