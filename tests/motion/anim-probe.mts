// Why is an animation still running on a site? Lists every running animation
// with its root (light / open / closed shadow), whether Still covered the root
// (marker sheet present), and the element chain. Headless, extension loaded.
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const url = process.argv[2];
const extDir = resolve('web-extension');
const ud = join(tmpdir(), `still-animprobe-${process.pid}`); mkdirSync(ud, { recursive: true });
const ctx = await chromium.launchPersistentContext(ud, { headless: false, args: ['--headless=new', '--disable-gpu', '--mute-audio', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await ctx.addInitScript(`(() => { const roots = []; const o = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { const r = o.call(this, i); roots.push({ r, mode: i && i.mode, host: this }); return r; }; window.__roots = roots; })()`);
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch((e) => console.log('goto:', e.message.slice(0, 80)));
await page.waitForTimeout(6000);
const r = await page.evaluate(`(() => {
  const covered = (root) => { try { for (const sh of root.adoptedStyleSheets || []) { try { if (sh.cssRules[0] && sh.cssRules[0].selectorText === '#-still-shadow-marker') return 'sheet'; } catch (e) {} } return root.querySelector(':scope > style[data-still-shadow]') ? 'style' : 'NO'; } catch (e) { return '?'; } };
  const desc = (el) => { try { const r = el.getBoundingClientRect(); return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').split(' ').slice(0,2).join('.') + ' @' + Math.round(r.top) + ',' + Math.round(r.left) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); } catch (e) { return '?'; } };
  const out = { on: document.documentElement.hasAttribute('data-still-on'), mwp: document.documentElement.getAttribute('data-still-mwp'), roots: window.__roots.length, anims: [] };
  const seen = new Set();
  const add = (a, where, cov) => { if (seen.has(a)) return; seen.add(a); const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {}; if (a.playState !== 'running') return; const el = a.effect && a.effect.target; out.anims.push({ ct: Math.round(a.currentTime), start: Math.round(a.startTime), kind: a.constructor.name, name: a.animationName || a.transitionProperty || '', iter: String(t.iterations), dur: t.duration, where, cov, el: desc(el), chain: (() => { const c = []; let n = el; while (n) { c.push(n.nodeType === 11 ? '#shadow(' + (n.host ? n.host.tagName.toLowerCase() : '') + ')' : n.tagName ? n.tagName.toLowerCase() : n.nodeName); n = n.parentNode || (n.host); if (c.length > 12) break; } return c.join(' < '); })() }); };
  out.rootInfo = window.__roots.map(({ r, mode, host }) => ({ host: host.tagName.toLowerCase(), mode, connected: host.isConnected, sheets: (r.adoptedStyleSheets || []).length, sel0: (r.adoptedStyleSheets || []).map((sh) => { try { return sh.cssRules[0] && sh.cssRules[0].selectorText; } catch (e) { return '?'; } }), styleKids: r.querySelectorAll(':scope > style').length }));
  try { document.getAnimations().forEach((a) => add(a, 'doc', '-')); } catch (e) {}
  for (const { r, mode } of window.__roots) { try { for (const c of r.children) c.getAnimations({ subtree: true }).forEach((a) => add(a, 'shadow:' + mode, covered(r))); } catch (e) {} }
  document.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) { try { for (const c of el.shadowRoot.children) c.getAnimations({ subtree: true }).forEach((a) => add(a, 'shadow:open/decl', covered(el.shadowRoot))); } catch (e) {} } });
  return out;
})()`);
console.log(JSON.stringify(r, null, 1));
const ev = await page.evaluate(`new Promise((res) => { const counts = {}; for (const { r, host } of window.__roots) { r.addEventListener('animationstart', (e) => { const k = host.tagName.toLowerCase() + ':' + e.animationName; counts[k] = (counts[k] || 0) + 1; }, true); } setTimeout(() => res(counts), 2500); })`);
console.log('animationstart events seen in 2.5s:', JSON.stringify(ev));
await ctx.close(); rmSync(ud, { recursive: true, force: true }); process.exit(0);
