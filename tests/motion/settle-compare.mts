// Does the page LAND where an unblocked browser would? Loads the same URL with
// and without the extension, lets everything settle, and compares the final
// rendered geometry of every visible element. Motion removed is only a win if
// the destination is unchanged.
import { chromium as rawChromium } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const chromium = addExtra(rawChromium); chromium.use(StealthPlugin());
function arg(n: string, f?: string) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i+1] : f; }
const url = arg('url')!;
// Keyed on content, not index: the two runs load different numbers of ad and
// analytics nodes, so element #90 is not the same element in both.
const SNAP = `(() => {
  const out = {}, dupes = new Set();
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const cls = (typeof el.className === 'string' ? el.className
      : (el.className && el.className.baseVal) || '').trim().split(/\\s+/).slice(0,3).join('.');
    const key = el.tagName + '|' + cls + '|' + (el.textContent || '').trim().slice(0, 60);
    if (key in out) { dupes.add(key); return; }
    const cs = getComputedStyle(el);
    out[key] = [Math.round(r.left), Math.round(r.top + scrollY),
      Math.round(r.width), Math.round(r.height), Number(cs.opacity).toFixed(2)];
  });
  dupes.forEach((k) => { delete out[k]; });
  return out;
})()`;
async function run(withExt: boolean) {
  const a = ['--headless=new','--disable-gpu','--hide-scrollbars','--mute-audio'];
  const ext = resolve('web-extension');
  if (withExt) a.push(`--disable-extensions-except=${ext}`, `--load-extension=${ext}`);
  const ud = join(tmpdir(), `still-cmp-${withExt}-${process.pid}`); mkdirSync(ud, { recursive: true });
  const ctx = await chromium.launchPersistentContext(ud, { headless: false, args: a, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  if (withExt) await page.waitForTimeout(1500);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  // Walk the page so scroll-triggered reveals all fire, then come back.
  for (const y of [800, 1600, 2400, 3200, 4000, 5000, 6000]) {
    await page.evaluate(`window.scrollTo({top:${y},behavior:'instant'})`);
    await page.waitForTimeout(500);
  }
  await page.evaluate(`window.scrollTo({top:0,behavior:'instant'})`);
  await page.waitForTimeout(2500);   // well past every settle timer
  const snap: any = await page.evaluate(SNAP);
  const stuck: any = await page.evaluate(`document.querySelectorAll('[data-still-motion]').length`);
  await ctx.close(); rmSync(ud, { recursive: true, force: true });
  return { snap, stuck };
}
const off = await run(false);
const on = await run(true);
const keys = Object.keys(off.snap).filter((k) => k in on.snap);
let moved = 0, faded = 0; const samples: string[] = [];
for (const k of keys) {
  const a = off.snap[k], b = on.snap[k];
  const dx = Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]);
  const dop = Math.abs(Number(a[4]) - Number(b[4]));
  if (dx > 4) { moved++; if (samples.length < 8) samples.push(`POS ${k.slice(0,70)}: ${a[0]},${a[1]} -> ${b[0]},${b[1]}`); }
  if (dop > 0.1) { faded++; if (samples.length < 12) samples.push(`OPACITY ${k.slice(0,70)}: ${a[4]} -> ${b[4]}`); }
}
console.log(`compared ${keys.length} elements (of ${Object.keys(off.snap).length} / ${Object.keys(on.snap).length})`);
console.log(`misplaced by >4px: ${moved}   opacity off by >0.1: ${faded}`);
console.log(`elements still marked data-still-motion after settle: ${on.stuck}`);
samples.forEach((s) => console.log('  ' + s));
