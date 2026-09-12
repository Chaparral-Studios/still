#!/usr/bin/env node
// Headless flicker diagnostic. Never paints to a display.
//
// Emulates an iPhone (viewport, touch, UA, optional reduced-motion), loads a
// URL with an optional extension dir, scrolls DOWN through the page with real
// synthesized touch gestures, then scrolls back UP, and records:
//   - every HTMLMediaElement.play() call (with caller stack) and every
//     play/pause/loadstart/waiting/emptied event on every <video>
//   - every attribute mutation (style/class/hidden/src/data-still*) whose
//     effect flips an element's computed visibility, opacity(0/1), or display
//   - every childList insertion/removal of <video>/<img>/<canvas>
// then reports elements that flipped state repeatedly inside a short window —
// the signature of a visible on/off flicker.
//
// Usage: npx tsx tests/motion/diagnose-flicker.mts --url <url> --out <dir>
//          [--ext <dir>] [--reduced-motion] [--screens <n>] [--label <name>]

import { chromium as rawChromium } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const chromium = addExtra(rawChromium);
chromium.use(StealthPlugin());

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg('url');
const outDir = arg('out');
if (!url || !outDir) { console.error('--url and --out required'); process.exit(1); }
mkdirSync(outDir, { recursive: true });
const extArg = arg('ext');
const extDir = extArg ? resolve(extArg) : null;
const reducedMotion = process.argv.includes('--reduced-motion');
const screens = parseInt(arg('screens', '6')!, 10);
const label = arg('label', extDir ? 'ext' : 'noext')!;
const autoplayPolicy = arg('autoplay-policy');

const VIEW = { width: 390, height: 844 };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

const launchArgs = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio'];
if (autoplayPolicy) launchArgs.push(`--autoplay-policy=${autoplayPolicy}`);
if (extDir) {
  launchArgs.push(`--disable-extensions-except=${extDir}`);
  launchArgs.push(`--load-extension=${extDir}`);
}

const userDataDir = join(tmpdir(), `still-flicker-${process.pid}`);
mkdirSync(userDataDir, { recursive: true });

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false, // real headless comes from --headless=new (see record.mts)
  args: launchArgs,
  viewport: VIEW,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: UA,
  reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  recordVideo: { dir: outDir, size: VIEW },
});

