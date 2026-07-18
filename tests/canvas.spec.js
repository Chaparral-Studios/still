// @ts-check
// Canvas-animation freezing (main-world-patch.js). Exercises the detect-and-
// freeze logic headlessly: an animating canvas must freeze; a static one-shot
// canvas and a sub-threshold tiny canvas must be left untouched. The real-GPU
// behaviour (WebGL preserveDrawingBuffer freeze, worker/offscreen path) is
// covered by tests/motion (virtual display) — this guards the classifier so a
// regression that freezes static canvases or misses animating ones fails CI.
//
// The page is loaded as a data: URL (not page.setContent) so the main-world
// patch runs on the FINAL document — setContent replaces the document after
// init scripts run, which drops the document-level interaction listeners the
// patch installs at document_start (a test-harness artifact, not a real one).
const { test, expect } = require('@playwright/test');
const path = require('path');

const MAIN_WORLD_PATCH = path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js');

const BODY = `<style>canvas{display:block}</style>
<canvas id="anim" width="300" height="200"></canvas>
<canvas id="static" width="300" height="200"></canvas>
<canvas id="tiny" width="40" height="40"></canvas>
<script>
  // Animating: clears + draws a moving rect every frame.
  (function(){ var x=document.getElementById('anim').getContext('2d'),t=0;
    (function loop(){ t+=4; x.clearRect(0,0,300,200); x.fillStyle='#c33'; x.fillRect(t%300,80,40,40); requestAnimationFrame(loop); })(); })();
  // Static one-shot: draws exactly once.
  (function(){ var x=document.getElementById('static').getContext('2d');
    x.fillStyle='#2a2'; x.fillRect(0,0,300,200); })();
  // Tiny animating: below the size gate, must be ignored.
  (function(){ var x=document.getElementById('tiny').getContext('2d'),t=0;
    (function loop(){ t+=2; x.clearRect(0,0,40,40); x.fillStyle='#39c'; x.fillRect(t%40,10,10,10); requestAnimationFrame(loop); })(); })();
</script>`;

const dataUrl = (htmlAttrs = '') =>
  'data:text/html,' + encodeURIComponent(`<!doctype html><html ${htmlAttrs}><body>${BODY}</body></html>`);

test.describe('canvas animation freezing', () => {
  test('freezes an animating canvas, leaves static and tiny canvases alone', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());

    await page.waitForFunction(
      () => document.getElementById('anim').getAttribute('data-still-canvas') === 'frozen',
      null, { timeout: 5000 });

    const state = await page.evaluate(() => ({
      anim: document.getElementById('anim').getAttribute('data-still-canvas'),
      stat: document.getElementById('static').getAttribute('data-still-canvas'),
      tiny: document.getElementById('tiny').getAttribute('data-still-canvas'),
      frozenCount: window.__stillCanvas ? window.__stillCanvas.frozenCount() : -1,
    }));

    expect(state.anim).toBe('frozen');     // animating => frozen
    expect(state.stat).toBeNull();         // static one-shot => untouched
    expect(state.tiny).toBeNull();         // below size gate => untouched
    expect(state.frozenCount).toBe(1);
  });

  test('unfreezes a canvas the user interacts with', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());
    await page.waitForFunction(
      () => document.getElementById('anim').getAttribute('data-still-canvas') === 'frozen',
      null, { timeout: 5000 });
    // A click on the canvas marks it user-driven (game/map/editor) => unfreeze.
    await page.locator('#anim').click();
    await page.waitForTimeout(200);
    const anim = await page.evaluate(() => document.getElementById('anim').getAttribute('data-still-canvas'));
    expect(anim).toBeNull();
  });

  test('respects data-still-off (disabled / allowlisted): no freeze', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl('data-still-off'));
    await page.waitForTimeout(1200);
    const state = await page.evaluate(() => ({
      anim: document.getElementById('anim').getAttribute('data-still-canvas'),
      frozenCount: window.__stillCanvas ? window.__stillCanvas.frozenCount() : -1,
    }));
    expect(state.anim).toBeNull();
    expect(state.frozenCount).toBe(0);
  });
});
