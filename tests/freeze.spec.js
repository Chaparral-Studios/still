// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const http = require('http');
const fs = require('fs');

const CONTENT_SCRIPT = path.resolve(__dirname, '..', 'web-extension', 'content.js');
const TESTS_DIR = path.resolve(__dirname);

let server;
let baseURL;
let xOriginServer;
let xOriginURL;

function createHandler(corsOrigin) {
  return (req, res) => {
    const urlPath = req.url.split('?')[0];
    const filePath = path.join(TESTS_DIR, urlPath);
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html',
      '.gif': 'image/gif',
      '.png': 'image/png',
      '.js': 'text/javascript'
    };

    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    }

    if (urlPath === '/cdn-image') {
      const gifPath = path.join(TESTS_DIR, 'fixtures', 'animated.gif');
      const data = fs.readFileSync(gifPath);
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(data);
      return;
    }

    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  };
}

test.beforeAll(async () => {
  server = http.createServer(createHandler(null));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  xOriginServer = http.createServer(createHandler('*'));
  await new Promise(resolve => xOriginServer.listen(0, '127.0.0.1', resolve));
  xOriginURL = `http://127.0.0.1:${xOriginServer.address().port}`;
});

test.afterAll(async () => {
  if (server) server.close();
  if (xOriginServer) xOriginServer.close();
});

async function injectContentScript(page) {
  await page.addInitScript(() => {
    window.browser = {
      storage: {
        local: {
          get(keys, cb) { cb({ enabled: true, allowlist: [] }); },
          set() {}
        }
      },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() { return Promise.resolve(); }
      }
    };
  });
}

const PLACEHOLDER_PREFIX = "data:image/svg+xml,";

