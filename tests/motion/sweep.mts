#!/usr/bin/env node
// Site sweep: measure residual motion under the CURRENT extension tree on a
// list of real sites, headlessly, iPhone-emulated. Never paints to a display.
//
// Per site: load, scroll down with touch gestures, SIT (measure), scroll
// back up, SIT (measure). Channels measured during the sit windows:
//   - videos with advancing currentTime (document + shadow roots)
//   - running animations (CSS animations / transitions / WAAPI), doc + roots
//   - requestAnimationFrame callbacks per second
//   - DOM attribute/childList mutations per second (timer-driven updates)
//   - canvas draw calls per second, and whether Still froze the canvas
//   - repeated visibility/opacity/display flips (the on/off strobe signature)
//   - frame-diff of the screen recording during the sit windows (catch-all)
// Writes reports/sweep_<stamp>/{<host>.json, summary.md, summary.json}.
//
// Usage: npx tsx tests/motion/sweep.mts [--sites tests/motion/sweep-sites.json]
//        [--ext web-extension] [--concurrency 3] [--limit N] [--only host,host]

import { chromium as rawChromium } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const chromium = addExtra(rawChromium);
chromium.use(StealthPlugin());

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const sitesFile = arg('sites', 'tests/motion/sweep-sites.json')!;
const extDir = resolve(arg('ext', 'web-extension')!);
const concurrency = parseInt(arg('concurrency', '3')!, 10);
const limit = parseInt(arg('limit', '0')!, 10);
const only = arg('only');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
const outDir = resolve(arg('out', `tests/motion/reports/sweep_${stamp}`)!);
mkdirSync(outDir, { recursive: true });

let sites: { host: string; src: string[] }[] = JSON.parse(readFileSync(sitesFile, 'utf8'));
if (only) sites = sites.filter((s) => only.split(',').includes(s.host));
if (limit) sites = sites.slice(0, limit);

const VIEW = { width: 390, height: 844 };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const SIT_MS = 4000;

