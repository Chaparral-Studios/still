#!/usr/bin/env node
// DOM-level animation probe. Loads a URL (no extension, same cookie/stealth setup
// as record.mts), observes what mutates on the page over N seconds, and reports
// which elements are animating, how (WAAPI / style / attribute / childList), and
// where on the page they sit.
//
// Use after a sit-mode recording has shown motion, to identify the DOM culprit.
// Optional --region x,y,w,h to filter results to a bounding box (e.g., the
// region where the heatmap showed motion).
//
// Usage: tsx probe.mts --url <url> --out <dir> [--seconds <n>] [--cookies <json>]
//                      [--region x,y,w,h]

import { chromium as rawChromium, type Cookie, type Response } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const chromium = addExtra(rawChromium);
chromium.use(StealthPlugin());

function arg(name: string): string | undefined;
function arg(name: string, fallback: string): string;
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg('url');
const outArg = arg('out');
if (!url || !outArg) { console.error('--url and --out required'); process.exit(1); }
const outDir = resolve(outArg);
const seconds = parseInt(arg('seconds', '15'), 10);
const cookiesFile = arg('cookies');
const regionArg = arg('region');
type Rect = { x: number; y: number; w: number; h: number };
const region: Rect | null = regionArg
  ? (() => { const [x, y, w, h] = regionArg.split(',').map(Number); return { x, y, w, h }; })()
  : null;

mkdirSync(outDir, { recursive: true });
const viewport = { width: 1280, height: 800 };

const context = await chromium.launchPersistentContext(join(outDir, '.userdata'), {
  headless: false,
  args: ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio'],
  viewport,
});

// Install the probe BEFORE any page script runs. window.__probe captures all
// mutations we care about; the page code can't remove it because the observer
// is wired into every new document in this context.
await context.addInitScript(() => {
  type Mut = {
    t: number;
    type: string;
    selector: string;
    attrName: string | null;
    rect: { x: number; y: number; w: number; h: number } | null;
  };
  const w = window as unknown as { __probe: { mutations: Mut[]; start: number } };
  w.__probe = { mutations: [], start: Date.now() };

  function shortSelector(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    let cls = '';
    if (typeof el.className === 'string' && el.className) {
      cls = '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
    }
    const data = Array.from(el.attributes).find((a) => a.name.startsWith('data-a-'))?.name;
    return tag + id + cls + (data ? `[${data}]` : '');
  }

  const obs = new MutationObserver((records) => {
    const t = (Date.now() - w.__probe.start) / 1000;
    for (const r of records) {
      const target = r.target as Element;
      const rect = target instanceof Element ? (() => {
        const b = target.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      })() : null;
      w.__probe.mutations.push({
        t,
        type: r.type,
        selector: target instanceof Element ? shortSelector(target) : '#text',
        attrName: r.attributeName || null,
        rect,
      });
    }
  });

  // Filter to attributes that are actual motion signals; childList+subtree catches
  // carousel slide swaps, lazy hydration, etc.
  obs.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'src', 'srcset', 'aria-hidden', 'hidden'],
  });
});

if (cookiesFile && existsSync(cookiesFile)) {
  const cookies: Cookie[] = JSON.parse(readFileSync(cookiesFile, 'utf8'));
  for (const c of cookies) if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax';
  for (const c of cookies) { try { await context.addCookies([c]); } catch {} }
}

const page = await context.newPage();
let nav: Response | null = null;
try {
  nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) { console.error('goto failed:', (e as Error).message); }
try {
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, { timeout: 6000 });
} catch {}

// Reset the probe clock: we only want to measure mutations that happen in the
// steady-state window, not initial hydration.
await page.evaluate(() => {
  const w = window as unknown as { __probe: { mutations: unknown[]; start: number } };
  w.__probe.mutations = [];
  w.__probe.start = Date.now();
});

await page.waitForTimeout(seconds * 1000);

type Mut = {
  t: number; type: string; selector: string; attrName: string | null;
  rect: { x: number; y: number; w: number; h: number } | null;
};
const mutations: Mut[] = await page.evaluate(() =>
  (window as unknown as { __probe: { mutations: Mut[] } }).__probe.mutations
);

