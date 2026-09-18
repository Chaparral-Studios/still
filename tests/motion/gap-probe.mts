#!/usr/bin/env node
// Headless coverage probe: which animation channels does the CURRENT tree
// still let through? Serves a fixture with one element per channel, injects
// main-world-patch.js + content.js the way the Playwright tests do (mocked
// browser API), samples each element's transform twice, and prints a matrix.
// Usage: npx tsx tests/motion/gap-probe.mts [--noext]
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const noext = process.argv.includes('--noext');
const MWP = readFileSync(resolve('web-extension/main-world-patch.js'), 'utf8');
const CS = readFileSync(resolve('web-extension/content.js'), 'utf8');

const FIXTURE = `<!doctype html><html><head><style>
  .box { position:absolute; left:20px; width:60px; height:60px; background:#c33; }
  #t-light { top:20px; transition: transform 2s linear; }
  #t-light.go { transform: translateY(300px); }
  @keyframes spin { to { transform: rotate(360deg); } }
  #a-light { top:100px; animation: spin 2s linear infinite; }
  #raf { top:180px; }
  #w-late { top:260px; }
  #interval { top:340px; }
  #hover { top:420px; transition: transform 1s linear; }
  #hover.in { transform: translateX(200px); }
</style></head><body>
  <div id="t-light" class="box"></div>
  <div id="a-light" class="box"></div>
  <div id="raf" class="box"></div>
  <div id="w-late" class="box"></div>
  <div id="interval" class="box"></div>
  <div id="hover" class="box"></div>
  <div id="host"></div>
  <script>
    // shadow-root twins of the transition + keyframe cases, styles scoped inside
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' +
      '.box{position:absolute;left:120px;width:60px;height:60px;background:#36c}' +
      '#t-shadow{top:20px;transition:transform 2s linear}' +
      '#t-shadow.go{transform:translateY(300px)}' +
      '@keyframes sspin{to{transform:rotate(360deg)}}' +
      '#a-shadow{top:100px;animation:sspin 2s linear infinite}' +
      '#w-shadow{top:260px}' +
      '</style><div id="t-shadow" class="box"></div><div id="a-shadow" class="box"></div><div id="w-shadow" class="box"></div>';
    window.__shadow = root;
    // rAF transform loop (GSAP-shaped)
    let x = 0; (function loop(){ x = (x + 3) % 300; document.getElementById('raf').style.transform = 'translateX(' + x + 'px)'; requestAnimationFrame(loop); })();
    // setInterval slideshow: hard cut every 400ms
    let side = 0; setInterval(() => { side = 1 - side; document.getElementById('interval').style.transform = 'translateX(' + (side * 200) + 'px)'; }, 400);
    // WAAPI started late (after Still's last timed pass at 10s), light + shadow
    setTimeout(() => {
      document.getElementById('w-late').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], { duration: 2000, iterations: Infinity });
      root.getElementById('w-shadow').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], { duration: 2000, iterations: Infinity });
    }, 11000);
    window.__go = () => { document.getElementById('t-light').classList.add('go'); root.getElementById('t-shadow').classList.add('go'); };
  </script>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 500, height: 600 } });
await page.route('http://still.test/**', (r) => r.fulfill({ contentType: 'text/html', body: FIXTURE }));
if (!noext) {
  await page.addInitScript(() => {
    (window as any).browser = { storage: { local: { get(k: any, cb: any) { cb({ enabled: true, allowlist: [] }); }, set() {} } },
      runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); }, getURL(p: string) { return 'http://still.test/' + p; } } };
  });
  await page.addInitScript(MWP);
}
await page.goto('http://still.test/');
if (!noext) await page.addScriptTag({ content: CS }); // as the test suite does
await page.waitForTimeout(600);
const loaded = await page.evaluate(() => ({ on: document.documentElement.hasAttribute('data-still-on'), mwp: document.documentElement.getAttribute('data-still-mwp'), still: !!(window as any).__still }));
console.log('still loaded?', JSON.stringify(loaded));

const tf = (sel: string) => page.evaluate((s) => {
  const el = s.startsWith('shadow:') ? (window as any).__shadow.getElementById(s.slice(7)) : document.getElementById(s);
  return getComputedStyle(el).transform;
}, sel);
const moving = async (sel: string, gap = 350) => {
  // several samples: catches periodic hard cuts that a 2-sample diff can alias
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) { seen.add(await tf(sel)); await page.waitForTimeout(gap / 3); }
  return seen.size > 1;
};

const out: Record<string, string> = {};
// transitions: toggle, then sample mid-flight
await page.evaluate(() => (window as any).__go());
await page.waitForTimeout(150);
const tl1 = await tf('t-light'), ts1 = await tf('shadow:t-shadow');
await page.waitForTimeout(400);
const tl2 = await tf('t-light'), ts2 = await tf('shadow:t-shadow');
const FINAL = 'matrix(1, 0, 0, 1, 0, 300)';
out['CSS transition, light DOM'] = (tl1 === FINAL && tl2 === FINAL) ? 'stopped (snapped to end)' : (tl1 !== tl2 ? 'RUNS' : 'stuck?');
out['CSS transition, shadow root'] = (ts1 === FINAL && ts2 === FINAL) ? 'stopped (snapped to end)' : (ts1 !== ts2 ? 'RUNS' : 'stuck?');
out['CSS keyframes infinite, light DOM'] = (await moving('a-light')) ? 'RUNS' : 'stopped';
out['CSS keyframes infinite, shadow root'] = (await moving('shadow:a-shadow')) ? 'RUNS' : 'stopped';
out['rAF inline-transform loop'] = (await moving('raf')) ? 'RUNS' : 'stopped';
out['setInterval hard-cut slideshow'] = (await moving('interval', 1000)) ? 'RUNS (cuts)' : 'stopped';
// hover-triggered transition: real pointer
await page.evaluate(() => { const h = document.getElementById('hover')!; h.addEventListener('mouseenter', () => h.classList.add('in')); });
await page.mouse.move(50, 450);
await page.waitForTimeout(150);
const h1 = await tf('hover'); await page.waitForTimeout(300); const h2 = await tf('hover');
out['hover-triggered CSS transition'] = (h1 === 'matrix(1, 0, 0, 1, 200, 0)' && h2 === h1) ? 'stopped (snapped to end)' : (h1 !== h2 ? 'RUNS' : 'stuck?');
// late WAAPI
await page.waitForTimeout(11500 - 2500);
out['WAAPI element.animate() started at 11s, light DOM'] = (await moving('w-late')) ? 'RUNS' : 'stopped';
out['WAAPI element.animate() started at 11s, shadow root'] = (await moving('shadow:w-shadow')) ? 'RUNS' : 'stopped';

console.log(`\n=== ${noext ? 'NO EXTENSION' : 'CURRENT TREE'} ===`);
for (const [k, v] of Object.entries(out)) console.log(`${v.padEnd(26)} ${k}`);
await browser.close();
