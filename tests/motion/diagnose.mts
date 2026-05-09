#!/usr/bin/env node
// Forensic image diagnostic. Headless Playwright + stealth + Still extension +
// optional cookies. Loads a URL, lets the extension run, then enumerates every
// <img>, <picture>/<source>, iframe, and CSS background-image, plus magic-byte
// sniffs each unique image URL to confirm content type and animation status.
//
// Output: a single JSON report to stdout (and --out <file> if given).
//
// Usage:
//   npx tsx tests/motion/diagnose.mts \
//     --url 'https://www.google.com/search?q=dish+drain+rack' \
//     --cookies tests/motion/cookies/google.com.json \
//     --ext web-extension \
//     --seconds 8 \
//     --out tests/motion/reports/diag-dish-drain.json

import { chromium as rawChromium, type Cookie } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, existsSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const chromium = addExtra(rawChromium);
chromium.use(StealthPlugin());

function arg(name: string): string | undefined;
function arg(name: string, fallback: string): string;
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg('url');
if (!url) { console.error('--url required'); process.exit(1); }
const cookiesFile = arg('cookies');
const extDir = arg('ext') ? resolve(arg('ext')!) : null;
const seconds = parseInt(arg('seconds', '8'), 10);
const outFile = arg('out');

const userDataDir = mkdtempSync(join(tmpdir(), 'still-diag-'));
const launchArgs = [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--mute-audio',
];
if (extDir) {
  launchArgs.push(`--disable-extensions-except=${extDir}`);
  launchArgs.push(`--load-extension=${extDir}`);
}

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: launchArgs,
  viewport: { width: 1280, height: 1600 },
});

if (cookiesFile && existsSync(cookiesFile)) {
  const cookies: Cookie[] = JSON.parse(readFileSync(cookiesFile, 'utf8'));
  for (const c of cookies) {
    if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax';
    try { await context.addCookies([c]); } catch {}
  }
}

const page = await context.newPage();
if (extDir) await page.waitForTimeout(1500);

// Capture console messages — we may instrument content.js with debug logs.
const consoleLog: { type: string; text: string }[] = [];
page.on('console', (m) => { consoleLog.push({ type: m.type(), text: m.text() }); });
page.on('pageerror', (err) => { consoleLog.push({ type: 'pageerror', text: err.message }); });

// Track every image-ish network response so we can correlate URL → content-type → bytes.
type NetEntry = { url: string; status: number; contentType: string | null; size: number; magic: string | null; resourceType: string };
const netByUrl = new Map<string, NetEntry>();
page.on('response', async (resp) => {
  try {
    const u = resp.url();
    const rt = resp.request().resourceType();
    if (rt !== 'image' && rt !== 'media' && !/\.(gif|webp|apng|png|jpe?g|avif)(\?|$)/i.test(u)) return;
    const ct = resp.headers()['content-type'] || null;
    let body: Buffer | null = null;
    try { body = await resp.body(); } catch {}
    const size = body ? body.length : 0;
    let magic: string | null = null;
    if (body && body.length >= 12) {
      const b = body.subarray(0, 16);
      if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) magic = 'gif';
      else if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
        // Sniff for ANIM chunk anywhere in first 4KB.
        const probe = body.subarray(0, Math.min(body.length, 4096)).toString('binary');
        magic = probe.includes('ANIM') ? 'webp-animated' : 'webp-static';
      } else if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        const probe = body.subarray(0, Math.min(body.length, 4096)).toString('binary');
        magic = probe.includes('acTL') ? 'apng' : 'png';
      } else if (b[0] === 0xff && b[1] === 0xd8) magic = 'jpeg';
      else if (b.toString('ascii', 4, 12).includes('ftypavif') || b.toString('ascii', 4, 12).includes('ftypavis')) magic = 'avif';
      else magic = 'unknown';
    }
    netByUrl.set(u, { url: u, status: resp.status(), contentType: ct, size, magic, resourceType: rt });
  } catch {}
});

let navStatus: number | null = null;
try {
  const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  navStatus = nav ? nav.status() : null;
} catch (e) {
  console.error('goto failed:', (e as Error).message);
}

