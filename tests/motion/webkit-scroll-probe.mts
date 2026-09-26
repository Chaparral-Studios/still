// Headless WebKit (Safari engine) iPhone scroll probe. No display is ever used.
// WebKit speaks no DevTools protocol, so DataDome-walled sites (nytimes.com)
// load on a fresh IP where every Chromium/Playwright launch gets the captcha;
// hit such a site sparingly — 5 loads in 6 min flagged this IP for 30+ min.
// Scrolls with scrollBy (no real touch gestures — for finger-on-element
// gesture paths use diagnose-flicker.mts on a local fixture).
// Usage: npx tsx tests/motion/webkit-scroll-probe.mts --out <dir> [--url <u>] [--ext] [--toolbar] [--label <l>] [--state <cookies.json>]
// Injects main-world-patch.js + content.js at document start (Safari-style,
// via a mocked browser API), emulates an iPhone, scrolls down then up, and
// logs per-frame rendered-state changes of every element that received a
// style/class write, plus every data-still-* attribute change.
import { webkit, devices } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const url = arg('url', 'https://www.nytimes.com/')!;
const out = arg('out')!; mkdirSync(out, { recursive: true });
const label = arg('label', 'run')!;
const withExt = process.argv.includes('--ext');
const toolbar = process.argv.includes('--toolbar');
const screens = parseInt(arg('screens', '6')!, 10);
const EXT = resolve('web-extension');

const BROWSER_MOCK = `window.browser = { storage: { local: { get(k, cb) { cb({ enabled: true, allowlist: [] }); }, set() {} } },
  runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); }, getURL(p) { return 'ext://still/' + p; } } };`;

