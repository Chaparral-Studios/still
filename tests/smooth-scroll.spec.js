// @ts-check
// Regression tests for programmatic smooth scrolling (user report 2026-08-17:
// a Google SERP image carousel glides sideways to reveal the next set of
// thumbnails — "should just hop immediately to where its going").
//
// A smooth scroll is animation the extension used to miss entirely: it's not
// an <img>, <video>, canvas, SVG, CSS animation or transition, so none of the
// existing defenses see it. Two sources, neutralized in two places:
//   - CSS `scroll-behavior: smooth`  → content.js's universal CSS kill;
//   - JS `{behavior: 'smooth'}`      → main-world-patch.js's method overrides
//     (an explicit behavior in the options dictionary beats the computed style
//     per CSSOM-View, so the CSS alone can't stop these).
// Both must land at the SAME destination — only the glide is removed.
const { test, expect } = require('@playwright/test');
const path = require('path');
const http = require('http');

const CONTENT_SCRIPT = path.resolve(__dirname, '..', 'web-extension', 'content.js');
const MAIN_WORLD_PATCH = path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js');

let server;
let baseURL;

// Carousel-shaped page: a horizontally scrollable strip of tiles plus a tall
// body for vertical-scroll cases. The "next" button advances the strip the
// same way Google's does — scrollTo/scrollBy with behavior:'smooth'.
const PAGE = `<!doctype html><html><head><style>
  #strip { width: 400px; overflow-x: auto; white-space: nowrap; }
  #strip.csssmooth { scroll-behavior: smooth; }
  .tile { display: inline-block; width: 200px; height: 120px; background: #ccc; }
</style></head><body>
  <div id="strip">
    <div class="tile"></div><div class="tile"></div><div class="tile"></div>
    <div class="tile"></div><div class="tile"></div><div class="tile"></div>
    <div class="tile"></div><div class="tile"></div>
  </div>
  <div style="height:3000px">tall body</div>
  <div id="anchor">anchor target</div>
  <script>
    window.strip = document.getElementById('strip');
    // Sample the strip's scrollLeft every frame so a glide is visible as a
    // run of distinct intermediate positions.
    window.startSampling = (el) => {
      window.__frames = [];
      const t0 = performance.now();
      const tick = () => {
        if (performance.now() - t0 > 1500) return;
        window.__frames.push(Math.round(el.scrollLeft || el.scrollTop || window.scrollY));
        requestAnimationFrame(tick);
      };
      tick();
    };
    window.distinctPositions = () =>
      window.__frames.filter((v, i) => i === 0 || v !== window.__frames[i - 1]).length;
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

// A glide produces many distinct intermediate positions; an instant hop
// produces at most a couple (start, end).
const GLIDE_THRESHOLD = 5;

test.describe('smooth scrolling is neutralized', () => {

  test('baseline: without the extension a smooth carousel scroll really does glide', async ({ page }) => {
    await setup(page, { noExtension: true });
    await page.evaluate(() => {
      window.startSampling(window.strip);
      window.strip.scrollTo({ left: 600, behavior: 'smooth' });
    });
    await page.waitForTimeout(1600);
    const { distinct, final } = await page.evaluate(() => ({
      distinct: window.distinctPositions(), final: Math.round(window.strip.scrollLeft)
    }));
    expect(distinct).toBeGreaterThan(GLIDE_THRESHOLD); // it animated
    expect(final).toBe(600);
  });

  test('JS scrollTo({behavior:smooth}) on a carousel hops instantly to the same place', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      window.startSampling(window.strip);
      window.strip.scrollTo({ left: 600, behavior: 'smooth' });
    });
    await page.waitForTimeout(1600);
    const { distinct, final } = await page.evaluate(() => ({
      distinct: window.distinctPositions(), final: Math.round(window.strip.scrollLeft)
    }));
    expect(distinct).toBeLessThanOrEqual(GLIDE_THRESHOLD);
    expect(final).toBe(600); // destination preserved
  });

  test('scrollBy({behavior:smooth}) hops too (the other carousel-arrow idiom)', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      window.startSampling(window.strip);
      window.strip.scrollBy({ left: 400, behavior: 'smooth' });
    });
    await page.waitForTimeout(1600);
    const { distinct, final } = await page.evaluate(() => ({
      distinct: window.distinctPositions(), final: Math.round(window.strip.scrollLeft)
    }));
    expect(distinct).toBeLessThanOrEqual(GLIDE_THRESHOLD);
    expect(final).toBe(400);
  });

  test('CSS scroll-behavior:smooth is overridden (no options object involved)', async ({ page }) => {
    await setup(page);
    // The site declares smooth in CSS and calls the positional form, which
    // defers to the computed style — this is the CSS kill's job.
    const behavior = await page.evaluate(() => {
      window.strip.classList.add('csssmooth');
      return getComputedStyle(window.strip).scrollBehavior;
    });
    expect(behavior).toBe('auto');

    await page.evaluate(() => {
      window.startSampling(window.strip);
      window.strip.scrollLeft = 600;
    });
    await page.waitForTimeout(1200);
    const { distinct, final } = await page.evaluate(() => ({
      distinct: window.distinctPositions(), final: Math.round(window.strip.scrollLeft)
    }));
    expect(distinct).toBeLessThanOrEqual(GLIDE_THRESHOLD);
    expect(final).toBe(600);
  });

  test('window.scrollTo({behavior:smooth}) — "back to top" buttons jump', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.startSampling(document.documentElement);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    await page.waitForTimeout(1600);
    const { distinct, final } = await page.evaluate(() => ({
      distinct: window.distinctPositions(), final: Math.round(window.scrollY)
    }));
    expect(distinct).toBeLessThanOrEqual(GLIDE_THRESHOLD);
    expect(final).toBe(0);
  });

  test('scrollIntoView({behavior:smooth}) jumps to the anchor', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      window.startSampling(document.documentElement);
      document.getElementById('anchor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    await page.waitForTimeout(1600);
    const distinct = await page.evaluate(() => window.distinctPositions());
    const onScreen = await page.evaluate(() => {
      const r = document.getElementById('anchor').getBoundingClientRect();
      return r.top >= -5 && r.top < window.innerHeight;
    });
    expect(distinct).toBeLessThanOrEqual(GLIDE_THRESHOLD);
    expect(onScreen).toBe(true); // still arrived at the target
  });

  test('positional and boolean forms still work (no destination regressions)', async ({ page }) => {
    await setup(page);
    const results = await page.evaluate(() => {
      const out = {};
      window.strip.scrollTo(300, 0);
      out.stripAfterPositional = Math.round(window.strip.scrollLeft);
      window.scrollTo(0, 1500);
      out.windowAfterPositional = Math.round(window.scrollY);
      window.scrollTo({ top: 500 }); // options form, no behavior key
      out.windowAfterOptions = Math.round(window.scrollY);
      document.getElementById('anchor').scrollIntoView(true); // boolean form
      out.anchorVisible = (() => {
        const r = document.getElementById('anchor').getBoundingClientRect();
        return r.top >= -5 && r.top < window.innerHeight;
      })();
      return out;
    });
    expect(results.stripAfterPositional).toBe(300);
    expect(results.windowAfterPositional).toBe(1500);
    expect(results.windowAfterOptions).toBe(500);
    expect(results.anchorVisible).toBe(true);
  });

  test('the caller\'s own options object is not mutated', async ({ page }) => {
    await setup(page);
    const behaviorAfter = await page.evaluate(() => {
      const opts = { left: 200, behavior: 'smooth' };
      window.strip.scrollTo(opts);
      return opts.behavior; // sites reuse and read back their config
    });
    expect(behaviorAfter).toBe('smooth');
  });

  test('when the extension is disabled, smooth scrolling is left alone', async ({ page }) => {
    // Disable through the real path — content.js owns `data-still-off` and
    // reverts page-side writes to it, so a test can't fake the off state.
    await setup(page, { enabled: false });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-still-off'));
    await page.evaluate(() => {
      window.startSampling(window.strip);
      window.strip.scrollTo({ left: 600, behavior: 'smooth' });
    });
    await page.waitForTimeout(1600);
    const distinct = await page.evaluate(() => window.distinctPositions());
    expect(distinct).toBeGreaterThan(GLIDE_THRESHOLD);
  });
});