// Instrumentation. A plain string: tsx's esbuild transform injects a __name
// helper into nested functions that doesn't exist inside the page.
const INIT_JS = `(() => {
  const T0 = performance.timeOrigin;
  const ev = [];
  const ids = new WeakMap(); let nextId = 1;
  const idOf = (el) => { let i = ids.get(el); if (!i) { i = nextId++; ids.set(el, i); } return i; };
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return String(el);
    const tid = el.getAttribute && el.getAttribute('data-testid');
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
    return el.tagName.toLowerCase() + '#' + idOf(el) + (tid ? '[' + tid + ']' : '') + (cls ? '.' + cls : '');
  };
  const rectOf = (el) => { try { const r = el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.width), Math.round(r.height)]; } catch (e) { return null; } };
  let phase = 'load';
  const log = (o) => { o.t = Math.round(performance.now()); o.ph = phase; ev.push(o); };
  const roots = [document];
  window.__flick = { ev, desc, idOf, roots };
  const origAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const r = origAttach.call(this, init);
    log({ k: 'shadow', el: desc(this), mode: init && init.mode });
    roots.push(r);
    try { hookRoot(r); } catch (e) {}
    return r;
  };

  // --- media ---
  const SIM = '__SIM_STM__';
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const st = (new Error().stack || '').split('\\n').slice(2, 5).map(s => s.trim().slice(0, 90)).join(' | ');
    log({ k: 'play()', el: desc(this), paused: this.paused, rs: this.readyState, rect: rectOf(this), stack: st,
          mark: this.hasAttribute('data-still-user-play') });
    if (SIM === 'reject') {
      // StopTheMadness-style: refuse ungestured playback the way the browser's
      // autoplay policy would — no state change, rejected promise.
      log({ k: 'sim:reject', el: desc(this) });
      return Promise.reject(new DOMException('play() failed because the user did not interact with the document first.', 'NotAllowedError'));
    }
    const p = origPlay.apply(this, arguments);
    if (SIM === 'pause') {
      // Blocker that lets play() through and pauses on the play event instead.
      const v = this;
      log({ k: 'sim:pause', el: desc(v) });
      setTimeout(() => { try { v.pause(); } catch (e) {} }, 0);
    }
    return p;
  };
  const origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function () {
    const st = (new Error().stack || '').split('\\n').slice(2, 5).map(s => s.trim().slice(0, 90)).join(' | ');
    log({ k: 'pause()', el: desc(this), paused: this.paused, rs: this.readyState, stack: st });
    return origPause.apply(this, arguments);
  };
  const MEDIA_EVS = ['play', 'pause', 'playing', 'waiting', 'loadstart', 'emptied', 'stalled', 'canplay', 'ended', 'error'];
  const hookMedia = (root) => { for (const name of MEDIA_EVS) {
    root.addEventListener(name, (e) => {
      const v = e.target;
      if (!v || v.tagName !== 'VIDEO') return;
      if (SIM === 'still' && name === 'play' && !v.hasAttribute('data-still-user-play')) {
        // Still's own content.js pattern: synchronous pause inside the
        // capture-phase play event (as if it could see shadow-DOM videos).
        log({ k: 'sim:still-pause', el: desc(v) });
        try { v.pause(); } catch (err) {}
      }
      log({ k: 'ev:' + name, el: desc(v), paused: v.paused, rs: v.readyState, ct: Math.round(v.currentTime * 1000) / 1000,
            rect: rectOf(v), mark: v.hasAttribute('data-still-user-play'), src: (v.currentSrc || '').slice(0, 80),
            root: root === document ? 'doc' : 'shadow' });
    }, true);
  } };
  hookMedia(document);

  // --- visual state flips ---
  const state = new WeakMap(); // el -> [visibility, opacity, display]
  const snap = (el) => {
    try {
      const cs = getComputedStyle(el);
      return [cs.visibility, cs.opacity === '0' ? '0' : (cs.opacity === '1' ? '1' : 'mid'), cs.display === 'none' ? 'none' : 'shown'];
    } catch (e) { return null; }
  };
  const check = (el, attr, oldV) => {
    const s = snap(el); if (!s) return;
    const prev = state.get(el);
    state.set(el, s);
    if (!prev) return;
    if (prev[0] !== s[0] || prev[1] !== s[1] || prev[2] !== s[2]) {
      log({ k: 'flip', el: desc(el), attr, from: prev.join('/'), to: s.join('/'), rect: rectOf(el),
            newVal: attr === 'style' || attr === 'class' ? String(el.getAttribute(attr) || '').slice(0, 160) : undefined,
            oldVal: oldV == null ? undefined : String(oldV).slice(0, 160) });
    }
  };
  const seed = (root) => { try { root.querySelectorAll('*').forEach((el) => { if (!state.has(el)) { const s = snap(el); if (s) state.set(el, s); } }); } catch (e) {} };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        check(m.target, m.attributeName, m.oldValue);
      } else if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (/^(VIDEO|IMG|CANVAS|svg)$/i.test(n.tagName) || (n.querySelector && n.querySelector('video,canvas,svg'))) {
            log({ k: 'add', el: desc(n), rect: rectOf(n), inner: /^(VIDEO|svg)$/i.test(n.tagName) ? '' : Array.from(n.querySelectorAll('video,canvas,svg')).map(desc).slice(0, 5).join(',') });
          }
          seed(n); const s = snap(n); if (s) state.set(n, s);
        }
        for (const n of m.removedNodes) {
          if (n.nodeType !== 1) continue;
          if (/^(VIDEO|IMG|CANVAS)$/.test(n.tagName) || (n.querySelector && n.querySelector('video,canvas'))) {
            log({ k: 'remove', el: desc(n), inner: n.tagName === 'VIDEO' ? '' : Array.from(n.querySelectorAll('video,canvas')).map(desc).join(',') });
          }
        }
      }
    }
  });
  const MO_OPTS = { subtree: true, childList: true, attributes: true, attributeOldValue: true,
      attributeFilter: ['style', 'class', 'hidden', 'src', 'srcset', 'autoplay', 'data-still', 'data-still-canvas', 'data-still-svg-settling', 'data-still-video', 'data-still-user-play', 'data-still-style', 'data-still-motion'] };
  const hookRoot = (r) => { seed(r); mo.observe(r, MO_OPTS); hookMedia(r); };
  const start = () => { seed(document); mo.observe(document.documentElement, MO_OPTS); };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  window.addEventListener('resize', () => log({ k: 'resize', ih: innerHeight, iw: innerWidth }));
  window.__flickMark = (s) => { phase = s; log({ k: 'mark', note: s, scrollY: Math.round(scrollY), ih: innerHeight }); };
  window.__flickVideos = () => {
    const out = [];
    for (const r of roots) r.querySelectorAll('video').forEach((v) => out.push({ el: desc(v), root: r === document ? 'doc' : 'shadow',
      paused: v.paused, rs: v.readyState, ct: Math.round(v.currentTime * 100) / 100, mark: v.hasAttribute('data-still-user-play'),
      autoplay: v.hasAttribute('autoplay'), cls: v.className, vis: getComputedStyle(v).visibility, op: getComputedStyle(v).opacity,
      rect: rectOf(v), src: (v.currentSrc || '').slice(0, 90) }));
    return out;
  };
})();`;

