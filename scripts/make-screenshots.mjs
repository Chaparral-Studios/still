/* Build Chrome Web Store screenshots (1280x800 PNG) — headless only.
 *
 * Nothing ever paints to a display: Chromium runs with --headless=new (the
 * flag Playwright's own `headless: true` can't be used for here, because it
 * disables MV3 extension loading).
 *
 * Produces store/chrome/screenshots/:
 *   01-before-after.png  same demo page without / with Still, side by side
 *   02-popup.png         the toolbar popup
 *   03-what-it-stops.png the capability summary card
 *
 * The animated GIFs the demo page needs are generated here with ffmpeg into
 * store/chrome/.build/assets (gitignored) — no animated asset is committed.
 *
 * Usage: node scripts/make-screenshots.mjs
 */
import { chromium } from 'playwright';
import { execFileSync } from 'child_process';
import { createServer } from 'http';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'store', 'chrome');
const BUILD = join(STORE, '.build');
const SHOTS = join(STORE, 'screenshots');
const EXT = join(ROOT, 'web-extension');

mkdirSync(join(BUILD, 'assets'), { recursive: true });
mkdirSync(SHOTS, { recursive: true });

// --- 1. Generate the demo page's animated GIFs (build-time only) ---
const gifs = [
  ['demo-banner.gif', ['-f', 'lavfi', '-i', 'gradients=s=480x180:d=3:speed=0.15:n=3', '-vf', 'fps=12']],
  ['demo-tile.gif', ['-f', 'lavfi', '-i', 'testsrc2=s=160x160:d=2:r=12']],
  ['demo-thumb.gif', ['-f', 'lavfi', '-i', 'mandelbrot=s=200x200:r=12', '-t', '2']],
];
for (const [name, args] of gifs) {
  const out = join(BUILD, 'assets', name);
  if (existsSync(out)) continue;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, out]);
}

// --- 2. Serve the demo page over HTTP (content scripts need a real origin) ---
const TYPES = { '.html': 'text/html', '.gif': 'image/gif', '.png': 'image/png',
                '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = rel.startsWith('/assets/') ? join(BUILD, rel) : join(STORE, rel);
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${server.address().port}`;

// --- 3. Capture the demo page with and without the extension ---
const HALF = { width: 640, height: 800 };

async function capture({ withExt, out, viewport, url, init }) {
  const userDataDir = join(BUILD, withExt ? '.udd-ext' : '.udd-plain');
  rmSync(userDataDir, { recursive: true, force: true });
  mkdirSync(userDataDir, { recursive: true });
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio'];
  if (withExt) args.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`);
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,          // real headless comes from --headless=new above
    args, viewport,
    deviceScaleFactor: 2,     // store screenshots look soft at 1x
  });
  const page = await ctx.newPage();
  if (init) await page.addInitScript(init);
  if (withExt) await page.waitForTimeout(1200);   // service worker spin-up
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(withExt ? 2500 : 1200); // let probes settle
  await page.screenshot({ path: out });
  await ctx.close();
}

const beforePng = join(BUILD, 'before.png');
const afterPng = join(BUILD, 'after.png');
await capture({ withExt: false, out: beforePng, viewport: HALF, url: `${baseURL}/demo.html` });
await capture({ withExt: true, out: afterPng, viewport: HALF, url: `${baseURL}/demo.html` });

// --- 4. Compose the labelled side-by-side at 1280x800 ---
const dataURI = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
// Labels sit in their own strip above each capture rather than floating over
// it — an overlay badge covered the demo page's own header.
const composeHTML = `<!DOCTYPE html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1280px; height: 800px; display: flex; gap: 2px; background: #10131a;
         font: 600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .pane { width: 639px; height: 800px; display: flex; flex-direction: column; overflow: hidden; }
  .bar { height: 46px; flex: none; display: flex; align-items: center; gap: 9px;
         padding: 0 18px; color: #fff; letter-spacing: .2px; }
  .bar .dot { width: 9px; height: 9px; border-radius: 50%; background: currentColor; }
  .off { background: #8c1d18; color: #ffd9d6; }
  .on  { background: #0f5132; color: #c6f0d6; }
  .shot { flex: 1; overflow: hidden; }
  .shot img { width: 639px; display: block; }
</style>
<div class="pane">
  <div class="bar off"><span class="dot"></span>Without Still — everything loops</div>
  <div class="shot"><img src="${dataURI(beforePng)}"></div>
</div>
<div class="pane">
  <div class="bar on"><span class="dot"></span>With Still — the page holds still</div>
  <div class="shot"><img src="${dataURI(afterPng)}"></div>
</div>`;

