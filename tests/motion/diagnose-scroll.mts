#!/usr/bin/env node
// Headless smooth-scroll diagnostic. Never paints to a display.
//
// Answers two questions about a page's carousel / scroll animation:
//   1. WHICH mechanism does it use — CSS scroll-behavior, a JS
//      scrollTo/scrollBy({behavior:'smooth'}) call, or a rAF loop writing
//      scrollLeft frame by frame? Only the first two are neutralized by the
//      extension; a rAF loop would need a different fix entirely.
//   2. Does it GLIDE or HOP with the extension loaded? Measured as the number
//      of distinct intermediate scroll positions after clicking the carousel's
//      next arrow: a couple means it jumped, dozens means it animated.
//
// Usage:
//   npx tsx tests/motion/diagnose-scroll.mts --url <url> [--ext web-extension]
//     [--cookies tests/motion/cookies/<host>.json] [--click-arrow]
//
// Run with and without --ext to compare against the unblocked baseline.
import { chromium as rawChromium, type Cookie } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
const cookiesFile = arg('cookies');
const clickArrow = process.argv.includes('--click-arrow');

const launchArgs = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio'];
if (extDir) {
  launchArgs.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
}
const userDataDir = join(tmpdir(), `still-scroll-${process.pid}`);
mkdirSync(userDataDir, { recursive: true });

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false, // real headless comes from --headless=new; see record.mts
  args: launchArgs,
  viewport: { width: 1280, height: 900 },
});

if (cookiesFile && existsSync(cookiesFile)) {
  const cookies: Cookie[] = JSON.parse(readFileSync(cookiesFile, 'utf8'));
  let ok = 0;
  for (const c of cookies) {
    if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax';
    try { await context.addCookies([c]); ok++; } catch {}
  }
  console.log(`loaded ${ok} cookies`);
}

const page = await context.newPage();
if (extDir) await page.waitForTimeout(1500);
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) {
  console.error('goto failed:', (e as Error).message);
}
await page.waitForTimeout(5000);

const bodyText: string = await page.evaluate(`document.body ? document.body.innerText.slice(0, 200) : ''`);
if (/unusual traffic|not a robot|CAPTCHA|verify you are human/i.test(bodyText)) {
  console.log('BLOCKED: the site is serving a bot check, not the real page.');
  console.log('  ', bodyText.slice(0, 140).replace(/\n/g, ' '));
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
  process.exit(3);
}

// Layer a logger over whatever scroll methods are installed, so we see what
// the PAGE asks for (the extension's rewrite happens underneath us).
await page.evaluate(`(() => {
  window.__req = [];
  const wrap = (target, name) => {
    if (!Object.prototype.hasOwnProperty.call(target, name)) return;
    const cur = target[name];
    if (typeof cur !== 'function') return;
    Object.defineProperty(target, name, { configurable: true, writable: true,
      value: function (a) {
        window.__req.push({ name,
          behavior: (a && typeof a === 'object') ? (a.behavior || 'auto') : 'positional' });
        return cur.apply(this, arguments);
      } });
  };
  ['scrollTo', 'scrollBy', 'scroll'].forEach((m) => { wrap(Element.prototype, m); wrap(window, m); });
  wrap(Element.prototype, 'scrollIntoView');
})()`);

const car: any = await page.evaluate(`(() => {
  const sc = [...document.querySelectorAll('*')].find((e) =>
    e.scrollWidth > e.clientWidth + 50 && e.clientWidth > 300 &&
    ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX));
  if (!sc) return null;
  sc.setAttribute('data-probe-scroller', '');
  sc.scrollIntoView({ block: 'center' });
  const cs = getComputedStyle(sc);
  const r = sc.getBoundingClientRect();
  return { cls: sc.className.toString().slice(0, 50), scrollWidth: sc.scrollWidth,
    clientWidth: sc.clientWidth, scrollBehavior: cs.scrollBehavior,
    transitionDuration: cs.transitionDuration,
    mainWorldPatch: document.documentElement.getAttribute('data-still-mwp'),
    stillOff: document.documentElement.hasAttribute('data-still-off'),
    x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);

if (!car) {
  console.log('no horizontally-scrollable carousel found on this page variant');
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
  process.exit(0);
}
console.log('carousel:', JSON.stringify(car));

if (clickArrow) {
  await page.mouse.move(car.x, car.y); // arrows are usually hover-revealed
  await page.waitForTimeout(1000);
  const arrows: any[] = await page.evaluate(`(() =>
    [...document.querySelectorAll('[aria-label],[role="button"],button')]
      .filter((b) => /next|forward|right|→/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')))
      .map((b) => { const r = b.getBoundingClientRect();
        return { label: (b.getAttribute('aria-label') || b.title || '').slice(0, 25),
                 x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 w: Math.round(r.width) }; })
      .filter((b) => b.w > 0))()`);
  console.log('visible next-arrows:', JSON.stringify(arrows));
  if (!arrows.length) {
    console.log('no visible arrow to click — try --url with a page whose carousel has arrows');
  } else {
    // Sample the RENDERED position (a child's on-screen x), not scrollLeft:
    // the extension serves a page its own virtual scroll offset while
    // withholding an animation, so reading scrollLeft reports motion that was
    // never painted.
    await page.evaluate(`(() => {
      window.__f = [];
      const sc = document.querySelector('[data-probe-scroller]');
      const child = sc.firstElementChild;
      const read = () => child
        ? Math.round(child.getBoundingClientRect().left)
        : Math.round(sc.scrollLeft);
      const t0 = performance.now();
      const tick = () => { if (performance.now() - t0 > 2000) return;
        window.__f.push(read()); requestAnimationFrame(tick); };
      tick();
    })()`);
    await page.mouse.click(arrows[0].x, arrows[0].y);
    await page.waitForTimeout(2400);
    const res: any = await page.evaluate(`(() => ({
      distinct: window.__f.filter((v, i) => i === 0 || v !== window.__f[i - 1]).length,
      first: window.__f[0], last: window.__f[window.__f.length - 1] }))()`);
    console.log(`rendered x ${res.first} -> ${res.last} | distinct intermediate positions: ${res.distinct}`,
      res.distinct <= 5 ? '=> INSTANT HOP' : '=> GLIDE (still animating)');
  }
}

const reqs: any[] = await page.evaluate(`window.__req`);
console.log('scroll API calls the page made:', JSON.stringify(reqs.slice(-15)));
console.log('(behavior:"smooth" here => the JS override is the relevant fix;',
  'no calls at all but a glide => a rAF scrollLeft loop, which is NOT handled)');

await context.close();
rmSync(userDataDir, { recursive: true, force: true });