await context.addInitScript(INIT_JS.replace('__SIM_STM__', arg('sim-stm', 'none')!));
const page = await context.newPage();
if (extDir) await page.waitForTimeout(1500);

const cdp = await context.newCDPSession(page);
async function swipe(direction: 'up' | 'down', px: number, x = 195, y = 500) {
  // Real touch scroll gesture: fires touchstart/touchmove/touchend like a finger.
  // Scrolling "down" the page = content moves up = negative yDistance.
  await cdp.send('Input.synthesizeScrollGesture', {
    x, y, yDistance: direction === 'down' ? -px : px,
    gestureSourceType: 'touch', speed: 1800,
  });
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) {
  console.error('goto failed:', (e as Error).message);
}
try { await page.waitForFunction(() => (document.body?.innerText || '').length > 200, { timeout: 8000 }); } catch {}
console.log(`[${label}] finalUrl:`, page.url());
console.log(`[${label}] title:`, await page.title().catch(() => '?'));
await page.waitForTimeout(4000);

const mark = (s: string) => page.evaluate((ss) => (window as any).__flickMark?.(ss), s).catch(() => {});

const toolbar = process.argv.includes('--toolbar');
const setH = async (h: number) => {
  // iOS Safari collapses its toolbar on scroll-down (viewport grows) and
  // re-expands it on scroll-up (viewport shrinks); emulate with a real
  // viewport resize so resize/matchMedia/IntersectionObserver all fire.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: h, deviceScaleFactor: 3, mobile: true });
};
const sampleVideos = async (note: string) => {
  const v = await page.evaluate('window.__flickVideos()').catch(() => []);
  console.log(`[${label}] videos @${note}:`, JSON.stringify(v));
};
await sampleVideos('loaded');
await mark('scroll-down');
for (let i = 0; i < screens; i++) {
  await swipe('down', 700);
  if (toolbar && i === 0) await setH(VIEW.height + 90);
  await page.waitForTimeout(900);
}
await sampleVideos('after-down');
await mark('sit');
await page.waitForTimeout(2500);
await mark('scroll-up');
for (let i = 0; i < screens; i++) {
  // Alternate the finger's start point: on the page's midline vs near the
  // edge, so gesture-scoped play authorization is exercised both ways.
  await swipe('up', 700, i % 2 ? 40 : 195, i % 2 ? 700 : 450);
  if (toolbar) await setH(i % 2 ? VIEW.height + 90 : VIEW.height);
  await page.waitForTimeout(900);
}
await mark('after-up');
await sampleVideos('after-up');
await page.waitForTimeout(3000);

