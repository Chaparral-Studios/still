#!/usr/bin/env node
// Headless "what actually moves, and does it stop?" probe. Never paints to a
// display.
//
// Two measurements, both taken with the extension optionally loaded:
//
//   1. SURVEY — scroll to a series of positions and, at each stop, hold the
//      scroll perfectly still while sampling every visible element twice.
//      Anything that changes between the samples is animating on its own.
//      Elements are tracked by a stamped identity, not by index, so DOM
//      insertions between samples don't register as phantom motion.
//
//   2. RESIDUAL — wheel-scroll a short burst, then STOP and keep sampling at
//      frame rate for a few seconds. Motion is measured document-relative (the
//      scroll offset is subtracted), so only real animation counts. A page
//      that settles when you stop scrolling scores ~0 here; a GSAP
//      ScrollTrigger `scrub` with smoothing keeps drifting for seconds.
//
// Also reports which animation libraries are present, since GSAP-style inline
// style writes are invisible to document.getAnimations() and therefore to the
// extension's cancelAnimations().
//
// Usage:
//   npx tsx tests/motion/diagnose-page-motion.mts --url <url> [--ext web-extension]
//     [--hold 1600] [--reduced]
//
// Run with and without --ext to see whether the extension changes anything.
import { chromium as rawChromium } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, rmSync } from 'node:fs';
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
const hold = parseInt(arg('hold', '1600')!, 10);
const reduced = process.argv.includes('--reduced');

const launchArgs = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio'];
if (extDir) launchArgs.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
const userDataDir = join(tmpdir(), `still-pagemotion-${process.pid}`);
mkdirSync(userDataDir, { recursive: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false, // real headless comes from --headless=new
  args: launchArgs,
  viewport: { width: 1280, height: 800 },
  reducedMotion: reduced ? 'reduce' : 'no-preference',
});
const page = await context.newPage();
if (extDir) await page.waitForTimeout(1500);
try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
catch (e) { console.error('goto failed:', (e as Error).message); }
try { await page.waitForFunction(() => (document.body?.innerText || '').length > 200, { timeout: 10000 }); } catch {}
await page.waitForTimeout(2000);

console.log('finalUrl:', page.url());
console.log('title:', await page.title().catch(() => '?'));
console.log('extension:', extDir ? 'LOADED' : 'none', '| reduced-motion:', reduced);

// --- which animation machinery is on the page? ---
const libs: any = await page.evaluate(`(() => ({
  gsap: typeof window.gsap, ScrollTrigger: typeof window.ScrollTrigger,
  webflowIx2: !!(window.Webflow && window.Webflow.require &&
    (() => { try { return !!window.Webflow.require('ix2'); } catch (e) { return false; } })()),
  lenis: typeof window.Lenis, locomotive: typeof window.LocomotiveScroll,
  motionOne: typeof window.Motion, anime: typeof window.anime,
  animScripts: [...document.querySelectorAll('script[src]')]
    .map((s) => s.src.split('/').pop())
    .filter((n) => /gsap|scrolltrigger|splittext|lottie|swiper|inertia|flip|draggable|lenis|locomotive|anime|motion/i.test(n)),
  waapiRunning: (document.getAnimations ? document.getAnimations({subtree:true}) : []).filter((x) => x.playState === 'running').length,
  smil: document.querySelectorAll('animate, animateTransform, animateMotion').length,
  lottiePlayers: document.querySelectorAll('dotlottie-player, lottie-player, [data-animation-type=lottie]').length,
  stillOff: document.documentElement.hasAttribute('data-still-off'),
  mainWorldPatch: typeof window.__stillCanvas,
  docHeight: document.documentElement.scrollHeight,
}))()`);
console.log('\n=== animation machinery ===');
console.log(JSON.stringify(libs, null, 2));

// --- 1. SURVEY: self-animation while scroll is pinned ---
const STAMP = `(() => {
  let n = 0;
  document.querySelectorAll('*').forEach((el) => { if (!el.__pid) el.__pid = 'p' + (n++); });
  window.__snap = () => {
    const m = {};
    document.querySelectorAll('*').forEach((el) => {
      if (!el.__pid) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (r.bottom < 0 || r.top > innerHeight) return;
      const cs = getComputedStyle(el);
      m[el.__pid] = [Math.round(r.left*10)/10, Math.round(r.top*10)/10,
        Math.round(r.width*10)/10, Math.round(r.height*10)/10,
        cs.transform, cs.opacity, cs.filter, cs.clipPath];
    });
    return m;
  };
  window.__desc = (pid) => {
    const el = [...document.querySelectorAll('*')].find((e) => e.__pid === pid);
    if (!el) return pid + ' (gone)';
    const cls = (typeof el.className === 'string' ? el.className
      : (el.className && el.className.baseVal) || '').split(/\\s+/).filter(Boolean).slice(0,3).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '')
      + ' | style=' + (el.getAttribute('style') || '').slice(0, 100)
      + ' | text=' + JSON.stringify((el.textContent || '').trim().slice(0, 28));
  };
})()`;