// Plain string: tsx injects a __name helper into nested functions otherwise.
const INIT_JS = `(() => {
  const roots = [];
  const M = { raf: 0, mut: 0, draws: 0, flips: [] };
  const ids = new WeakMap(); let nid = 1;
  const idOf = (el) => { let i = ids.get(el); if (!i) { i = nid++; ids.set(el, i); } return i; };
  const desc = (el) => {
    try {
      if (!el || el.nodeType !== 1) return String(el);
      const tid = el.getAttribute && (el.getAttribute('data-testid') || el.id);
      const cls = (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
      const r = el.getBoundingClientRect();
      return el.tagName.toLowerCase() + '#' + idOf(el) + (tid ? '[' + tid + ']' : '') + (cls ? '.' + cls : '') + ' @' + Math.round(r.top) + ',' + Math.round(r.left) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
    } catch (e) { return '?'; }
  };
  window.__sweep = { M, roots, desc };
  const origAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { const r = origAttach.call(this, init); roots.push(r); try { observe(r); } catch (e) {} return r; };
  const origRAF = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { return origRAF.call(window, function (t) { M.raf++; return cb(t); }); };
  const wrapDraw = (proto, names) => { for (const n of names) { const o = proto && proto[n]; if (typeof o !== 'function') continue; proto[n] = function () { M.draws++; return o.apply(this, arguments); }; } };
  try { wrapDraw(CanvasRenderingContext2D.prototype, ['drawImage', 'fillRect', 'clearRect', 'putImageData', 'fill', 'stroke']); } catch (e) {}
  try { wrapDraw(WebGLRenderingContext.prototype, ['drawArrays', 'drawElements']); } catch (e) {}
  try { wrapDraw(WebGL2RenderingContext.prototype, ['drawArrays', 'drawElements']); } catch (e) {}
  // flips: visibility/opacity/display changes on style/class/hidden writes
  const state = new WeakMap();
  const snap = (el) => { try { const cs = getComputedStyle(el); return cs.visibility + '/' + (cs.opacity === '0' ? '0' : cs.opacity === '1' ? '1' : 'mid') + '/' + (cs.display === 'none' ? 'none' : 'shown'); } catch (e) { return null; } };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      M.mut++;
      if (m.type === 'attributes' && (m.attributeName === 'style' || m.attributeName === 'class' || m.attributeName === 'hidden')) {
        const el = m.target; const s = snap(el); if (!s) continue;
        const p = state.get(el); state.set(el, s);
        if (p && p !== s) { M.flips.push({ t: Math.round(performance.now()), el: idOf(el), from: p, to: s, d: desc(el) }); if (M.flips.length > 5000) M.flips.shift(); }
      }
    }
  });
  const observe = (root) => mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'src', 'd', 'transform', 'points'] });
  const start = () => { try { observe(document.documentElement); } catch (e) {} };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  // declarative roots + late discovery
  window.__sweep.allRoots = () => { const out = new Set(roots); try { document.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) out.add(el.shadowRoot); }); } catch (e) {} return [...out]; };
  window.__sweep.reset = () => { M.raf = 0; M.mut = 0; M.draws = 0; M.flips.length = 0; };
  window.__sweep.report = () => {
    const rootsAll = window.__sweep.allRoots();
    const vids = [];
    const scan = (r) => { try { r.querySelectorAll('video').forEach((v) => vids.push(v)); } catch (e) {} };
    scan(document); rootsAll.forEach(scan);
    const videos = vids.map((v) => ({ d: desc(v), paused: v.paused, ct: Math.round(v.currentTime * 100) / 100, mark: v.hasAttribute('data-still-user-play'), inView: (() => { const r = v.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; })() }));
    const anims = [];
    const add = (a, where) => { try {
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
      if (a.playState !== 'running') return;
      anims.push({ kind: a.constructor.name, name: a.animationName || a.transitionProperty || '', iter: t.iterations, dur: t.duration, el: desc(a.effect && a.effect.target), where });
    } catch (e) {} };
    try { document.getAnimations().forEach((a) => add(a, 'doc')); } catch (e) {}
    for (const r of rootsAll) { try { for (const c of r.children) c.getAnimations({ subtree: true }).forEach((a) => add(a, 'shadow')); } catch (e) {} }
    const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => ({ d: desc(c), still: c.getAttribute('data-still-canvas') }));
    // repeated flippers: >=3 flips on one element inside 1500ms
    const byEl = {}; for (const f of M.flips) (byEl[f.el] = byEl[f.el] || []).push(f);
    const repeated = [];
    for (const k in byEl) { const l = byEl[k]; let best = 0; for (let i = 0; i < l.length; i++) { let j = i; while (j < l.length && l[j].t - l[i].t <= 1500) j++; best = Math.max(best, j - i); } if (best >= 3) repeated.push({ d: l[0].d, n: l.length, maxIn1500: best }); }
    return { raf: M.raf, mut: M.mut, draws: M.draws, flips: M.flips.length, repeated, videos, anims, canvases, shadowRoots: rootsAll.length,
             stillOn: document.documentElement.hasAttribute('data-still-on'), mwp: document.documentElement.getAttribute('data-still-mwp') === 'loaded',
             title: document.title, text: (document.body && document.body.innerText || '').length };
  };
})();`;

type SiteResult = any;

