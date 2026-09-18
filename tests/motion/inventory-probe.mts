// After a sweep-like scroll (down 4, up 2), list every element that can move
// without DOM mutation: images in animated-capable formats (+ Still state),
// iframes, videos, canvases — with viewport rects. Headless, extension loaded.
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const url = process.argv[2];
const extDir = resolve('web-extension');
const ud = join(tmpdir(), `still-inv-${process.pid}`); mkdirSync(ud, { recursive: true });
const ctx = await chromium.launchPersistentContext(ud, { headless: false, args: ['--headless=new', '--disable-gpu', '--mute-audio', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
await page.waitForTimeout(4000);
const cdp = await ctx.newCDPSession(page);
const swipe = async (d: number) => { await cdp.send('Input.synthesizeScrollGesture', { x: 195, y: 500, yDistance: d, gestureSourceType: 'touch', speed: 1800 }); await page.waitForTimeout(800); };
for (let i = 0; i < 4; i++) await swipe(-700);
await page.waitForTimeout(4000);
for (let i = 0; i < 2; i++) await swipe(700);
await page.waitForTimeout(2000);
const inv = await page.evaluate(`(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.width), Math.round(r.height)]; };
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && r.width > 0; };
  const out = { scrollY: Math.round(scrollY), imgs: [], iframes: [], videos: [], canvases: [], bg: [] };
  document.querySelectorAll('img').forEach((im) => { if (!inView(im)) return; const src = im.currentSrc || im.src || ''; if (/\\.(gif|webp|avif|apng|png|svg)(\\?|$)/i.test(src) || !/\\.(jpe?g)(\\?|$)/i.test(src)) out.imgs.push({ rect: rect(im), still: im.dataset.still || null, src: src.slice(0, 110) }); });
  document.querySelectorAll('iframe').forEach((f) => out.iframes.push({ rect: rect(f), inView: inView(f), src: (f.src || '').slice(0, 110) }));
  document.querySelectorAll('video').forEach((v) => out.videos.push({ rect: rect(v), inView: inView(v), paused: v.paused, ct: v.currentTime, poster: (v.poster || '').slice(0, 80) }));
  document.querySelectorAll('canvas').forEach((c) => out.canvases.push({ rect: rect(c), inView: inView(c), still: c.getAttribute('data-still-canvas') }));
  // background images in animated-capable formats, in view
  document.querySelectorAll('*').forEach((el) => { if (!inView(el)) return; const bg = getComputedStyle(el).backgroundImage; if (bg && /\\.(gif|webp|avif|apng)/i.test(bg)) out.bg.push({ rect: rect(el), bg: bg.slice(0, 100) }); });
  return out;
})()`);
console.log(JSON.stringify(inv, null, 1));
await ctx.close(); rmSync(ud, { recursive: true, force: true }); process.exit(0);