const FIELDS = ['left','top','width','height','transform','opacity','filter','clipPath'];
const stops = [0, 1200, 2400, 3600, 5000, 6700, 8300];
console.log('\n=== SURVEY: elements animating with the scroll held still ===');
for (const y of stops) {
  await page.evaluate(`window.scrollTo({top: ${y}, behavior: 'instant'})`);
  await page.waitForTimeout(900);
  await page.evaluate(STAMP);
  const s1: any = await page.evaluate(`window.__snap()`);
  await page.waitForTimeout(hold);
  const s2: any = await page.evaluate(`window.__snap()`);
  const movers: { pid: string; d: string[] }[] = [];
  for (const pid of Object.keys(s2)) {
    if (!s1[pid]) continue;
    const d: string[] = [];
    for (let i = 0; i < s2[pid].length; i++) {
      if (String(s1[pid][i]) === String(s2[pid][i])) continue;
      if (i <= 3 && Math.abs(Number(s1[pid][i]) - Number(s2[pid][i])) < 0.5) continue;
      d.push(`${FIELDS[i]}: ${String(s1[pid][i]).slice(0,40)} -> ${String(s2[pid][i]).slice(0,40)}`);
    }
    if (d.length) movers.push({ pid, d });
  }
  console.log(`\n--- scrollY=${y}: ${movers.length} elements moved on their own over ${hold}ms ---`);
  for (const m of movers.slice(0, 6)) {
    console.log(`  ${await page.evaluate(`window.__desc(${JSON.stringify(m.pid)})`)}`);
    m.d.forEach((x) => console.log(`      ${x}`));
  }
  if (movers.length > 6) console.log(`  ...and ${movers.length - 6} more`);
}

// --- 2. RESIDUAL: does motion continue after the wheel stops? ---
const SEL = arg('selector', '.helix_item, [class*=header_main], [class*=card], [class*=toast], .word')!;
const RECORD = `(() => {
  window.__rec = []; window.__recording = false;
  const step = () => {
    if (window.__recording) {
      const frame = [];
      document.querySelectorAll(${JSON.stringify(SEL)}).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.bottom < 0 || r.top > innerHeight) return;
        const cs = getComputedStyle(el);
        frame.push([i, Math.round(r.left), Math.round(r.top), Math.round(r.width),
          Math.round(r.height), cs.opacity.slice(0,4), cs.filter.slice(0,16)]);
      });
      window.__rec.push([Math.round(performance.now()), Math.round(window.scrollY), frame]);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})()`;
await page.evaluate(RECORD);
await page.evaluate(`window.scrollTo({top: 700, behavior: 'instant'})`);
await page.waitForTimeout(1200);
await page.evaluate(`window.__rec = []; window.__recording = true;`);
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(90); }
const stopAt: number = await page.evaluate(`Math.round(performance.now())`) as any;
await page.waitForTimeout(2500);   // wheel has stopped; anything moving is residual
await page.evaluate(`window.__recording = false;`);
const rec: any[] = await page.evaluate(`window.__rec`) as any;

const perEl = new Map<number, { pos: Set<string>; after: Set<string>; travel: number; last: number[] | null }>();
const scrollVals = new Set<number>();
for (const [t, sy, frame] of rec) {
  scrollVals.add(sy);
  for (const [i, l, tp, w, h, op, fil] of frame) {
    if (!perEl.has(i)) perEl.set(i, { pos: new Set(), after: new Set(), travel: 0, last: null });
    const e = perEl.get(i)!;
    const key = `${l},${tp + sy},${w},${h},${op},${fil}`;   // document-relative
    e.pos.add(key);
    if (t > stopAt) e.after.add(key);
    if (e.last) e.travel += Math.abs(l - e.last[0]) + Math.abs((tp + sy) - e.last[1]);
    e.last = [l, tp + sy];
  }
}
console.log(`\n=== RESIDUAL: motion after the wheel stopped (selector: ${SEL}) ===`);
console.log(`frames: ${rec.length}, distinct scrollY during burst: ${scrollVals.size}`);
const rows = [...perEl.entries()]
  .map(([i, e]) => ({ i, distinct: e.pos.size, after: e.after.size, travel: Math.round(e.travel) }))
  .sort((a, b) => b.after - a.after);
rows.slice(0, 12).forEach((r) =>
  console.log(`  el#${r.i}: distinctStates=${r.distinct} afterScrollStopped=${r.after} travel=${r.travel}px`));
const totalAfter = rows.reduce((s, r) => s + Math.max(0, r.after - 1), 0);
console.log(`TOTAL residual rendered states after scroll stopped (0 = page settles): ${totalAfter}`);

await context.close();
rmSync(userDataDir, { recursive: true, force: true });
