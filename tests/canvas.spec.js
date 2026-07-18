// @ts-check
// Canvas-animation freezing (main-world-patch.js + content.js coordination).
// Guards the classifier (an animating canvas must freeze; static, tiny, and
// sporadically-redrawn canvases must survive), the interaction exemption
// (click unfreezes, wheel must NOT), and the cross-world contracts: the badge
// bridge (data-still-canvas -> imageFrozen), the data-still-off handshake with
// its unfreeze pass, and the isolated-world defense of data-still-off against
// page writes. Real-GPU behaviour (WebGL preserveDrawingBuffer freeze, worker
// tick-feed classification) is covered by tests/motion on the virtual display.
//
// Pages are loaded as data: URLs (not page.setContent) so the main-world patch
// runs on the FINAL document — setContent replaces the document after init
// scripts run, dropping the patch's document-level listeners/observers (a
// test-harness artifact, not a real one).
const { test, expect } = require('@playwright/test');
const path = require('path');

const MAIN_WORLD_PATCH = path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js');
const CONTENT_SCRIPT = path.resolve(__dirname, '..', 'web-extension', 'content.js');

const BODY = `<style>canvas{display:block}</style>
<canvas id="anim" width="300" height="200"></canvas>
<canvas id="static" width="300" height="200"></canvas>
<canvas id="tiny" width="40" height="40"></canvas>
<canvas id="sporadic" width="300" height="200"></canvas>
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
  // Sporadic: redraws in bursts spaced beyond RUN_RESET_MS (resize/theme-toggle
  // pattern) — each burst is a fresh run, so it must never classify as
  // animating even though lifetime draw totals grow.
  (function(){ var x=document.getElementById('sporadic').getContext('2d'),n=0;
    function draw(){ n++; x.fillStyle='#66c'; x.fillRect(0,0,300,200); x.fillStyle='#fff'; x.fillRect(n*10,90,20,20);
      if (n < 4) setTimeout(draw, 350); }
    draw(); })();
</script>`;

const dataUrl = (htmlAttrs = '') =>
  'data:text/html,' + encodeURIComponent(`<!doctype html><html ${htmlAttrs}><body>${BODY}</body></html>`);

// Minimal browser-API mock for content.js (mirrors freeze.spec.js's harness):
// sync storage callback, captured sendMessage, dispatchable onMessage.
const BROWSER_MOCK = `
  window.__mock = { state: { enabled: true, allowlist: [] }, sent: [] };
  (function () {
    var listeners = [];
    window.__dispatchMsg = function (m) { listeners.forEach(function (l) { l(m); }); };
    window.browser = {
      storage: { local: { get: function (keys, cb) { if (cb) cb(Object.assign({}, window.__mock.state)); } } },
      runtime: {
        sendMessage: function (m) { window.__mock.sent.push(m); },
        onMessage: { addListener: function (l) { listeners.push(l); } },
        getURL: function (p) { return 'about:blank?' + p; },
      },
    };
  })();
`;

test.describe('canvas animation freezing', () => {
  test('freezes an animating canvas; static, tiny, and sporadic canvases survive', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());

    await page.waitForFunction(
      () => document.getElementById('anim').getAttribute('data-still-canvas') === 'frozen',
      null, { timeout: 5000 });
    // Let the sporadic canvas complete all four bursts (3 x 350ms + slack).
    await page.waitForTimeout(1400);

    const state = await page.evaluate(() => ({
      anim: document.getElementById('anim').getAttribute('data-still-canvas'),
      stat: document.getElementById('static').getAttribute('data-still-canvas'),
      tiny: document.getElementById('tiny').getAttribute('data-still-canvas'),
      sporadic: document.getElementById('sporadic').getAttribute('data-still-canvas'),
      frozenCount: window.__stillCanvas ? window.__stillCanvas.frozenCount() : -1,
    }));

    expect(state.anim).toBe('frozen');     // animating => frozen
    expect(state.stat).toBeNull();         // static one-shot => untouched
    expect(state.tiny).toBeNull();         // below size gate => untouched
    expect(state.sporadic).toBeNull();     // bursts beyond RUN_RESET_MS => untouched
    expect(state.frozenCount).toBe(1);
  });

  test('unfreezes a canvas the user clicks', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());
    await page.waitForFunction(
      () => document.getElementById('anim').getAttribute('data-still-canvas') === 'frozen',
      null, { timeout: 5000 });
    // A click on the canvas marks it user-driven (game/map/editor) => unfreeze.
    await page.locator('#anim').click();
    await page.waitForFunction(
      () => document.getElementById('anim').getAttribute('data-still-canvas') === null,
      null, { timeout: 2000 });
  });

  test('wheel-scrolling over a frozen canvas does NOT unfreeze it', async ({ page }) => {
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());
    await page.waitForFunction(
      () => document.getElementById('anim').getAttribute('data-still-canvas') === 'frozen',
      null, { timeout: 5000 });
    // Scroll with the pointer over the canvas — the background-canvas case.
    // Both a real wheel gesture and direct wheel/touchstart dispatch must
    // leave the freeze intact; only click/keydown express intent.
    const box = await page.locator('#anim').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 200);
    await page.evaluate(() => {
      const c = document.getElementById('anim');
      c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
      c.dispatchEvent(new Event('touchstart', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    const anim = await page.evaluate(() => document.getElementById('anim').getAttribute('data-still-canvas'));
    expect(anim).toBe('frozen');
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

  test('content.js: counts freezes on the badge, defends data-still-off, unfreezes on disable', async ({ page }) => {
    await page.addInitScript({ content: BROWSER_MOCK });
    await page.addInitScript({ path: MAIN_WORLD_PATCH });
    await page.goto(dataUrl());
    await page.waitForFunction(
      () => document.getElementById('anim').getAttribute('data-still-canvas') === 'frozen',
      null, { timeout: 5000 });

    // Inject content.js AFTER the freeze landed — exercises the sweep path
    // (countFrozenCanvases) that covers freezes predating the observer.
    await page.addScriptTag({ path: CONTENT_SCRIPT });
    await page.waitForFunction(
      () => (window.__mock.sent || []).some((m) => m.type === 'imageFrozen'),
      null, { timeout: 3000 });

    // Defense: a page script sets data-still-off (anti-extension move) —
    // content.js must strip it, and the canvas must end up frozen again.
    await page.evaluate(() => document.documentElement.setAttribute('data-still-off', ''));
    await page.waitForFunction(
      () => !document.documentElement.hasAttribute('data-still-off'),
      null, { timeout: 3000 });
    await page.waitForFunction(
      () => document.getElementById('anim').getAttribute('data-still-canvas') === 'frozen',
      null, { timeout: 5000 });

    // Legitimate disable: storage flips, stateChanged arrives — content.js
    // sets data-still-off itself and the patch's observer unfreezes.
    await page.evaluate(() => {
      window.__mock.state.enabled = false;
      window.__dispatchMsg({ type: 'stateChanged' });
    });
    await page.waitForFunction(
      () => document.documentElement.hasAttribute('data-still-off') &&
            document.getElementById('anim').getAttribute('data-still-canvas') === null,
      null, { timeout: 3000 });
  });
});