async function shotHTML(html, out, viewport = { width: 1280, height: 800 }) {
  const browser = await chromium.launch({ args: ['--headless=new'] });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: out });
  await browser.close();
}
await shotHTML(composeHTML, join(SHOTS, '01-before-after.png'));

// --- 5. The popup, on a neutral backdrop ---
const popupCSS = readFileSync(join(EXT, 'popup.css'), 'utf8');
const popupBody = readFileSync(join(EXT, 'popup.html'), 'utf8')
  .replace(/[\s\S]*<body>/i, '').replace(/<\/body>[\s\S]*/i, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '');
// popup.js talks to the extension APIs, which don't exist in a bare page —
// render the markup and fill in the state it would have written.
// popup.css styles `body` — rescope it to .popup so it doesn't fight the
// 1280x800 backdrop, and scale with `zoom` (which reflows) rather than
// `transform: scale` (which doesn't, so text overflowed the card).
const popupHTML = `<!DOCTYPE html><meta charset="utf-8"><style>
  ${popupCSS.replace(/(^|\})\s*body\s*\{/, '$1 .popup {')}
  html,body { margin:0; }
  body { width:1280px; height:800px; display:flex; align-items:center; justify-content:center;
         background: linear-gradient(140deg,#f2f4f7 0%,#e6eaf0 100%);
         font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .frame { zoom: 2.1; border-radius: 10px; overflow: hidden; background:#fff;
           box-shadow: 0 9px 26px rgba(20,25,35,.20); }
  .popup { width: 260px; padding: 16px; background:#fff; }
</style>
<div class="frame"><div class="popup">${popupBody}</div></div>
<script>
  document.getElementById('globalToggle').checked = true;
  document.getElementById('siteToggle').checked = false;
  document.getElementById('status').textContent = 'Blocking on this site';
  document.getElementById('count').textContent = '14 animations stopped';
</script>`;
await shotHTML(popupHTML, join(SHOTS, '02-popup.png'));

// --- 6. Capability summary card ---
const ITEMS = [
  ['Animated GIF, WebP &amp; APNG', 'Replaced with a still placeholder before the first frame paints.'],
  ['Autoplaying video', 'Paused unless you started it yourself.'],
  ['CSS &amp; JavaScript animation', 'Transitions and keyframes snapped to their end state.'],
  ['Animated &lt;canvas&gt; and SVG', 'Frozen once a sustained repaint is detected.'],
  ['Scroll-linked motion', 'Progress sweeps and parallax decoration pinned in place.'],
  ['Per-site control', 'One toggle to allow a site you want moving again.'],
];
const cardHTML = `<!DOCTYPE html><meta charset="utf-8"><style>
  * { box-sizing:border-box; margin:0; }
  body { width:1280px; height:800px; padding:72px 80px; background:#fff;
         display:flex; flex-direction:column; justify-content:center;
         font:16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color:#16181d; }
  h1 { font-size:58px; letter-spacing:-1.4px; margin-bottom:12px; }
  .sub { color:#5c6370; font-size:24px; margin-bottom:56px; }
  ul { list-style:none; display:grid; grid-template-columns:1fr 1fr; gap:40px 56px; }
  li { display:flex; gap:18px; align-items:flex-start; }
  .dot { flex:none; width:40px; height:40px; border-radius:11px; background:#eef1f5;
         display:flex; align-items:center; justify-content:center; margin-top:2px; }
  .bars { display:flex; gap:4px; }
  .bars i { display:block; width:5px; height:17px; background:#4a5568; border-radius:1px; }
  .t { display:block; font-weight:650; font-size:21px; margin-bottom:5px; }
  .d { display:block; color:#5c6370; font-size:17px; line-height:1.45; }
</style>
<h1>Still</h1>
<div class="sub">Stops web motion that can trigger migraine, nausea, and seizures.</div>
<ul>${ITEMS.map(([t, d]) => `<li><span class="dot"><span class="bars"><i></i><i></i></span></span>
  <span><span class="t">${t}</span><span class="d">${d}</span></span></li>`).join('')}</ul>`;
await shotHTML(cardHTML, join(SHOTS, '03-what-it-stops.png'));

// --- 7. Downscale 2x captures to the store's required exact 1280x800 ---
// Rendering at deviceScaleFactor 2 and resampling down is what keeps text
// crisp; uploading the raw 2560x1600 would be rejected (the store accepts
// only 1280x800 or 640x400).
for (const name of ['01-before-after.png', '02-popup.png', '03-what-it-stops.png']) {
  const p = join(SHOTS, name);
  const tmp = join(BUILD, name);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', p,
    '-vf', 'scale=1280:800:flags=lanczos', tmp]);
  execFileSync('cp', [tmp, p]);
}

server.close();
console.log('screenshots written to', SHOTS);