// WAAPI / CSS animations currently running.
type Anim = { id: string; playState: string; target: string | null; keyframeCount: number };
const animations: Anim[] = await page.evaluate(() =>
  // Walk all shadow roots and the main document; `document.getAnimations()` by
  // default only returns its own root, not descendants — pass {subtree:true}
  // inside the page context where it's a supported call signature.
  Array.from((document as Document & { getAnimations(o?: { subtree: boolean }): Animation[] }).getAnimations({ subtree: true })).map((a) => {
    const effect = a.effect as KeyframeEffect | null;
    const target = effect?.target as Element | null;
    return {
      id: a.id || '',
      playState: a.playState,
      target: target ? (target.tagName.toLowerCase() +
        (target.id ? '#' + target.id : '') +
        (typeof target.className === 'string' && target.className
          ? '.' + target.className.trim().split(/\s+/).slice(0, 3).join('.') : '')) : null,
      keyframeCount: effect?.getKeyframes?.().length ?? 0,
    };
  })
);

await page.screenshot({ path: join(outDir, 'probe-final.png'), fullPage: false }).catch(() => {});
await page.close();
await context.close();

// Filter by region if provided.
const inRegion = (m: Mut) => {
  if (!region || !m.rect) return true;
  const r = m.rect;
  // Consider any overlap with the region as "in".
  return r.x < region.x + region.w && r.x + r.w > region.x
      && r.y < region.y + region.h && r.y + r.h > region.y;
};
const filtered = mutations.filter(inRegion);

// Aggregate by selector: count mutations, split by type, carry representative rect.
type Agg = {
  selector: string; count: number;
  byType: Record<string, number>;
  byAttr: Record<string, number>;
  rect: Mut['rect'];
  firstT: number;
  lastT: number;
};
const agg = new Map<string, Agg>();
for (const m of filtered) {
  let a = agg.get(m.selector);
  if (!a) {
    a = { selector: m.selector, count: 0, byType: {}, byAttr: {}, rect: m.rect, firstT: m.t, lastT: m.t };
    agg.set(m.selector, a);
  }
  a.count++;
  a.byType[m.type] = (a.byType[m.type] || 0) + 1;
  if (m.attrName) a.byAttr[m.attrName] = (a.byAttr[m.attrName] || 0) + 1;
  a.lastT = m.t;
}
const sorted = Array.from(agg.values()).sort((a, b) => b.count - a.count);

writeFileSync(join(outDir, 'probe.json'), JSON.stringify({
  url, seconds, region, totalMutations: mutations.length, filteredMutations: filtered.length,
  animations, topSelectors: sorted.slice(0, 30),
}, null, 2));

// Summary markdown.
const md: string[] = [];
md.push(`# DOM probe — ${url}`);
md.push('');
md.push(`Observed **${seconds}s** of steady-state (post-hydration). `);
md.push(`Total mutations: **${mutations.length}**${region ? ` (in region: ${filtered.length})` : ''}.`);
md.push(`WAAPI/CSS animations running: **${animations.length}**.`);
md.push('');
md.push('## Top animating elements');
md.push('');
md.push('| selector | count | types | attrs | rect | first→last (s) |');
md.push('|----------|------:|-------|-------|------|----------------|');
for (const a of sorted.slice(0, 15)) {
  const types = Object.entries(a.byType).map(([k, v]) => `${k}:${v}`).join(' ');
  const attrs = Object.entries(a.byAttr).map(([k, v]) => `${k}:${v}`).join(' ') || '—';
  const rect = a.rect ? `${a.rect.x},${a.rect.y} ${a.rect.w}×${a.rect.h}` : '—';
  md.push(`| \`${a.selector}\` | ${a.count} | ${types} | ${attrs} | ${rect} | ${a.firstT.toFixed(1)}→${a.lastT.toFixed(1)} |`);
}
md.push('');
if (animations.length) {
  md.push('## Active WAAPI / CSS animations');
  md.push('');
  md.push('| target | playState | keyframes |');
  md.push('|--------|-----------|----------:|');
  for (const a of animations.slice(0, 20)) {
    md.push(`| \`${a.target || '(anon)'}\` | ${a.playState} | ${a.keyframeCount} |`);
  }
  md.push('');
}
md.push('Full records in `probe.json`. Final viewport screenshot: `probe-final.png`.');

writeFileSync(join(outDir, 'probe.md'), md.join('\n') + '\n');
console.log(`wrote ${join(outDir, 'probe.md')}`);
