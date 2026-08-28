// @ts-check
// Regression tests for JS-driven motion — rAF animation libraries (GSAP,
// ScrollTrigger, Webflow IX2, parallax scripts) that animate by writing inline
// `transform` / `opacity` / `filter` every frame.
//
// User report 2026-08-27: claude.com/product/claude-science "begins to have
// horrible animations" as you scroll. Measured before this feature, the
// extension had zero effect on that page — residual motion after the wheel
// stopped was 2041 rendered states with Still vs 2096 without. The motion is
// invisible to every other defense: document.getAnimations() returns nothing,
// nothing transitions, and the custom-property pinner only fires when every
// changed property is a `--*` var.
//
// The contract, mirroring the scrollLeft withholding in main-world-patch.js:
// the element must ARRIVE where the page intended, having moved once instead
// of sixty times. Tests therefore assert both "few distinct rendered states"
// and "lands on the destination".
const { test, expect } = require('@playwright/test');
const path = require('path');
const http = require('http');

const CONTENT_SCRIPT = path.resolve(__dirname, '..', 'web-extension', 'content.js');
const MAIN_WORLD_PATCH = path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js');

let server;
let baseURL;

const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; }
  .box { width: 100px; height: 100px; background: #4a7; }
  #spacer { height: 3000px; }
</style></head><body>
  <div id="reveal" class="box"></div>
  <div id="looper" class="box"></div>
  <div id="vlist" class="box"></div>
  <div id="dragme" class="box"></div>
  <div id="spacer"></div>
  <script>
    // Rendered-geometry sampler. Deliberately NOT reading el.style: the
    // extension reverts withheld writes in the observer, so inline style would
    // report the held value rather than what the user sees. Position is
    // measured document-relative so scrolling isn't mistaken for motion.
    window.startSampling = (id, ms = 1500) => {
      const el = document.getElementById(id);
      window.__frames = [];
      const t0 = performance.now();
      const tick = () => {
        if (performance.now() - t0 > ms) { window.__samplingDone = true; return; }
        const r = el.getBoundingClientRect();
        window.__frames.push(
          Math.round(r.left) + ',' + Math.round(r.top + window.scrollY) + ',' +
          getComputedStyle(el).opacity.slice(0, 4));
        requestAnimationFrame(tick);
      };
      window.__samplingDone = false;
      tick();
    };
    window.distinctStates = () =>
      window.__frames.filter((v, i) => i === 0 || v !== window.__frames[i - 1]).length;
    window.finalState = () => window.__frames[window.__frames.length - 1];

    // A GSAP-shaped tween: rAF loop writing inline transform + opacity every
    // frame. This is exactly what gsap.from({y: 40, opacity: 0}) compiles to
    // in terms of DOM effect.
    window.tween = (id, ms = 600, opts = {}) => {
      const el = document.getElementById(id);
      const t0 = performance.now();
      window.__tweenDone = false;
      const step = () => {
        const p = Math.min(1, (performance.now() - t0) / ms);
        el.style.transform = 'translateY(' + ((1 - p) * 40).toFixed(2) + 'px)';
        if (!opts.noOpacity) el.style.opacity = String(p.toFixed(3));
        if (p < 1) requestAnimationFrame(step);
        else window.__tweenDone = true;
      };
      step();
    };

    // An endless loop animation (a marquee, a spinner, a breathing glow).
    window.loop = (id) => {
      const el = document.getElementById(id);
      const t0 = performance.now();
      const step = () => {
        const t = (performance.now() - t0) / 1000;
        el.style.transform = 'translateX(' + (Math.sin(t) * 50).toFixed(2) + 'px)';
        window.__loopRaf = requestAnimationFrame(step);
      };
      step();
    };

    // A virtualized list: repositions ONLY in response to scroll events, and
    // stops the instant scrolling does. Must keep working.
    window.virtualize = (id) => {
      const el = document.getElementById(id);
      window.addEventListener('scroll', () => {
        el.style.transform = 'translateY(' + Math.round(window.scrollY) + 'px)';
      }, { passive: true });
    };
  </script>
</body></html>`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function setup(page, opts = {}) {
  await page.addInitScript((enabled) => {
    window.browser = {
      storage: { local: { get(keys, cb) { cb({ enabled, allowlist: [] }); }, set() {} } },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() { return Promise.resolve(); },
        getURL(p) { return 'http://127.0.0.1:1/' + p; }
      }
    };
  }, opts.enabled !== false);
  await page.goto(baseURL + '/');
  if (!opts.noExtension) {
    await page.addScriptTag({ path: MAIN_WORLD_PATCH });
    await page.addScriptTag({ path: CONTENT_SCRIPT });
    await page.waitForTimeout(200);
  }
}

// A glide renders dozens of distinct states; a hop renders a couple.
const GLIDE_THRESHOLD = 6;

test.describe('JS-driven motion is withheld', () => {

  test('an unblocked rAF tween glides (the bug this fixes)', async ({ page }) => {
    await setup(page, { noExtension: true });
    await page.evaluate(() => { window.startSampling('reveal'); window.tween('reveal'); });
    await page.waitForFunction(() => window.__samplingDone);
    const distinct = await page.evaluate(() => window.distinctStates());
    expect(distinct).toBeGreaterThan(20);
  });

  test('a rAF tween hops to its destination instead of gliding', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.startSampling('reveal'); window.tween('reveal'); });
    await page.waitForFunction(() => window.__samplingDone);
    const distinct = await page.evaluate(() => window.distinctStates());
    expect(distinct).toBeLessThanOrEqual(GLIDE_THRESHOLD);
  });

  test('the tween still LANDS on its final value', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.tween('reveal', 400));
    await page.waitForFunction(() => window.__tweenDone);
    await page.waitForTimeout(400); // settle + land
    const state = await page.evaluate(() => {
      const r = document.getElementById('reveal').getBoundingClientRect();
      return { top: Math.round(r.top), opacity: getComputedStyle(document.getElementById('reveal')).opacity };
    });
    // Destination is translateY(0) and opacity 1 — the resting state.
    expect(state.opacity).toBe('1');
    expect(state.top).toBe(0);
  });

  // The failure mode that makes naive pinning unusable: a reveal tween that
  // starts at opacity 0 must never be frozen there, or the extension hides
  // content the user came to read.
  test('a reveal is never held invisible while it is withheld', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.tween('reveal', 3000)); // long, still running
    await page.waitForTimeout(500);
    const opacity = await page.evaluate(() =>
      getComputedStyle(document.getElementById('reveal')).opacity);
    expect(Number(opacity)).toBeGreaterThan(0.5);
  });

  test('an endless loop animation stays frozen', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.loop('looper'); });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.startSampling('looper', 1200));
    await page.waitForFunction(() => window.__samplingDone);
    const distinct = await page.evaluate(() => window.distinctStates());
    expect(distinct).toBeLessThanOrEqual(GLIDE_THRESHOLD);
  });

  test('the element is marked while withheld', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.loop('looper'); });
    await page.waitForTimeout(300);
    expect(await page.getAttribute('#looper', 'data-still-motion')).toBe('withheld');
  });

  // Scroll-response repositioning must survive: freezing a virtualized list
  // mid-scroll strands rows and leaves blanks, which reads as broken.
  test('scroll-driven repositioning is left alone while scrolling', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.virtualize('vlist'));
    await page.mouse.move(200, 300);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 60); await page.waitForTimeout(60); }
    await page.waitForTimeout(50);
    const offset = await page.evaluate(() => {
      const m = /translateY\(([-\d.]+)px\)/.exec(document.getElementById('vlist').style.transform);
      return { written: m ? Math.round(Number(m[1])) : null, scrollY: Math.round(window.scrollY) };
    });
    expect(offset.written).toBe(offset.scrollY);
  });

  // ...but an element that keeps animating after the wheel goes quiet has
  // proved it runs on its own clock, and is withheld from then on.
  test('an element that outlives scroll input is marked a self-animator', async ({ page }) => {
    await setup(page);
    await page.mouse.move(200, 300);
    await page.evaluate(() => { window.loop('looper'); });
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 60); await page.waitForTimeout(60); }
    await page.waitForTimeout(400);
    expect(await page.evaluate(() =>
      window.__still.isSelfAnimator(document.getElementById('looper')))).toBe(true);
  });

  test('a drag is never withheld', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      const el = document.getElementById('dragme');
      document.addEventListener('pointermove', (e) => {
        el.style.transform = 'translateX(' + e.clientX + 'px)';
      });
    });
    await page.mouse.move(400, 400);
    await page.mouse.down();
    for (let x = 400; x < 520; x += 15) { await page.mouse.move(x, 400); await page.waitForTimeout(20); }
    const written = await page.evaluate(() => document.getElementById('dragme').style.transform);
    await page.mouse.up();
    expect(written).toContain('translateX(5');
  });

  test('nothing is withheld when the extension is disabled', async ({ page }) => {
    await setup(page, { enabled: false });
    await page.evaluate(() => { window.startSampling('reveal'); window.tween('reveal'); });
    await page.waitForFunction(() => window.__samplingDone);
    expect(await page.evaluate(() => window.distinctStates())).toBeGreaterThan(20);
  });

  test('ordinary one-off style writes are untouched', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      document.getElementById('reveal').style.transform = 'translateX(123px)';
    });
    await page.waitForTimeout(250);
    const left = await page.evaluate(() =>
      Math.round(document.getElementById('reveal').getBoundingClientRect().left));
    expect(left).toBe(123);
  });
});