const dump = await page.evaluate(`(() => {
  const vids = window.__flickVideos();
  return { events: window.__flick.ev, videos: vids, shadowRoots: window.__flick.roots.length - 1, stillOff: document.documentElement.hasAttribute('data-still-off'),
           counts: { img: document.images.length, video: document.querySelectorAll('video').length,
                     canvas: document.querySelectorAll('canvas').length,
                     stillReplaced: document.querySelectorAll('[data-still="replaced"]').length,
                     stillProbing: document.querySelectorAll('[data-still="probing"]').length,
                     stillStatic: document.querySelectorAll('[data-still="static"]').length,
                     pinned: document.querySelectorAll('[data-still-style]').length } };
})()`) as any;

writeFileSync(join(outDir, `events-${label}.json`), JSON.stringify(dump, null, 1));

// --- summary ---
const ev: any[] = dump.events;
const byKind: Record<string, Record<string, number>> = {};
for (const e of ev) { const k = byKind[e.k] || (byKind[e.k] = {}); k[e.ph] = (k[e.ph] || 0) + 1; }
console.log(`[${label}] counts:`, JSON.stringify(dump.counts), 'stillOff=', dump.stillOff, 'shadowRoots=', dump.shadowRoots);
console.log(`[${label}] event kinds by phase:`, JSON.stringify(byKind));
console.log(`[${label}] videos at end:`, JSON.stringify(dump.videos, null, 0));

// Elements that flipped visual state repeatedly: >= 3 flips inside any 1500ms window.
const flips = new Map<string, any[]>();
for (const e of ev) if (e.k === 'flip') { if (!flips.has(e.el)) flips.set(e.el, []); flips.get(e.el)!.push(e); }
const flicker: any[] = [];
for (const [el, list] of flips) {
  let best = 0;
  for (let i = 0; i < list.length; i++) {
    let j = i; while (j < list.length && list[j].t - list[i].t <= 1500) j++;
    best = Math.max(best, j - i);
  }
  if (best >= 2) flicker.push({ el, total: list.length, maxIn1500ms: best, sample: list.slice(0, 8).map((f) => `${f.t}ms[${f.ph}] ${f.from}->${f.to} via ${f.attr} rect=${JSON.stringify(f.rect)}`) });
}
flicker.sort((a, b) => b.maxIn1500ms - a.maxIn1500ms);
console.log(`[${label}] repeated flippers (${flicker.length}):`);
for (const f of flicker.slice(0, 12)) console.log('  ', JSON.stringify(f));

// Media timeline
const media = ev.filter((e) => /^(play\(\)|pause\(\)|ev:|resize|shadow)/.test(e.k) || e.k === 'mark');
console.log(`[${label}] media timeline (${media.length} entries, first 120):`);
for (const e of media.slice(0, 120)) console.log('  ', e.t, `[${e.ph}]`, e.k, e.el || e.note || '', e.root || '', e.stack ? '<< ' + e.stack.slice(0, 110) : '', e.rect ? 'rect=' + JSON.stringify(e.rect) : '', e.mark ? 'MARK' : '', e.ih ? 'ih=' + e.ih : '', e.paused !== undefined ? 'paused=' + e.paused : '');
// Flips during scroll-up, by element
const upFlips = ev.filter((e) => e.k === 'flip' && e.ph !== 'load');
console.log(`[${label}] flips after load: ${upFlips.length}`);
for (const f of upFlips.slice(0, 60)) console.log('  ', f.t, `[${f.ph}]`, f.el.slice(0, 80), f.attr, f.from, '->', f.to, 'rect=' + JSON.stringify(f.rect), (f.newVal || '').slice(0, 80));
const svgAdds = ev.filter((e) => e.k === 'add' && /svg/i.test(e.el + (e.inner || '')));
console.log(`[${label}] svg insertions by phase:`, JSON.stringify(svgAdds.reduce((a: any, e) => { a[e.ph] = (a[e.ph] || 0) + 1; return a; }, {})));

await context.close();
rmSync(userDataDir, { recursive: true, force: true });
