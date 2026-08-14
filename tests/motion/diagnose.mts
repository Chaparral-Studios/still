// Instrumented headless run: load Still, visit URL, and SAMPLE every ~2s for
// the full duration, recording any transient animation/playback survivor in
// any frame. Never paints to a display.
// Usage: tsx diagnose.mts <url> <extDir> [cookiesFile] [outDir] [seconds]
import { chromium as rawChromium, type Cookie, type Frame } from '@playwright/test';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const chromium = addExtra(rawChromium);
chromium.use(StealthPlugin());

const url = process.argv[2] || 'https://www.whathifi.com';
const extDir = resolve(process.argv[3] || 'web-extension');
const cookiesFile = process.argv[4];
const outDir = resolve(process.argv[5] || '/tmp/still-diagnose');
const seconds = parseInt(process.argv[6] || '120', 10);
mkdirSync(outDir, { recursive: true });

const context = await chromium.launchPersistentContext(join(outDir, '.userdata'), {
  headless: false,
  args: [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
  ],
  viewport: { width: 1280, height: 800 },
});

if (cookiesFile && existsSync(cookiesFile)) {
  const cookies: Cookie[] = JSON.parse(readFileSync(cookiesFile, 'utf8'));
  for (const c of cookies) {
    if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax';
    try { await context.addCookies([c]); } catch {}
  }
}

const page = await context.newPage();
await page.waitForTimeout(1500);
try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { console.error('goto:', (e as Error).message); }

async function sampleFrame(frame: Frame) {
  return frame.evaluate(() => {
    const anims = (document.getAnimations ? document.getAnimations({ subtree: true } as any) : []) as Animation[];
    const running = anims.filter((a) => a.playState === 'running').map((a) => {
      const eff: any = a.effect;
      const t = eff && eff.getComputedTiming ? eff.getComputedTiming() : {};
      const target = eff && eff.target ? eff.target : null;
      const cls = target ? (target.className && (target.className as any).baseVal !== undefined ? (target.className as any).baseVal : target.className) : '';
      return {
        type: a.constructor.name,
        name: (a as any).animationName || (a as any).transitionProperty || '',
        iterations: t.iterations === Infinity ? 'Infinity' : t.iterations,
        duration: t.duration,
        target: target ? `${target.tagName}.${String(cls || '').slice(0, 60)}` : null,
      };
    // CSS transitions are one-shot UI easing, not ongoing animation — ignore.
    }).filter((r) => r.type !== 'CSSTransition');
    const playing = [...document.querySelectorAll('video')].filter((v) => !v.paused).map((v) => ({
      autoplay: v.autoplay, muted: v.muted,
      userPlay: v.hasAttribute('data-still-user-play'),
      t: v.currentTime,
      src: (v.currentSrc || v.src || '').slice(0, 140),
      cls: String(v.className || '').slice(0, 60),
    }));
    const liveCanvases = [...document.querySelectorAll('canvas')]
      .filter((c) => !c.getAttribute('data-still-canvas') && c.width > 30 && c.height > 30)
      .map((c) => ({ w: c.width, h: c.height, cls: String(c.className || '').slice(0, 60) }));
    return { running, playing, liveCanvases };
  });
}

const incidents: any[] = [];
const t0 = Date.now();
// Scroll pattern: down through the page early (triggers lazy slots + sticky
// player), then sit — ad refresh happens on a timer regardless.
const scrollPlan: Record<number, number> = { 3: 600, 6: 1200, 9: 2000, 12: 2800, 15: 1200 };
let tick = 0;
while ((Date.now() - t0) / 1000 < seconds) {
  const tSec = Math.round((Date.now() - t0) / 1000);
  if (scrollPlan[tick] !== undefined) {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), scrollPlan[tick]).catch(() => {});
  }
  for (const frame of page.frames()) {
    try {
      const s = await Promise.race([
        sampleFrame(frame),
        new Promise<null>((res) => setTimeout(() => res(null), 1000)),
      ]);
      if (s && (s.running.length || s.playing.length || s.liveCanvases.length)) {
        incidents.push({ t: tSec, url: frame.url().slice(0, 160), ...s });
      }
    } catch {}
  }
  tick++;
  await page.waitForTimeout(2000);
}

writeFileSync(join(outDir, 'incidents.json'), JSON.stringify(incidents, null, 2));
console.log(JSON.stringify({
  samples: tick,
  incidentCount: incidents.length,
  byUrl: Object.fromEntries(incidents.reduce((m: Map<string, number>, i: any) => m.set(i.url, (m.get(i.url) || 0) + 1), new Map())),
}, null, 2));
console.log(JSON.stringify(incidents.slice(0, 40), null, 2));
await context.close();
