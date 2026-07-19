// @ts-check
// Shadow-DOM SVG settling (main-world-patch.js inline-hide path).
// The document-level CSS rule `svg [data-still-svg-settling]` cannot pierce
// shadow roots, so geometry-mutation animations inside web components (ADP's
// Stencil-wrapped Highcharts pie) are hidden with inline style during their
// active run and restored once writes settle. Guards: one-shot fills reveal
// fully drawn, continuous animations stay hidden, light-DOM behavior is
// unchanged (attribute only, no inline style), data-still-off disables and
// undoes hides, and a pre-existing inline visibility value survives.
//
// Pages are loaded as data: URLs (not page.setContent) for the same reason as
// canvas.spec.js: setContent replaces the document after init scripts run,
// dropping the patch's document-level listeners/observers.
const { test, expect } = require('@playwright/test');
const path = require('path');

const MAIN_WORLD_PATCH = path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js');

// A shadow host whose open root contains a pie-like <svg><path>, plus a
// light-DOM control svg. `window.__anim(el, ms)` rewrites the path's `d`
// every rAF for `ms` (0 = forever), Highcharts-sweep style.
const BODY = `
<div id="host"></div>
<svg id="light-svg" width="200" height="200"><path id="light-path" d="M 0 0 L 10 10"></path></svg>
<script>
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<svg width="200" height="200"><path id="pie" d="M 100 20 A 80 80 0 0 1 100 20 Z"></path></svg>';
  window.__pie = root.getElementById('pie');
  window.__anim = function (el, ms) {
    const t0 = performance.now();
    let a = 0;
    (function tick() {
      if (ms && performance.now() - t0 > ms) return;
      a += 0.1;
      const x = 100 + 80 * Math.sin(a), y = 100 - 80 * Math.cos(a);
      el.setAttribute('d', 'M 100 20 A 80 80 0 0 1 ' + x + ' ' + y + ' L 100 100 Z');
      requestAnimationFrame(tick);
    })();
  };
</script>`;

const dataUrl = (htmlAttrs = '') =>
  'data:text/html,' + encodeURIComponent(`<!doctype html><html ${htmlAttrs}><body>${BODY}</body></html>`);

test.describe('shadow-DOM SVG settling', () => {
  test('one-shot fill: hidden inline during the sweep, restored after settle', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());
    await page.evaluate(() => window.__anim(window.__pie, 600));

    // Mid-sweep: attribute marked AND inline-hidden (CSS can't reach in here).
    await page.waitForFunction(
      () => window.__pie.hasAttribute('data-still-svg-settling') &&
            window.__pie.style.getPropertyValue('visibility') === 'hidden' &&
            window.__pie.style.getPropertyPriority('visibility') === 'important',
      null, { timeout: 2000 });
    expect(await page.evaluate(() => window.__stillSvg.shadowHiddenCount())).toBe(1);

    // Sweep ends at 600ms; settle window is 300ms — both must clear.
    await page.waitForFunction(
      () => !window.__pie.hasAttribute('data-still-svg-settling') &&
            window.__pie.style.getPropertyValue('visibility') === '',
      null, { timeout: 3000 });
    expect(await page.evaluate(() => window.__stillSvg.shadowHiddenCount())).toBe(0);
  });

  test('continuous animation stays hidden', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());
    await page.evaluate(() => window.__anim(window.__pie, 0)); // forever
    await page.waitForFunction(
      () => window.__pie.style.getPropertyValue('visibility') === 'hidden',
      null, { timeout: 2000 });
    await page.waitForTimeout(800); // well past SETTLE_MS; writes keep coming
    expect(await page.evaluate(
      () => window.__pie.style.getPropertyValue('visibility'))).toBe('hidden');
  });

  test('light-DOM settling is attribute-only (no inline style added)', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());
    await page.evaluate(() => window.__anim(document.getElementById('light-path'), 400));
    await page.waitForFunction(
      () => document.getElementById('light-path').hasAttribute('data-still-svg-settling'),
      null, { timeout: 2000 });
    const state = await page.evaluate(() => ({
      inline: document.getElementById('light-path').style.getPropertyValue('visibility'),
      count: window.__stillSvg.shadowHiddenCount(),
    }));
    expect(state.inline).toBe(''); // CSS rule handles light DOM; inline path must not fire
    expect(state.count).toBe(0);
  });

  test('respects data-still-off: no inline hide', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl('data-still-off'));
    await page.evaluate(() => window.__anim(window.__pie, 600));
    await page.waitForTimeout(400); // give the sweep time to run
    expect(await page.evaluate(
      () => window.__pie.style.getPropertyValue('visibility'))).toBe('');
    expect(await page.evaluate(() => window.__stillSvg.shadowHiddenCount())).toBe(0);
  });

  test('disable mid-animation unhides via the off-observer', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());
    await page.evaluate(() => window.__anim(window.__pie, 0)); // forever
    await page.waitForFunction(
      () => window.__pie.style.getPropertyValue('visibility') === 'hidden',
      null, { timeout: 2000 });
    await page.evaluate(() => document.documentElement.setAttribute('data-still-off', ''));
    await page.waitForFunction(
      () => window.__pie.style.getPropertyValue('visibility') === '',
      null, { timeout: 2000 });
    expect(await page.evaluate(() => window.__stillSvg.shadowHiddenCount())).toBe(0);
  });

  test('pre-existing inline visibility is restored, not clobbered', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());
    await page.evaluate(() => {
      window.__pie.style.setProperty('visibility', 'visible');
      window.__anim(window.__pie, 500);
    });
    await page.waitForFunction(
      () => window.__pie.style.getPropertyValue('visibility') === 'hidden',
      null, { timeout: 2000 });
    await page.waitForFunction(
      () => window.__pie.style.getPropertyValue('visibility') === 'visible',
      null, { timeout: 3000 });
  });
});