async function runSite(site: { host: string; src: string[] }): Promise<SiteResult> {
  const host = site.host;
  const siteDir = join(outDir, host.replace(/[^a-z0-9.-]/gi, '_'));
  mkdirSync(siteDir, { recursive: true });
  // Resume: a site with a finished result.json is reused as-is.
  const prior = join(siteDir, 'result.json');
  if (existsSync(prior)) {
    try { const r = JSON.parse(readFileSync(prior, 'utf8')); if (r && r.issues) { r.resumed = true; return r; } } catch (e) {}
  }
  const userDataDir = join(tmpdir(), `still-sweep-${process.pid}-${host.replace(/[^a-z0-9]/gi, '_')}`);
  mkdirSync(userDataDir, { recursive: true });
  const res: SiteResult = { host, src: site.src, url: `https://${host}/`, ok: false };
  const t0 = Date.now();
  let context: any = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
      viewport: VIEW, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA,
      recordVideo: { dir: siteDir, size: VIEW },
    });
    await context.addInitScript(INIT_JS);
    // Session cookies captured by decrypt-chrome-cookies.mts, keyed by host
    // (sans www.) like run.sh does.
    try {
      const ck = resolve('tests/motion/cookies', host.replace(/^www\./, '') + '.json');
      if (existsSync(ck)) {
        const cookies = JSON.parse(readFileSync(ck, 'utf8'));
        let n = 0;
        for (const c of cookies) { if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax'; try { await context.addCookies([c]); n++; } catch (e) {} }
        res.cookies = n;
      }
    } catch (e) {}
    const page = await context.newPage();
    const vidStart = Date.now();
    await page.waitForTimeout(1200);
    const cdp = await context.newCDPSession(page);
    const swipe = async (dir: 'up' | 'down') => {
      try { await cdp.send('Input.synthesizeScrollGesture', { x: 195, y: 500, yDistance: dir === 'down' ? -700 : 700, gestureSourceType: 'touch', speed: 1800 }); } catch (e) {}
    };
    try { await page.goto(res.url, { waitUntil: 'domcontentloaded', timeout: 40000 }); }
    catch (e) { res.gotoError = String((e as Error).message).slice(0, 120); }
    res.finalUrl = page.url();
    await page.waitForTimeout(4000);
    const sit = async (label: string) => {
      await page.evaluate('window.__sweep.reset()').catch(() => {});
      const s = (Date.now() - vidStart) / 1000;
      await page.waitForTimeout(SIT_MS);
      const r = await page.evaluate('window.__sweep.report()').catch((e: any) => ({ error: String(e.message).slice(0, 100) }));
      res[label] = { ...r, videoWindow: [s, SIT_MS / 1000] };
    };
    for (let i = 0; i < 4; i++) { await swipe('down'); await page.waitForTimeout(800); }
    await sit('sitA');
    for (let i = 0; i < 2; i++) { await swipe('up'); await page.waitForTimeout(800); }
    await sit('sitB');
    res.ok = true;
    const v = page.video();
    await context.close(); context = null;
    // frame-diff over the sit windows
    try {
      const vp = await v?.path();
      if (vp && existsSync(vp)) {
        for (const label of ['sitA', 'sitB']) {
          const [s, d] = res[label].videoWindow;
          const outTxt = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(s + 0.3), '-t', String(d - 0.6), '-i', vp, '-vf', 'tblend=all_mode=difference,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          const ys = [...outTxt.matchAll(/YAVG=([\d.]+)/g)].map((m) => parseFloat(m[1])).slice(1);
          res[label].frameDiffMean = ys.length ? Math.round((ys.reduce((a, b) => a + b, 0) / ys.length) * 100) / 100 : null;
          res[label].frameDiffMax = ys.length ? Math.round(Math.max(...ys) * 100) / 100 : null;
          res[label].framesChanged = ys.filter((y) => y > 1.5).length;
        }
        // recording kept (small): spot-check a flagged site by eye-free frame diff
      }
    } catch (e) { res.ffmpegError = String((e as Error).message).slice(0, 120); }
  } catch (e) {
    res.error = String((e as Error).message).slice(0, 200);
  } finally {
    try { if (context) await context.close(); } catch (e) {}
    rmSync(userDataDir, { recursive: true, force: true });
  }
  res.seconds = Math.round((Date.now() - t0) / 1000);
  // classify
  const t = res.sitB && !res.sitB.error ? res.sitB : res.sitA;
  const issues: string[] = [];
  if (t && !t.error) {
    const blocked = /just a moment|access denied|attention required|are you a human|verify you are|captcha|403|unusual traffic/i.test(t.title || '') || (t.text < 80 && !res.gotoError);
    res.blocked = blocked;
    const playing = (t.videos || []).filter((v: any) => !v.paused && !v.mark);
    if (playing.length) issues.push(`VIDEO playing x${playing.length}`);
    const infinite = (t.anims || []).filter((a: any) => a.iter === Infinity);
    const finite = (t.anims || []).filter((a: any) => a.iter !== Infinity);
    if (infinite.length) issues.push(`ANIM infinite x${infinite.length}`);
    if (finite.length) issues.push(`anim finite x${finite.length}`);
    if (t.repeated && t.repeated.length) issues.push(`STROBE x${t.repeated.length}`);
    const rafps = t.raf / (SIT_MS / 1000), mutps = t.mut / (SIT_MS / 1000), drawps = t.draws / (SIT_MS / 1000);
    const visual = t.frameDiffMean != null && t.frameDiffMean >= 0.5;
    if (rafps >= 20 && mutps >= 5 && visual) issues.push(`JS-MOTION raf ${Math.round(rafps)}/s mut ${Math.round(mutps)}/s`);
    else if (rafps >= 20 || mutps >= 5) issues.push(`js-activity raf ${Math.round(rafps)}/s mut ${Math.round(mutps)}/s`);
    const unfrozen = (t.canvases || []).filter((c: any) => !c.still).length;
    if (drawps >= 30 && unfrozen) issues.push(`CANVAS drawing ${Math.round(drawps)}/s`);
    if (t.frameDiffMean != null && t.frameDiffMean >= 0.5) issues.push(`VISUAL diff ${t.frameDiffMean}`);
    if (!t.stillOn) issues.push('still-not-on');
    if (!t.mwp) issues.push('main-world-missing');
  }
  res.issues = issues;
  writeFileSync(join(siteDir, 'result.json'), JSON.stringify(res, null, 1));
  return res;
}