// Wait for body content + extension settle.
try { await page.waitForFunction(() => (document.body?.innerText || '').length > 200, { timeout: 8000 }); } catch {}
await page.waitForTimeout(seconds * 1000);

// Enumerate images at the DOM level. We dive into same-origin iframes too.
// Body fed as a plain-JS string — tsx/esbuild otherwise injects __name
// helpers (named function tracking) into the compiled evaluate body, and
// those helpers don't exist in the page context.
const evalBody = `
  const collectFromDoc = (doc, iframeSrc) => {
    const imgs = [];
    const bgs = [];
    const iframes = [];
    const ancestorString = (el) => {
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && depth < 6) {
        let s = cur.tagName.toLowerCase();
        if (cur.id) s += '#' + cur.id;
        if (cur.className && typeof cur.className === 'string') s += '.' + cur.className.toString().split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
        parts.unshift(s);
        cur = cur.parentElement;
        depth++;
      }
      return parts.join(' > ');
    };
    doc.querySelectorAll('img').forEach((img) => {
      const r = img.getBoundingClientRect();
      const cs = doc.defaultView && doc.defaultView.getComputedStyle(img);
      imgs.push({
        src: img.src,
        currentSrc: img.currentSrc,
        dataStill: img.dataset.still || null,
        naturalW: img.naturalWidth,
        naturalH: img.naturalHeight,
        visibility: cs ? cs.visibility : '',
        display: cs ? cs.display : '',
        inViewport: r.top < (doc.defaultView ? doc.defaultView.innerHeight : 0) && r.bottom > 0 && r.width > 0,
        inIframe: !!iframeSrc,
        iframeSrc,
        parentTag: img.parentElement ? img.parentElement.tagName.toLowerCase() : '',
        ancestorChain: ancestorString(img),
        role: img.getAttribute('role'),
        alt: img.getAttribute('alt'),
      });
    });
    doc.querySelectorAll('*').forEach((el) => {
      const cs = doc.defaultView && doc.defaultView.getComputedStyle(el);
      const bg = cs && cs.backgroundImage;
      if (bg && bg !== 'none' && /url\\(/.test(bg)) {
        const m = bg.match(/url\\(["']?([^)"']+)["']?\\)/);
        if (m && /^(https?:|data:image)/.test(m[1])) {
          bgs.push({ url: m[1], selector: ancestorString(el) });
        }
      }
    });
    doc.querySelectorAll('iframe').forEach((f) => iframes.push(f.src || '(no src)'));
    return { imgs, bgs, iframes };
  };
  const collectVideos = (doc, iframeSrc) => {
    const videos = [];
    const ancestorString2 = (el) => {
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && depth < 8) {
        let s = cur.tagName.toLowerCase();
        if (cur.id) s += '#' + cur.id;
        if (cur.className && typeof cur.className === 'string') s += '.' + cur.className.toString().split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
        parts.unshift(s);
        cur = cur.parentElement;
        depth++;
      }
      return parts.join(' > ');
    };
    doc.querySelectorAll('video').forEach((v) => {
      const r = v.getBoundingClientRect();
      const sources = [];
      v.querySelectorAll('source').forEach((s) => sources.push({ src: s.src, type: s.type }));
      videos.push({
        src: v.src || null,
        currentSrc: v.currentSrc || null,
        sources,
        autoplay: v.autoplay,
        loop: v.loop,
        muted: v.muted,
        paused: v.paused,
        readyState: v.readyState,
        w: r.width, h: r.height,
        stillVideo: v.dataset.stillVideo || null,
        attrs: Array.from(v.attributes).map((a) => a.name + '=' + (a.value || '').slice(0, 40)),
        ancestorChain: ancestorString2(v),
        inViewport: r.top < (doc.defaultView ? doc.defaultView.innerHeight : 0) && r.bottom > 0 && r.width > 0,
        iframeSrc,
      });
    });
    return videos;
  };
  const collectAnimations = (doc) => {
    const out = [];
    if (!doc.getAnimations) return out;
    try {
      doc.getAnimations({ subtree: true }).forEach((a) => {
        try {
          const t = a.effect && a.effect.target;
          let tagDesc = '';
          if (t) {
            tagDesc = t.tagName ? t.tagName.toLowerCase() : '';
            if (t.id) tagDesc += '#' + t.id;
            if (t.className && typeof t.className === 'string') tagDesc += '.' + t.className.toString().split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
          }
          out.push({
            playState: a.playState,
            currentTime: a.currentTime,
            iterationCount: (a.effect && a.effect.getTiming && a.effect.getTiming().iterations) || null,
            duration: (a.effect && a.effect.getTiming && a.effect.getTiming().duration) || null,
            target: tagDesc,
            id: a.id || '',
          });
        } catch (e) {}
      });
    } catch (e) {}
    return out;
  };
  const top = collectFromDoc(document, null);
  top.videos = collectVideos(document, null);
  top.animations = collectAnimations(document);
  document.querySelectorAll('iframe').forEach((f) => {
    try {
      const cd = f.contentDocument;
      if (cd) {
        const sub = collectFromDoc(cd, f.src);
        top.imgs.push.apply(top.imgs, sub.imgs);
        top.bgs.push.apply(top.bgs, sub.bgs);
        top.videos.push.apply(top.videos, collectVideos(cd, f.src));
      }
    } catch (e) {}
  });
  return top;
`;
const domReport = await page.evaluate(new Function(evalBody) as any);

