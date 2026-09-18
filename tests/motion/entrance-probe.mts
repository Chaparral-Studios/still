// Headless probe: "text zooms into place at page load" entrance animations,
// one element per channel, measured with the REAL extension load path.
// Reports how many distinct rendered sizes/opacities each element shows during
// the first 1.6s (1 = static, i.e. it simply appears in its final state).
// Usage: npx tsx tests/motion/entrance-probe.mts [--noext]   (EXT=<dir> to test another tree)
import { chromium } from '@playwright/test';
import http from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const noext = process.argv.includes('--noext');
const PAGE = `<!doctype html><html><head><style>
  h2 { margin: 12px; width: 300px; }
  @keyframes zoomIn { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: scale(1); } }
  #css-keyframes { animation: zoomIn .9s ease-out both; }
  #css-transition { opacity: 0; transform: scale(.6); transition: opacity .9s, transform .9s; }
  #css-transition.in { opacity: 1; transform: scale(1); }
  #waapi, #raf, #raf-stagger-1, #raf-stagger-2 { opacity: 0; transform: scale(.6); }
</style></head><body>
  <h2 id="css-keyframes">CSS keyframes</h2><h2 id="css-transition">CSS transition on class</h2>
  <h2 id="waapi">Web Animations API</h2><h2 id="raf">rAF inline writes (GSAP shape)</h2>
  <h2 id="raf-stagger-1">rAF stagger 1</h2><h2 id="raf-stagger-2">rAF stagger 2</h2>
  <script>
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    function tween(el, delay) { const t0 = performance.now() + delay; (function f(now) { const t = Math.min(1, Math.max(0, (now - t0) / 900)); const e = ease(t); el.style.opacity = String(e); el.style.transform = 'scale(' + (0.6 + 0.4 * e) + ')'; if (t < 1) requestAnimationFrame(f); })(performance.now()); }
    addEventListener('DOMContentLoaded', () => {
      requestAnimationFrame(() => document.getElementById('css-transition').classList.add('in'));
      const w = document.getElementById('waapi');
      w.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 900, easing: 'ease-out', fill: 'forwards' });
      tween(document.getElementById('raf'), 0); tween(document.getElementById('raf-stagger-1'), 150); tween(document.getElementById('raf-stagger-2'), 300);
    });
    // sampler lives in the page so it starts with the document
    window.__samples = {}; const ids = ['css-keyframes', 'css-transition', 'waapi', 'raf', 'raf-stagger-1', 'raf-stagger-2'];
    const s0 = performance.now(); (function s() { for (const id of ids) { const el = document.getElementById(id); if (!el) continue; const r = el.getBoundingClientRect(); const k = Math.round(r.width) + '/' + (+getComputedStyle(el).opacity).toFixed(2); (window.__samples[id] = window.__samples[id] || []).push(k); } if (performance.now() - s0 < 1600) requestAnimationFrame(s); })();
  </script></body></html>`;
const server = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(PAGE); });
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const extDir = resolve(process.env.EXT || 'web-extension');
const ud = join(tmpdir(), `still-entrance-${process.pid}`); mkdirSync(ud, { recursive: true });
const args = ['--headless=new', '--disable-gpu']; if (!noext) args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
const ctx = await chromium.launchPersistentContext(ud, { headless: false, args });
const page = await ctx.newPage(); if (!noext) await page.waitForTimeout(1500);
await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`); await page.waitForTimeout(2500);
const res = await page.evaluate(() => Object.fromEntries(Object.entries((window as any).__samples).map(([id, arr]: any) => { const el = document.getElementById(id)!; return [id, { distinctStates: new Set(arr).size, final: Math.round(el.getBoundingClientRect().width) + '/' + getComputedStyle(el).opacity }]; })));
console.log(noext ? 'NO EXTENSION' : 'STILL', JSON.stringify(res, null, 1));
await ctx.close(); rmSync(ud, { recursive: true, force: true }); server.close(); process.exit(0);