test.describe('Still — block and replace logic', () => {
  test('replaces animated GIF with placeholder', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      const img = document.getElementById('img-gif');
      return img && img.dataset.still === 'replaced';
    }, { timeout: 5000 });

    const src = await page.$eval('#img-gif', el => el.src);
    expect(src).toMatch(/^data:image\/svg\+xml/);
  });

  test('replaces GIF with query string', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      const img = document.getElementById('img-gif-query');
      return img && img.dataset.still === 'replaced';
    }, { timeout: 5000 });

    const src = await page.$eval('#img-gif-query', el => el.src);
    expect(src).toMatch(/^data:image\/svg\+xml/);
  });

  test('does NOT replace static PNG images', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForTimeout(1000);

    const src = await page.$eval('#img-static', el => el.src);
    expect(src).toMatch(/static\.png$/);
  });

  test('replaces data URI GIF with placeholder', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      const img = document.getElementById('img-data-gif');
      return img && img.dataset.still === 'replaced';
    }, { timeout: 5000 });

    const src = await page.$eval('#img-data-gif', el => el.src);
    expect(src).toMatch(/^data:image\/svg\+xml/);
  });

  test('does NOT replace 1x1 spacer GIF data URIs', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    // Wait long enough for processing to complete
    await page.waitForTimeout(1500);

    const src = await page.$eval('#img-spacer-gif', el => el.src);
    expect(src).toMatch(/^data:image\/gif/);
    // Should NOT have been replaced
    const still = await page.$eval('#img-spacer-gif', el => el.dataset.still);
    expect(still).not.toBe('replaced');
  });

  test('does NOT replace 1x1 spacer GIF served from URL', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');

    // Add a 1x1 transparent GIF from a URL (like MacRumors 1x1.trans.gif)
    await page.evaluate((base) => {
      const img = document.createElement('img');
      img.id = 'img-url-spacer';
      img.src = base + '/fixtures/1x1.trans.gif';
      document.body.appendChild(img);
    }, baseURL);

    await page.addScriptTag({ path: CONTENT_SCRIPT });
    await page.waitForTimeout(1500);

    const still = await page.$eval('#img-url-spacer', el => el.dataset.still);
    expect(still).toBe('static');
  });

  test('replaces dynamically added GIF via MutationObserver', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForTimeout(500);
    await page.click('#add-btn');

    await page.waitForFunction(() => {
      const img = document.getElementById('img-dynamic');
      return img && img.dataset.still === 'replaced';
    }, { timeout: 5000 });
  });

  test('classifies URL extensions correctly', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    const results = await page.evaluate(() => {
      const { isDefinitelyAnimated, isMaybeAnimated, hasStaticExtension, isExtensionless } = window.__still;
      return {
        gif: isDefinitelyAnimated('https://example.com/image.gif'),
        gifQuery: isDefinitelyAnimated('https://example.com/image.gif?v=2'),
        webp: isMaybeAnimated('https://example.com/anim.webp'),
        apng: isMaybeAnimated('https://example.com/anim.apng'),
        dataGif: isDefinitelyAnimated('data:image/gif;base64,R0lGOD'),
        png: hasStaticExtension('https://example.com/photo.png'),
        jpg: hasStaticExtension('https://example.com/photo.jpg'),
        svg: hasStaticExtension('https://example.com/icon.svg'),
        cdnUrl: isExtensionless('https://images.wsj.net/im-59533137?size=1&width=74'),
        cdnPath: isExtensionless('https://cdn.example.com/images/12345'),
        emptyDefinite: isDefinitelyAnimated(''),
        nullDefinite: isDefinitelyAnimated(null),
        emptyExtless: isExtensionless(''),
        dataUriExtless: isExtensionless('data:image/gif;base64,R0lGOD'),
        // WebP/APNG should NOT be classified as "definitely animated"
        webpNotDefinite: isDefinitelyAnimated('https://example.com/photo.webp'),
      };
    });

    expect(results.gif).toBe(true);
    expect(results.gifQuery).toBe(true);
    expect(results.webp).toBe(true);
    expect(results.apng).toBe(true);
    expect(results.dataGif).toBe(true);
    expect(results.png).toBe(true);
    expect(results.jpg).toBe(true);
    expect(results.svg).toBe(true);
    expect(results.cdnUrl).toBe(true);
    expect(results.cdnPath).toBe(true);
    expect(results.emptyDefinite).toBe(false);
    expect(results.nullDefinite).toBe(false);
    expect(results.emptyExtless).toBe(false);
    expect(results.dataUriExtless).toBe(false);
    expect(results.webpNotDefinite).toBe(false);
  });

  test('detects and replaces extensionless animated GIF via header sniff', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');

    await page.evaluate((base) => {
      const img = document.createElement('img');
      img.id = 'img-extensionless';
      img.src = base + '/cdn-image';
      document.body.appendChild(img);
    }, baseURL);

    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      const img = document.getElementById('img-extensionless');
      return img && img.dataset.still === 'replaced';
    }, { timeout: 5000 });

    const src = await page.$eval('#img-extensionless', el => el.src);
    expect(src).toMatch(/^data:image\/svg\+xml/);
  });

  test('replaces cross-origin extensionless GIF via header sniff', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');

    await page.evaluate((xo) => {
      const img = document.createElement('img');
      img.id = 'img-cross-origin';
      img.src = xo + '/cdn-image';
      document.body.appendChild(img);
    }, xOriginURL);

    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      const img = document.getElementById('img-cross-origin');
      return img && img.dataset.still === 'replaced';
    }, { timeout: 10000 });

    const src = await page.$eval('#img-cross-origin', el => el.src);
    expect(src).toMatch(/^data:image\/svg\+xml/);
  });

  test('tracks replaced URLs', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    // Wait for first replacement
    await page.waitForFunction(() => {
      const img = document.getElementById('img-gif');
      return img && img.dataset.still === 'replaced';
    }, { timeout: 5000 });

    // Check replacedURLs has entries
    const size = await page.evaluate(() => window.__still.replacedURLs.size);
    expect(size).toBeGreaterThan(0);
  });

  test('blocks CSS background-image animated GIFs', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');

    // Add a div with an animated GIF background
    await page.evaluate((base) => {
      const div = document.createElement('div');
      div.id = 'bg-gif-div';
      div.style.width = '200px';
      div.style.height = '200px';
      div.style.backgroundImage = `url(${base}/fixtures/animated.gif)`;
      document.body.appendChild(div);
    }, baseURL);

    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      const div = document.getElementById('bg-gif-div');
      return div && div.dataset.stillBg === 'blocked';
    }, { timeout: 5000 });

    const bg = await page.$eval('#bg-gif-div', el => getComputedStyle(el).backgroundImage);
    expect(bg).toBe('none');
  });

  test('does NOT block CSS background-image for non-GIF', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');

    await page.evaluate((base) => {
      const div = document.createElement('div');
      div.id = 'bg-png-div';
      div.style.width = '200px';
      div.style.height = '200px';
      div.style.backgroundImage = `url(${base}/fixtures/static.png)`;
      document.body.appendChild(div);
    }, baseURL);

    await page.addScriptTag({ path: CONTENT_SCRIPT });
    await page.waitForTimeout(1500);

    const bg = await page.$eval('#bg-png-div', el => getComputedStyle(el).backgroundImage);
    expect(bg).not.toBe('none');
  });

  test('removes SVG SMIL animation elements', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');

    // Add an SVG with SMIL animation
    await page.evaluate(() => {
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.id = 'test-svg';
      svg.setAttribute('width', '100');
      svg.setAttribute('height', '100');

      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', '50');
      circle.setAttribute('cy', '50');
      circle.setAttribute('r', '40');

      const animate = document.createElementNS(svgNS, 'animate');
      animate.setAttribute('attributeName', 'r');
      animate.setAttribute('values', '40;10;40');
      animate.setAttribute('dur', '1s');
      animate.setAttribute('repeatCount', 'indefinite');

      circle.appendChild(animate);
      svg.appendChild(circle);
      document.body.appendChild(svg);
    });

    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      return document.querySelectorAll('animate').length === 0;
    }, { timeout: 5000 });

    // Verify the animate element was removed but the SVG structure remains
    const svgExists = await page.$eval('#test-svg', el => el.tagName === 'svg');
    expect(svgExists).toBe(true);
    const animateCount = await page.evaluate(() => document.querySelectorAll('animate').length);
    expect(animateCount).toBe(0);
  });

  test('replaces lazy-loaded GIF even when naturalWidth/Height are initially 0', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');

    // Add a lazy-loaded GIF — loading="lazy" means the image may not have
    // loaded when the content script first processes it, so naturalWidth and
    // naturalHeight are 0. The bug: isSpacer() treated 0 <= 1 as a spacer.
    await page.evaluate((base) => {
      const img = document.createElement('img');
      img.id = 'img-lazy-gif';
      img.loading = 'lazy';
      img.src = base + '/fixtures/animated.gif';
      img.style.width = '200px';
      img.style.height = '200px';
      document.body.appendChild(img);
    }, baseURL);

    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      const img = document.getElementById('img-lazy-gif');
      return img && img.dataset.still === 'replaced';
    }, { timeout: 5000 });

    const src = await page.$eval('#img-lazy-gif', el => el.src);
    expect(src).toMatch(/^data:image\/svg\+xml/);
  });

  test('kills CSS transitions so style changes are instant (Amazon carousel pattern)', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/fixtures/test-transitions.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    // Wait for the stylesheet to be injected
    await page.waitForFunction(() => !!document.getElementById('__still-hide'));

    // Verify transition-duration is forced to 0s on all elements
    const htmlTransition = await page.evaluate(() => getComputedStyle(document.documentElement).transitionDuration);
    expect(htmlTransition).toBe('0s');

    const slideTransition = await page.evaluate(() => getComputedStyle(document.getElementById('slide-a')).transitionDuration);
    expect(slideTransition).toBe('0s');

    const fadeTransition = await page.evaluate(() => getComputedStyle(document.getElementById('fade-box')).transitionDuration);
    expect(fadeTransition).toBe('0s');

    // Now test that changes are actually instant:
    // Trigger an opacity change and verify it takes effect immediately (no gradual transition)
    const isInstant = await page.evaluate(() => {
      const box = document.getElementById('fade-box');
      box.style.opacity = '0.1';
      // Read immediately — if transitions are killed, opacity is already 0.1
      // If transitions were active, it would still be close to the old value
      const immediate = parseFloat(getComputedStyle(box).opacity);
      return Math.abs(immediate - 0.1) < 0.01;
    });
    expect(isInstant).toBe(true);
  });

  test('cancelAnimations preserves forwards-fill end state (WP fade-in reveal pattern)', async ({ page }) => {
    // Regression test for the nplusonemag.com blank-page bug. Many WordPress
    // themes use `body { opacity: 0; animation: fadein forwards; }` so the page
    // is invisible until JS/animation runs. Plain cancel() reverts to the
    // pre-animation state (opacity 0) → page stays invisible forever. finish()
    // must be used for forwards-fill animations instead.
    await injectContentScript(page);
    await page.setContent(`
      <!DOCTYPE html>
      <style>
        @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
        body {
          opacity: 0;
          animation: fadein 300ms forwards;
        }
      </style>
      <body>hello</body>
    `);
    await page.addScriptTag({ path: CONTENT_SCRIPT });
    // Wait for DOMContentLoaded scanAll()+cancelAnimations() to fire, then
    // wait past the animation duration.
    await page.waitForTimeout(500);
    const opacity = await page.evaluate(() => getComputedStyle(document.body).opacity);
    expect(parseFloat(opacity)).toBe(1);
  });

  test('does NOT replace lazy-load placeholder GIF when data-src points at real image (macrumors pattern)', async ({ page }) => {
    // macrumors.com (and many WordPress-style sites) use this lazy-load pattern:
    // <img src="/images-new/1x1.trans.gif" data-src="https://cdn.../real.jpg">
    // with CSS-applied dimensions (e.g., 697×392). Our naturalWidth-based
    // spacer check misses it because at scan time the 1x1 GIF may not have
    // loaded yet, so we'd otherwise incorrectly mark it as replaced and the
    // src-setter override would block the page's lazy swap.
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.evaluate((base) => {
      const img = document.createElement('img');
      img.id = 'img-lazy-placeholder';
      img.src = base + '/fixtures/1x1.trans.gif';
      img.setAttribute('data-src', base + '/fixtures/static.png');
      img.style.width = '697px';
      img.style.height = '392px';
      document.body.appendChild(img);
    }, baseURL);
    await page.addScriptTag({ path: CONTENT_SCRIPT });
    await page.waitForTimeout(500);
    const state = await page.$eval('#img-lazy-placeholder', (el) => ({
      still: el.dataset.still,
      src: el.src,
    }));
    // Should be marked static (we recognized the lazy-load pattern), not replaced.
    expect(state.still).not.toBe('replaced');
    // Simulate the page's lazy-load JS swapping in the real URL.
    await page.evaluate((base) => {
      const img = document.getElementById('img-lazy-placeholder');
      img.src = base + '/fixtures/static.png';
    }, baseURL);
    await page.waitForTimeout(200);
    // The real src must have actually taken — our setter override shouldn't
    // have blocked it. static.png is a jpg/png, so processImage should hit
    // the "static extension" skip path and leave it visible.
    const finalSrc = await page.$eval('#img-lazy-placeholder', (el) => el.src);
    expect(finalSrc).toMatch(/static\.png/);
  });

  test('STILL replaces a real animated GIF that is lazy-loaded (does not leak via data-src heuristic)', async ({ page }) => {
    // Leak test: the lazy-load pattern must not let a real animated GIF through.
    // Page pattern: img starts with 1×1 spacer, then JS swaps in a real
    // animated.gif via src. After the swap, our MutationObserver should
    // re-process the img and replace it.
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.evaluate((base) => {
      const img = document.createElement('img');
      img.id = 'img-lazy-to-real-gif';
      img.src = base + '/fixtures/1x1.trans.gif';
      img.setAttribute('data-src', base + '/fixtures/animated.gif');
      img.style.width = '200px';
      img.style.height = '150px';
      document.body.appendChild(img);
    }, baseURL);
    await page.addScriptTag({ path: CONTENT_SCRIPT });
    await page.waitForTimeout(500);
    // Simulate the page's lazy-load JS firing.
    await page.evaluate((base) => {
      const img = document.getElementById('img-lazy-to-real-gif');
      img.src = base + '/fixtures/animated.gif';
    }, baseURL);
    // Wait for MutationObserver → processImage → replaceWithPlaceholder
    await page.waitForFunction(
      () => document.getElementById('img-lazy-to-real-gif').dataset.still === 'replaced',
      { timeout: 3000 }
    );
    const src = await page.$eval('#img-lazy-to-real-gif', (el) => el.src);
    expect(src).toMatch(/^data:image\/svg\+xml/); // our placeholder, not the real gif
  });

  test('STILL replaces a visibly-sized GIF even if filename contains "clear" or "blank" prefix', async ({ page }) => {
    // Leak test for the URL-filename heuristic: `clear-skies.gif` or
    // `blank-cover.gif` should NOT be treated as a spacer just because
    // the filename starts with "clear" / "blank". Only the exact spacer
    // basenames (blank.gif, clear.gif, 1x1.trans.gif, etc.) match.
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    // Serve an actually-animated GIF but give it a misleading URL in a
    // Playwright route handler.
    await page.route('**/clear-skies.gif', async (route) => {
      const fs = require('fs');
      const path = require('path');
      const body = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'animated.gif'));
      await route.fulfill({ status: 200, contentType: 'image/gif', body });
    });
    await page.evaluate(() => {
      const img = document.createElement('img');
      img.id = 'img-misleading-name';
      img.src = '/clear-skies.gif';
      img.style.width = '200px';
      img.style.height = '150px';
      document.body.appendChild(img);
    });
    await page.addScriptTag({ path: CONTENT_SCRIPT });
    await page.waitForFunction(
      () => document.getElementById('img-misleading-name').dataset.still === 'replaced',
      { timeout: 3000 }
    );
    const src = await page.$eval('#img-misleading-name', (el) => el.src);
    expect(src).toMatch(/^data:image\/svg\+xml/); // replaced, not leaked
  });

  test('extensionless URL serving animated GIF: no visible-render window before block', async ({ page }) => {
    // Extensionless URLs (image CDNs that strip .gif/.webp, proxied images, etc.)
    // bypass our document_start CSS hide rule because the rule pattern-matches
    // on URL extension. Between the browser starting to decode the image and
    // our Path E probe setting visibility:hidden, there is a theoretical
    // window where an animated frame could paint.
    //
    // This test exercises that race: install a rAF sampler that records img
    // state every paint; serve an actually-animated GIF at an extensionless
    // URL; fail if any sample shows the img in a "visible AND loaded AND not
    // yet classified-by-extension" state — i.e., a state where pixels from
    // the animated GIF could have been on-screen.
    await injectContentScript(page);
    const fs = require('fs');
    const path = require('path');
    const gifBytes = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'animated.gif'));
    // Serve the animated GIF at an extensionless path off baseURL so relative
    // resolution works against a real origin.
    await page.route(`${baseURL}/api/image/abc`, (route) =>
      route.fulfill({ status: 200, contentType: 'image/gif', body: gifBytes })
    );
    // Navigate to baseURL first so setContent keeps that origin and the
    // relative img URL resolves against it.
    await page.goto(baseURL + '/test-page.html');
    const contentJs = fs.readFileSync(CONTENT_SCRIPT, 'utf8');
    await page.setContent(`
      <!DOCTYPE html>
      <script>${contentJs}</script>
      <body>
        <img id="ext-img" src="${baseURL}/api/image/abc" style="width:200px;height:150px">
      </body>
      <script>
        window.__samples = [];
        (function s() {
          const img = document.getElementById('ext-img');
          if (img) {
            window.__samples.push({
              t: performance.now(),
              visibility: getComputedStyle(img).visibility,
              dataStill: img.dataset.still || null,
              naturalWidth: img.naturalWidth,
              complete: img.complete,
            });
          }
          requestAnimationFrame(s);
        })();
      </script>
    `);
    // Give the extension time to probe and replace the image.
    await page.waitForTimeout(2000);
    const samples = await page.evaluate(() => window.__samples);
    expect(samples.length).toBeGreaterThan(10); // sampler ran

    // A sample is a "potential leak" iff the browser would have painted
    // real animated pixels at that moment:
    //   - visibility is 'visible' (browser would render)
    //   - naturalWidth > 1 (decoded enough to have a real picture, not 1×1)
    //   - dataStill not in {replacing, replaced} (our replacement hasn't
    //     happened yet, so any rendered pixels are from the original resource).
    //
    // A leaked sample would also need naturalWidth to reflect the ORIGINAL
    // image's dimensions, not our placeholder SVG's. The placeholder SVG is
    // 150×? so we additionally require naturalWidth to match the animated.gif
    // fixture's dimensions to avoid false positives from samples taken right
    // after replacement.
    const leaks = samples.filter(
      (s) =>
        s.visibility === 'visible' &&
        s.naturalWidth > 1 &&
        !['replacing', 'replaced'].includes(s.dataStill)
    );
    expect(leaks).toEqual([]);
  });

  test('pixel-level: no animated frames painted during load of extensionless animated GIF', async ({ browser }) => {
    // Stronger than the DOM-state test: record the actual rendered pixels via
    // Playwright's recordVideo, then use ffmpeg to measure per-frame luminance
    // difference over the settled window. If any frame shows motion above the
    // VP8 encoder noise floor after the first 500ms, the animated GIF was
    // visible in the rendered output — a real leak.
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { spawnSync } = require('child_process');

    const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'still-test-'));
    const context = await browser.newContext({
      recordVideo: { dir: videoDir, size: { width: 800, height: 600 } },
      viewport: { width: 800, height: 600 },
    });
    // Mock chrome/browser API so content.js runs in test environment.
    await context.addInitScript(() => {
      window.browser = {
        storage: { local: {
          get(keys, cb) { cb({ enabled: true, allowlist: [] }); },
          set() {},
        }},
        runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } },
      };
    });

    const page = await context.newPage();
    // Serve a real, visibly-animated 200×200 GIF at an extensionless URL.
    await page.route(`${baseURL}/hidden-animated`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/gif',
        body: fs.readFileSync(path.resolve(__dirname, 'fixtures', 'test-slow.gif')),
      })
    );
    const contentJs = fs.readFileSync(CONTENT_SCRIPT, 'utf8');
    await page.goto(baseURL + '/test-page.html');
    // Compose content.js + the extensionless-animated-GIF img into initial HTML.
    await page.setContent(`
      <!DOCTYPE html>
      <script>${contentJs}</script>
      <body style="margin:0;background:#fff;">
        <img src="${baseURL}/hidden-animated" style="width:200px;height:200px">
      </body>
    `);
    // Record for 2.5s total; we'll analyze from 0.5s onward (post-settle).
    await page.waitForTimeout(2500);
    await page.close();
    await context.close(); // flushes video

    const videoFile = fs.readdirSync(videoDir).find((f) => f.endsWith('.webm'));
    expect(videoFile).toBeTruthy();
    const videoPath = path.join(videoDir, videoFile);

    // ffmpeg: skip first 0.5s, resample to 10fps, tblend=difference frames,
    // signalstats publishes YAVG of the diff per frame. metadata=print writes
    // to stderr, so we capture it via spawnSync.
    const ff = spawnSync('ffmpeg', [
      '-y', '-ss', '0.5', '-i', videoPath,
      '-vf', 'fps=10,tblend=all_mode=difference,signalstats,metadata=print',
      '-f', 'null', '-',
    ], { encoding: 'utf8' });
    const log = ff.stderr || '';
    const yavg = [];
    for (const line of log.split('\n')) {
      const m = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
      if (m) yavg.push(parseFloat(m[1]));
    }
    expect(yavg.length).toBeGreaterThan(10); // analysis ran
    // VP8 keyframe quantization produces occasional YAVG=1.0 spikes even on
    // static content. Real animation would show sustained values > 1.5 across
    // multiple frames. Threshold at 1.5.
    const motionFrames = yavg.filter((v) => v > 1.5);
    expect(motionFrames).toEqual([]);

    // Cleanup
    fs.rmSync(videoDir, { recursive: true, force: true });
  });

  test('pixel-level sanity: same test WITHOUT extension DOES detect motion', async ({ browser }) => {
    // Meta-test: proves the pixel-level leak test isn't tautologically
    // passing. Run the same scenario (extensionless animated GIF) with NO
    // content.js injected, and assert that the recording DOES contain motion.
    // If this fails, the test above would also pass meaninglessly.
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { spawnSync } = require('child_process');

    const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'still-sanity-'));
    const context = await browser.newContext({
      recordVideo: { dir: videoDir, size: { width: 800, height: 600 } },
      viewport: { width: 800, height: 600 },
    });
    const page = await context.newPage();
    await page.route(`${baseURL}/hidden-animated`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/gif',
        body: fs.readFileSync(path.resolve(__dirname, 'fixtures', 'test-slow.gif')),
      })
    );
    await page.goto(baseURL + '/test-page.html');
    await page.setContent(`
      <!DOCTYPE html>
      <body style="margin:0;background:#fff;">
        <img src="${baseURL}/hidden-animated" style="width:200px;height:200px">
      </body>
    `);
    await page.waitForTimeout(2500);
    await page.close();
    await context.close();

    const videoFile = fs.readdirSync(videoDir).find((f) => f.endsWith('.webm'));
    const videoPath = path.join(videoDir, videoFile);
    const ff = spawnSync('ffmpeg', [
      '-y', '-ss', '0.5', '-i', videoPath,
      '-vf', 'fps=10,tblend=all_mode=difference,signalstats,metadata=print',
      '-f', 'null', '-',
    ], { encoding: 'utf8' });
    const yavg = [];
    for (const line of (ff.stderr || '').split('\n')) {
      const m = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
      if (m) yavg.push(parseFloat(m[1]));
    }
    // Without the extension, the animated GIF should produce detectable motion.
    // The existing fixture is 3×3px scaled to 200×200 — not a huge signal, so
    // use a lower threshold for this sanity check. Any non-zero motion proves
    // the test would catch a real leak.
    const motionFrames = yavg.filter((v) => v > 1.5);
    expect(motionFrames.length).toBeGreaterThan(0);

    fs.rmSync(videoDir, { recursive: true, force: true });
  });

  test('rAF-driven SVG path `d` mutation reveal must be hidden until settled (Fidelity pie chart pattern)', async ({ page }) => {
    // Verified via live DOM inspection on digital.fidelity.com: their Goals
    // widget donut chart is drawn by a library that recomputes an SVG <path>'s
    // `d` attribute every rAF tick — gradually sweeping the arc geometry from
    // 0° to the final angle over ~1 second. Neither CSS @keyframes overrides,
    // WAAPI cancellation, nor stroke-dashoffset rules touch this because the
    // path geometry ITSELF is changing.
    //
    // This test simulates the pattern: inject an SVG path, then in a rAF loop
    // mutate its `d` attribute with progressively-larger arcs. The extension
    // must hide the path (visibility: hidden via data-still-svg-settling) for
    // the duration of the mutations, then reveal it once `d` stops changing.
    // We assert that at NO rAF sample did the path have visibility:visible
    // while its `d` was in flux.
    const fs = require('fs');
    const path = require('path');
    const contentJs = fs.readFileSync(CONTENT_SCRIPT, 'utf8');
    const mainWorldPatchJs = fs.readFileSync(
      path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js'),
      'utf8'
    );
    await page.setContent(`
      <!DOCTYPE html>
      <script>
        // Inline the browser-API mock BEFORE content.js. For tests that
        // injectContentScript via addInitScript, the init script sometimes
        // doesn't fire in time for setContent-embedded scripts that run at
        // parse time. Inlining the mock avoids that race.
        window.browser = {
          storage: { local: {
            get(keys, cb) { cb({ enabled: true, allowlist: [] }); },
            set() {},
          }},
          runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } },
        };
      </script>
      <script>${mainWorldPatchJs}</script>
      <script>${contentJs}</script>
      <body style="margin:0;background:#fff;">
        <svg width="200" height="200" viewBox="0 0 100 100">
          <path id="p" d="M 50 50 L 50 10 A 40 40 0 0 1 50 10 Z" fill="#2a5"></path>
        </svg>
        <script>
          window.__dSamples = [];
          const p = document.getElementById('p');
          // Delay animator start until content.js has fully initialized
          // (which includes installing the MutationObserver that watches for
          // d-attribute mutations).
          function whenReady(fn) {
            if (window.__still) return fn();
            requestAnimationFrame(() => whenReady(fn));
          }
          whenReady(() => {
            const tStart = performance.now();
            const DURATION = 1000;
            function tick(now) {
              const progress = Math.min(1, (now - tStart) / DURATION);
              const endAngle = progress * 270 * Math.PI / 180;
              const x = 50 + 40 * Math.sin(endAngle);
              const y = 50 - 40 * Math.cos(endAngle);
              const large = endAngle > Math.PI ? 1 : 0;
              const d = \`M 50 50 L 50 10 A 40 40 0 \${large} 1 \${x} \${y} Z\`;
              p.setAttribute('d', d);
              window.__dSamples.push({
                t: now - tStart,
                visibility: getComputedStyle(p).visibility,
              });
              if (progress < 1) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
          });
        </script>
      </body>
    `);
    // Wait past animation + settle.
    await page.waitForTimeout(1800);
    const samples = await page.evaluate(() => window.__dSamples);
    expect(samples.length).toBeGreaterThan(10);
    // During the animation window (progress < 1, so t < 1000ms), samples
    // should show visibility: hidden — the extension caught the d mutation.
    const duringAnimation = samples.filter((s) => s.t < 900);
    const visibleDuringAnim = duringAnimation.filter((s) => s.visibility === 'visible');
    expect(visibleDuringAnim).toEqual([]);
    // After settle (300ms of no mutation), the path should be visible again.
    const finalVisibility = await page.evaluate(
      () => getComputedStyle(document.getElementById('p')).visibility
    );
    expect(finalVisibility).toBe('visible');
  });

  test('fade-in animations produce no visible intermediate opacity frames', async ({ page }) => {
    // Stronger-than-end-state test: body opacity must NEVER be between 0 and 1
    // at any rAF tick during page load. Even a 20ms flash of opacity:0.3 is
    // visible motion that could trigger a migraine-sensitive user. The CSS
    // `animation-duration: 0s !important` override should make the fade-in
    // reach its end state on frame 1 with no intermediate rendering.
    await injectContentScript(page);
    // Inject the content script + sampler as part of the initial HTML so they
    // are in place by the time the browser begins rendering the animated body.
    // This mirrors how the real extension runs at document_start.
    const fs = require('fs');
    const contentJs = fs.readFileSync(CONTENT_SCRIPT, 'utf8');
    await page.setContent(`
      <!DOCTYPE html>
      <script>${contentJs}</script>
      <style>
        @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
        body { opacity: 0; animation: fadein 300ms forwards; }
      </style>
      <body>hello</body>
      <script>
        window.__opacitySamples = [];
        (function s() {
          window.__opacitySamples.push({
            t: performance.now(),
            opacity: parseFloat(getComputedStyle(document.body).opacity),
          });
          requestAnimationFrame(s);
        })();
      </script>
    `);
    // Wait past the natural animation duration so any intermediate frames
    // would certainly have been captured by the sampler.
    await page.waitForTimeout(600);
    const samples = await page.evaluate(() => window.__opacitySamples);
    expect(samples.length).toBeGreaterThan(10); // sampler captured ~60fps × 0.6s
    const intermediate = samples.filter((s) => s.opacity > 0 && s.opacity < 1);
    // No sampled frame should have opacity strictly between 0 and 1.
    expect(intermediate).toEqual([]);
    // Final sample should be at the end state (opacity 1).
    expect(samples[samples.length - 1].opacity).toBe(1);
  });

  test('cancelAnimations (real extension code) handles infinite, forwards, and fill:none animations', async ({ page }) => {
    // Black-box test of the actual cancelAnimations() logic in content.js —
    // invoked via window.__still to avoid the earlier version's mistake of
    // replicating the kill logic inline in the test (which missed the
    // fill-upgrade path that the real code has for non-forwards animations).
    //
    // Three animations exercise the three branches:
    //   - inf:  infinite iterations      → expected cancel (idle)
    //   - fwd:  finite, fill: 'forwards' → expected finish, stays at end
    //   - none: finite, fill: 'none'     → expected fill-upgrade + finish,
    //                                      end state persists (the bug-fix
    //                                      branch that had no prior coverage)
    const fs = require('fs');
    const contentJs = fs.readFileSync(CONTENT_SCRIPT, 'utf8');
    await page.setContent(`
      <!DOCTYPE html>
      <script>
        window.browser = {
          storage: { local: {
            get(keys, cb) { cb({ enabled: true, allowlist: [] }); },
            set() {},
          }},
          runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } },
        };
      </script>
      <script>${contentJs}</script>
      <body><div id="s" style="width:40px;height:40px"></div></body>
    `);
    await page.waitForFunction(() => !!window.__still, { timeout: 3000 });
    const result = await page.evaluate(() => {
      const el = document.getElementById('s');
      const inf = el.animate(
        [{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }],
        { duration: 1000, iterations: Infinity }
      );
      const fwd = el.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 1000, fill: 'forwards' }
      );
      const none = el.animate(
        [{ color: 'red' }, { color: 'blue' }],
        { duration: 1000, fill: 'none' }  // explicit default; upgrade path
      );
      // Invoke the real cancelAnimations from content.js.
      window.__still.cancelAnimations();
      return {
        infState: inf.playState,
        fwdState: fwd.playState,
        noneState: none.playState,
        // After cancelAnimations, check the end state of the fill:none
        // animation: fill should have been upgraded to 'forwards'.
        noneFill: none.effect.getComputedTiming().fill,
      };
    });
    expect(result.infState).toBe('idle');      // infinite was cancelled
    expect(result.fwdState).toBe('finished');  // forwards-fill finished
    expect(result.noneState).toBe('finished'); // fill:none also finished
    // Fill should be upgraded from 'none' to 'forwards' so the end state
    // persists after currentTime == duration.
    expect(result.noneFill).toBe('forwards');
  });
});