const INSTR = `(() => {
  const raf = window.requestAnimationFrame.bind(window);
  const ev = []; let phase = 'load';
  const ids = new WeakMap(); let nid = 1;
  const idOf = (el) => { let i = ids.get(el); if (!i) { i = nid++; ids.set(el, i); } return i; };
  const desc = (el) => { try { const tid = el.getAttribute('data-testid'); const cls = (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
    return el.tagName.toLowerCase() + '#' + idOf(el) + (el.id ? '@' + el.id : '') + (tid ? '[' + tid + ']' : '') + (cls ? '.' + cls : ''); } catch (e) { return '?'; } };
  const T = () => Math.round(performance.now());
  window.__mark = (s) => { phase = s; ev.push({ k: 'mark', t: T(), ph: s, y: Math.round(scrollY), ih: innerHeight }); };
  const tracked = new Set();
  const roots = [];
  window.__nyt = { ev, roots };
  const MEDIA_EVS = ['play', 'pause', 'playing', 'loadstart', 'emptied', 'waiting', 'canplay', 'error'];
  const rectOf = (el) => { try { const r = el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; } catch (e) { return null; } };
  const hookMedia = (root, tag) => { for (const n of MEDIA_EVS) root.addEventListener(n, (e) => { const v = e.target; if (!v || v.tagName !== 'VIDEO') return;
    ev.push({ k: 'ev:' + n, t: T(), ph: phase, el: desc(v), root: tag, paused: v.paused, rs: v.readyState, rect: rectOf(v), mark: v.hasAttribute('data-still-user-play'), auto: v.hasAttribute('autoplay') }); }, true); };
  const origPlay = HTMLMediaElement.prototype.play, origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.play = function () { const st = (new Error().stack || '').split(String.fromCharCode(10)).slice(1, 4).map((x) => x.trim().slice(0, 80)).join(' | ');
    const p = origPlay.apply(this, arguments); ev.push({ k: 'play()', t: T(), ph: phase, el: desc(this), rect: rectOf(this), stack: st });
    if (p && p.catch) p.catch((err) => ev.push({ k: 'play-rejected', t: T(), ph: phase, el: desc(this), err: String(err && err.name) })); return p; };
  HTMLMediaElement.prototype.pause = function () { const st = (new Error().stack || '').split(String.fromCharCode(10)).slice(1, 4).map((x) => x.trim().slice(0, 80)).join(' | ');
    ev.push({ k: 'pause()', t: T(), ph: phase, el: desc(this), stack: st }); return origPause.apply(this, arguments); };
  const origAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { const r = origAttach.call(this, init); ev.push({ k: 'shadow', t: T(), ph: phase, el: desc(this) }); roots.push(r);
    try { r.querySelectorAll('*').forEach((n) => tracked.add(n)); mo.observe(r, MO_OPTS); hookMedia(r, 'shadow:' + desc(this)); } catch (e) {} return r; };
  const MO_OPTS = { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['style', 'class', 'src', 'srcset', 'hidden', 'data-still-motion', 'data-still-hold', 'data-still-style', 'data-still', 'data-still-video', 'data-still-user-play', 'data-still-on', 'data-still-off', 'data-still-svg-settling'] };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type !== 'attributes') { for (const n of m.addedNodes) if (n.nodeType === 1) tracked.add(n); continue; }
      const el = m.target; if (el.nodeType !== 1) continue;
      const a = m.attributeName;
      if (a.startsWith('data-still')) { ev.push({ k: 'attr', t: T(), ph: phase, el: desc(el), a, v: el.getAttribute(a), old: m.oldValue }); continue; }
      if (a === 'src' || a === 'srcset' || a === 'hidden') { tracked.add(el); ev.push({ k: 'w', t: T(), ph: phase, el: desc(el), a, v: String(el.getAttribute(a) || '').slice(0, 100), old: String(m.oldValue || '').slice(0, 100) }); continue; }
      if (a === 'style' || a === 'class') { tracked.add(el); if (ev.length < 400000) ev.push({ k: 'w', t: T(), ph: phase, el: desc(el), a, v: String(el.getAttribute(a) || '').slice(0, 140), old: String(m.oldValue || '').slice(0, 140) }); }
    }
  });
  const start = () => { mo.observe(document.documentElement, MO_OPTS); hookMedia(document, 'doc'); };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  const last = new Map();
  function sample() {
    const t = T();
    for (const el of tracked) {
      if (!el.isConnected) { tracked.delete(el); last.delete(el); continue; }
      let r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width === 0 || r.height === 0 || r.bottom < -100 || r.top > innerHeight + 100) { last.delete(el); continue; }
      const cs = getComputedStyle(el);
      const fixedish = cs.position === 'fixed' || cs.position === 'sticky';
      const s = (el.tagName === 'VIDEO' ? (el.paused ? 'P' : 'PLAYING') + '|' : '') + cs.opacity + '|' + cs.transform + '|' + cs.visibility + '|' + cs.display + '|' + cs.position + '|' + Math.round(fixedish ? r.top : r.top + scrollY) + '|' + Math.round(r.height);
      const p = last.get(el);
      if (p !== undefined && p !== s) ev.push({ k: 'r', t, ph: phase, el: desc(el), from: p, to: s, vt: Math.round(r.top) });
      last.set(el, s);
    }
    raf(sample);
  }
  raf(sample);
})();`;