const results: SiteResult[] = [];
let idx = 0;
async function worker() {
  while (idx < sites.length) {
    const site = sites[idx++];
    const n = idx;
    const r = await runSite(site);
    results.push(r);
    const flag = r.blocked ? 'BLOCKED' : (r.error ? 'ERROR' : (r.issues.length ? r.issues.join('; ') : 'clean'));
    console.log(`[${n}/${sites.length}] ${site.host.padEnd(36)} ${String(r.seconds).padStart(3)}s  ${flag}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

// summary
const sev = (r: SiteResult) => {
  if (r.error || r.blocked) return -1;
  let s = 0;
  for (const i of r.issues) { if (/^VIDEO|^STROBE|^ANIM infinite/.test(i)) s += 10; else if (/^JS-MOTION|^CANVAS|^VISUAL/.test(i)) s += 5; else s += 1; }
  return s;
};
results.sort((a, b) => sev(b) - sev(a) || a.host.localeCompare(b.host));
const lines = ['# Still motion sweep', '', `Extension: ${extDir}`, `Sites: ${results.length}  Date: ${new Date().toISOString()}`, '',
  '| # | site | source | verdict | detail |', '|---|---|---|---|---|'];
results.forEach((r, i) => {
  const t = r.sitB && !r.sitB.error ? r.sitB : r.sitA;
  const detail: string[] = [];
  if (t && !t.error) {
    for (const v of (t.videos || []).filter((v: any) => !v.paused && !v.mark).slice(0, 2)) detail.push(`video ${v.d}`);
    for (const a of (t.anims || []).slice(0, 3)) detail.push(`${a.kind}${a.name ? ':' + a.name : ''}${a.iter === Infinity ? '∞' : ''} ${a.where} ${a.el}`);
    for (const f of (t.repeated || []).slice(0, 2)) detail.push(`strobe ${f.d} ×${f.maxIn1500}/1.5s`);
    detail.push(`raf ${Math.round(t.raf / 4)}/s mut ${Math.round(t.mut / 4)}/s draws ${Math.round(t.draws / 4)}/s diff ${t.frameDiffMean ?? '-'} roots ${t.shadowRoots}`);
  }
  const verdict = r.error ? 'error' : r.blocked ? 'blocked' : (r.issues.length ? r.issues.join('; ') : 'clean');
  lines.push(`| ${i + 1} | ${r.host} | ${r.src.join(',')} | ${verdict} | ${detail.join('<br>').replace(/\|/g, '/')} |`);
});
writeFileSync(join(outDir, 'summary.md'), lines.join('\n'));
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(results, null, 1));
console.log(`\nwrote ${join(outDir, 'summary.md')}`);
process.exit(0); // playwright-extra leaves handles open
