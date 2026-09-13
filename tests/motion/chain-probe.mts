// Does a finished-promise-chained animate() loop hang the page under the new wrap?
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const MWP = readFileSync('web-extension/main-world-patch.js', 'utf8');
const CS = readFileSync('web-extension/content.js', 'utf8');
const PAGE = `<!doctype html><body><div id="b" style="position:absolute;width:40px;height:40px;background:red"></div>
<script>
  window.__cycles = 0;
  const el = document.getElementById('b');
  function step(dir) { window.__cycles++; const a = el.animate([{transform:'translateX(0)'},{transform:'translateX(200px)'}], {duration:400, direction: dir?'normal':'reverse'}); a.finished.then(() => step(!dir)).catch(()=>{}); }
  setTimeout(() => step(true), 800);
  // CSS animationend-restart chain in the light DOM
  const c = document.createElement('div'); c.id='c'; c.style.cssText='position:absolute;top:60px;width:40px;height:40px;background:blue';
  document.body.appendChild(c);
  const st = document.createElement('style'); st.textContent='@keyframes k{to{transform:translateX(200px)}}'; document.head.appendChild(st);
  window.__cssCycles = 0;
  c.addEventListener('animationend', () => { window.__cssCycles++; c.style.animation='none'; void c.offsetWidth; c.style.animation='k 400ms'; });
  setTimeout(() => { c.style.animation='k 400ms'; }, 800);
</script></body>`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.route('http://still.test/**', (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
await page.addInitScript(() => { window.browser = { storage: { local: { get(k, cb) { cb({ enabled: true, allowlist: [] }); }, set() {} } }, runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); }, getURL(p) { return 'http://still.test/' + p; } } }; });
await page.addInitScript(MWP);
await page.goto('http://still.test/');
await page.addScriptTag({ content: CS });
await page.waitForTimeout(2500);
const t0 = Date.now();
const r = await Promise.race([
  page.evaluate(() => ({ waapiCycles: window.__cycles, cssCycles: window.__cssCycles })),
  new Promise((res) => setTimeout(() => res('EVALUATE HUNG (main thread busy)'), 5000)),
]);
console.log('result after 2.5s:', JSON.stringify(r), 'evaluate took', Date.now() - t0, 'ms');
await browser.close();