const browser = await webkit.launch({ headless: true });
const dev = devices['iPhone 15 Pro'];
const ctx = await browser.newContext({ ...dev, recordVideo: { dir: out, size: dev.viewport } });
await ctx.addInitScript({ content: INSTR });
if (withExt) {
  await ctx.addInitScript({ content: BROWSER_MOCK });
  await ctx.addInitScript({ content: readFileSync(join(EXT, 'main-world-patch.js'), 'utf8') });
  // WebKit runs init scripts before <html> exists; the real content script runs at document_start with it present.
  const cjs = readFileSync(join(EXT, 'content.js'), 'utf8');
  await ctx.addInitScript({ content: `(() => { const run = () => { ${cjs}\n }; if (document.documentElement) run(); else new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); run(); } }).observe(document, { childList: true }); })();` });
}
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.log('goto', e.message));
await page.waitForTimeout(5000);
console.log(`[${label}] title:`, await page.title(), 'imgs', await page.evaluate('document.images.length'), 'stillOn', await page.evaluate('document.documentElement.hasAttribute("data-still-on")'));
const mark = (s: string) => page.evaluate(`window.__mark(${JSON.stringify(s)})`).catch(() => {});
// iOS-like flick: ~18 frames of decaying scrollBy, then momentum tail.
const FLICK = `(dir, px) => new Promise((res) => { let i = 0, left = px; const steps = 24; const step = () => { const f = (steps - i) / (steps * (steps + 1) / 2); const d = Math.round(px * f * 2); scrollBy(0, dir * Math.min(d, left)); left -= d; i++; if (i < steps && left > 0) setTimeout(step, 16); else res(); }; step(); })`;
const vh = dev.viewport.height;
if (toolbar) await page.setViewportSize({ width: dev.viewport.width, height: vh - 84 });
await mark('down');
for (let i = 0; i < screens; i++) {
  await page.evaluate(`(${FLICK})(1, 700)`);
  if (toolbar && i === 0) await page.setViewportSize({ width: dev.viewport.width, height: vh });
  await page.waitForTimeout(900);
}
await mark('sit'); await page.waitForTimeout(2000);
await mark('up');
for (let i = 0; i < screens; i++) {
  await page.evaluate(`(${FLICK})(-1, 700)`);
  if (toolbar) await page.setViewportSize({ width: dev.viewport.width, height: i % 2 ? vh : vh - 84 });
  await page.waitForTimeout(900);
}
await mark('after'); await page.waitForTimeout(2500);
const ev: any[] = await page.evaluate('window.__nyt.ev');
writeFileSync(join(out, `events-${label}.json`), JSON.stringify(ev));
await ctx.close(); await browser.close();

// ---- summary ----
const by: Record<string, Record<string, number>> = {};
for (const e of ev) { (by[e.k] ||= {})[e.ph] = ((by[e.k] ||= {})[e.ph] || 0) + 1; }
console.log(`[${label}] events by kind/phase`, JSON.stringify(by));
const media = ev.filter((e) => /^(play|pause|ev:|shadow)/.test(e.k));
console.log(`[${label}] media/shadow events: ${media.length}`);
const mediaSum: Record<string, number> = {};
for (const e of media) { const key = `${e.ph} ${e.k} ${e.el}`; mediaSum[key] = (mediaSum[key] || 0) + 1; }
console.log(JSON.stringify(mediaSum, null, 0));
for (const e of media.filter((e) => e.ph === 'up' || e.ph === 'after').slice(0, 80)) console.log('   ', e.t, `[${e.ph}]`, e.k, e.el, e.root || '', e.rect ? 'rect=' + JSON.stringify(e.rect) : '', e.paused !== undefined ? 'paused=' + e.paused : '', e.err || '', e.stack ? '<< ' + e.stack.slice(0, 120) : '');
const attrs = ev.filter((e) => e.k === 'attr');
const attrSum: Record<string, number> = {};
for (const e of attrs) { const key = `${e.ph} ${e.a}=${e.v}`; attrSum[key] = (attrSum[key] || 0) + 1; }
console.log(`[${label}] data-still attrs:`, JSON.stringify(attrSum));
// Rendered-state changes per element in the up phase; reversals = returned to a state seen <600ms ago.
const perEl = new Map<string, any[]>();
for (const e of ev) if (e.k === 'r' && (e.ph === 'up' || e.ph === 'after')) (perEl.get(e.el) || perEl.set(e.el, []).get(e.el)!).push(e);
const rows: any[] = [];
for (const [el, list] of perEl) {
  let rev = 0;
  for (let i = 0; i < list.length; i++) for (let j = i - 1; j >= 0 && list[i].t - list[j].t < 600; j--) if (list[j].from === list[i].to) { rev++; break; }
  rows.push({ el, changes: list.length, reversals: rev, sample: list.slice(0, 6).map((e) => `${e.t}[${e.ph}] vt=${e.vt} ${e.from} -> ${e.to}`) });
}
rows.sort((a, b) => b.reversals - a.reversals || b.changes - a.changes);
console.log(`[${label}] elements changing rendered state during scroll-up: ${rows.length}`);
for (const r of rows.slice(0, 15)) console.log('  ', JSON.stringify(r));