// Try programmatically playing every video element. If our blocker is
// working, the .play() returns a resolved Promise but the video stays
// paused. This is the authoritative test that bypasses the headless
// "no autoplay because no user gesture" baseline.
const playProbe = await page.evaluate(`
  (async () => {
    const out = [];
    for (const v of document.querySelectorAll('video')) {
      const before = { paused: v.paused, stillVideo: v.dataset.stillVideo || null };
      let played = null;
      try {
        const p = v.play();
        if (p && p.then) await p.then(() => { played = 'resolved'; }).catch((e) => { played = 'rejected:' + (e && e.name); });
        else played = 'sync';
      } catch (e) { played = 'threw:' + (e && e.name); }
      out.push({
        src: (v.currentSrc || v.src || '').slice(0, 100),
        before,
        after: { paused: v.paused, currentTime: v.currentTime, readyState: v.readyState },
        played,
      });
    }
    return out;
  })()
`);

// Optional: take a screenshot for visual inspection.
const screenshotPath = outFile ? outFile.replace(/\.json$/, '.png') : null;
if (screenshotPath) {
  try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch {}
}

const report = {
  url,
  finalUrl: page.url(),
  navStatus,
  title: await page.title().catch(() => null),
  bodyLen: await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0),
  imageCount: domReport.imgs.length,
  bgCount: domReport.bgs.length,
  iframeCount: domReport.iframes.length,
  iframes: domReport.iframes,
  videos: domReport.videos || [],
  playProbe,
  animations: domReport.animations || [],
  consoleLog: consoleLog.filter((m) => /still|probe|head|tbn|webp|apng|gif/i.test(m.text)).slice(0, 200),
  net: Array.from(netByUrl.values()),
  // Per-image, joined with the network entry where we can match (currentSrc preferred).
  imgs: domReport.imgs.map((i) => {
    const ne = netByUrl.get(i.currentSrc) || netByUrl.get(i.src);
    return { ...i, net: ne || null };
  }),
  bgs: domReport.bgs.map((b) => ({ ...b, net: netByUrl.get(b.url) || null })),
  // Highlight anything that smells animated: gif magic, animated webp, apng.
  animatedHits: Array.from(netByUrl.values()).filter((e) => e.magic === 'gif' || e.magic === 'webp-animated' || e.magic === 'apng'),
};

await page.close();
await context.close();

const json = JSON.stringify(report, null, 2);
if (outFile) {
  mkdirSync(dirname(resolve(outFile)), { recursive: true });
  writeFileSync(outFile, json);
  console.error(`wrote ${outFile} (${report.imageCount} images, ${report.animatedHits.length} animated)`);
} else {
  console.log(json);
}
