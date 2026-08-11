/* End-to-end verification of the gothamist + urop fixes with the REAL
 * extension loaded in headless Chromium (never paints to a display).
 *
 * Usage: npx tsx verify-fixes.mts <path-to-web-extension-dir>
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const extDir = process.argv[2];
if (!extDir) { console.error('need extension dir'); process.exit(1); }

const scratch = dirname(fileURLToPath(import.meta.url));
const userDataDir = join(scratch, '.verify-userdata');
rmSync(userDataDir, { recursive: true, force: true });
mkdirSync(userDataDir, { recursive: true });

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false, // real headless comes from --headless=new below
  args: [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
  ],
  viewport: { width: 1440, height: 900 },
});

const page = await context.newPage();
await page.waitForTimeout(1500); // service worker spin-up

// ---------- gothamist article ----------
const gothamistURL =
  'https://gothamist.com/news/feds-say-captain-overloaded-boat-in-deadly-ny-harbor-capsize-had-no-infant-life-jacket';
try {
  await page.goto(gothamistURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  // Scroll like a reader: repeated wheel steps.
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
  const goth = await page.evaluate(() => {
    const header = document.querySelector('header.article-page-header');
    const prog = document.querySelector('.article-page-header-progress');
    const hostSheet = document.getElementById('__still-host-rules');
    const cs = prog ? getComputedStyle(prog) : null;
    return {
      headerFound: !!header,
      progFound: !!prog,
      hostSheetInjected: !!hostSheet,
      hostSheetText: hostSheet ? hostSheet.textContent : null,
      progBackgroundImage: cs ? cs.backgroundImage : null,
      progBackgroundColor: cs ? cs.backgroundColor : null,
      headerPinned: header ? header.getAttribute('data-still-style') : null,
      headerInlineStyle: header ? header.getAttribute('style') : null,
    };
  });
  console.log('GOTHAMIST:', JSON.stringify(goth, null, 2));

  // Keep scrolling and confirm the custom property no longer changes
  // (either pinned by the detector, or irrelevant thanks to the host rule).
  const before = await page.evaluate(() =>
    document.querySelector('header.article-page-header')?.getAttribute('style'));
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(150);
  }
  const after = await page.evaluate(() =>
    document.querySelector('header.article-page-header')?.getAttribute('style'));
  console.log('GOTHAMIST inline style stable under further scroll:', before === after,
    JSON.stringify({ before, after }));
} catch (e) {
  console.error('gothamist check failed:', (e as Error).message);
}

// ---------- urop.mit.edu ----------
try {
  await page.goto('https://urop.mit.edu/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const urop = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll(
      '#mega-menu-wrap-max_mega_menu_1 .mega-menu-item a.mega-menu-link'));
    const durations = links.slice(0, 8).map((a) => getComputedStyle(a).transitionDuration);
    // Sample some of the hover-pop elements the probe identified.
    const popSelectors = ['.cp--area-hover-zoom', '.urop-path-card', '.wp-block-social-link a'];
    const popDurations = {};
    for (const sel of popSelectors) {
      const el = document.querySelector(sel);
      if (el) popDurations[sel] = getComputedStyle(el).transitionDuration;
    }
    return { megaMenuLinkCount: links.length, megaMenuDurations: durations, popDurations };
  });
  console.log('UROP:', JSON.stringify(urop, null, 2));

  // Live hover on a mega-menu link: sample padding-left at 16ms — must jump
  // instantly, never glide.
  const firstLink = page.locator('#mega-menu-wrap-max_mega_menu_1 a.mega-menu-link').first();
  if (await firstLink.count()) {
    await firstLink.hover();
    const samples = await page.evaluate(async () => {
      const a = document.querySelector('#mega-menu-wrap-max_mega_menu_1 a.mega-menu-link');
      const out: string[] = [];
      for (let i = 0; i < 12; i++) {
        out.push(getComputedStyle(a).paddingLeft);
        await new Promise((r) => setTimeout(r, 16));
      }
      return out;
    });
    console.log('UROP hover padding-left samples:', samples.join(' '));
  }
} catch (e) {
  console.error('urop check failed:', (e as Error).message);
}

await context.close();
console.log('done, browser closed');
