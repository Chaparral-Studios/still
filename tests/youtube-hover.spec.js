// @ts-check
// Regression tests for YouTube hover-preview autoplay (user report 2026-07-31):
// mousing over a video thumbnail starts an inline HD preview. YouTube plays it
// from a mouseover handler — a hover fires no pointerdown/keydown/touchstart
// and grants no user activation, so this must land in the same ungestured
// re-pause path as the LinkedIn IntersectionObserver case (content.js's
// capture-phase 'play' listener).
//
// YouTube uses one reused <video> inside ytd-video-preview: on each hover it
// swaps the src and calls .play(); moving between thumbnails re-triggers it.
// Both shapes are covered: play() on the long-lived reused element (no DOM
// mutation, so no scan fires) and a fresh <video> inserted per hover.
const { test, expect } = require('@playwright/test');
const path = require('path');
const http = require('http');
const fs = require('fs');

const CONTENT_SCRIPT = path.resolve(__dirname, '..', 'web-extension', 'content.js');
const MAIN_WORLD_PATCH = path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js');
const WEBM = path.resolve(__dirname, 'fixtures', 'test-video.webm');
const ANIMATED_WEBP = path.resolve(__dirname, 'fixtures', 'animated.webp');
const STATIC_WEBP = path.resolve(__dirname, 'fixtures', 'static.webp');
const STATIC_PNG = path.resolve(__dirname, 'fixtures', 'static.png');

let server;
let baseURL;
// Second origin with NO CORS headers — models i.ytimg.com, whose an_webp
// hover thumbnails reject content-script Range fetches.
let imgServer;
let imgBaseURL;

// Home-page-shaped grid: thumbnails plus a single reused preview player.
// mouseover on a thumbnail positions the player over it, (re)sets src, and
// calls play() — retrying every 250ms while hovered, like YouTube's player
// does when playback doesn't stick. ?fresh inserts a brand-new <video> per
// hover instead of reusing one.
const GRID_PAGE = `<!doctype html><html><body>
  <div id="grid">
    <div class="thumb" id="thumb1" style="width:320px;height:180px;background:#333"></div>
    <div class="thumb" id="thumb2" style="width:320px;height:180px;background:#444"></div>
  </div>
  <video id="preview" muted playsinline preload="auto"
         width="320" height="180"></video>
  <script>
    window.__playAttempts = 0;
    let retryTimer = null;
    function startPreview(thumb) {
      let v;
      if (location.search.includes('fresh')) {
        v = document.createElement('video');
        v.muted = true; v.setAttribute('playsinline', '');
        v.width = 320; v.height = 180;
        thumb.appendChild(v);
      } else {
        v = document.getElementById('preview');
        // Real YouTube overlays the reused player on the hovered thumbnail;
        // the click-scoped user-play mark depends on that geometry.
        // pointer-events:none keeps hover/click targeting the thumbnail, so
        // the overlay doesn't steal the mouseout/click that drive this page.
        const r = thumb.getBoundingClientRect();
        v.style.position = 'absolute';
        v.style.pointerEvents = 'none';
        v.style.left = (r.left + scrollX) + 'px';
        v.style.top = (r.top + scrollY) + 'px';
      }
      v.src = '/test-video.webm?' + thumb.id;
      window.__lastPreview = v;
      const tryPlay = () => { window.__playAttempts++; v.play().catch(() => {}); };
      tryPlay();
      retryTimer = setInterval(tryPlay, 250);
    }
    document.querySelectorAll('.thumb').forEach((t) => {
      t.addEventListener('mouseover', () => startPreview(t));
      t.addEventListener('mouseout', () => clearInterval(retryTimer));
    });
  </script>
</body></html>`;

// Channel-page-shaped fixture: a plain thumbnail img whose src is hover-
// swapped to a cross-origin animated WebP — YouTube channel pages animate
// thumbnails this way (i.ytimg.com/an_webp/…/mqdefault_6s.webp), no <video>.
const CHANNEL_PAGE = (imgOrigin) => `<!doctype html><html><body>
  <img id="thumb" src="/static.png" width="320" height="180">
  <script>
    const img = document.getElementById('thumb');
    img.addEventListener('mouseover', () => {
      img.src = '${imgOrigin}/' + (location.search.includes('staticwebp')
        ? 'still_6s.webp?sqp=tok' : 'anim_6s.webp?sqp=tok');
    });
  </script>
</body></html>`;

test.beforeAll(async () => {
  imgServer = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    // Deliberately no Access-Control-Allow-Origin on anything, and reject
    // preflights — the content script's own Range fetch must fail here.
    if (req.method === 'OPTIONS') {
      res.writeHead(403);
      res.end();
    } else if (urlPath === '/anim_6s.webp') {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      res.end(fs.readFileSync(ANIMATED_WEBP));
    } else if (urlPath === '/still_6s.webp') {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      res.end(fs.readFileSync(STATIC_WEBP));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => imgServer.listen(0, '127.0.0.1', resolve));
  imgBaseURL = `http://127.0.0.1:${imgServer.address().port}`;

  server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/grid.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(GRID_PAGE);
    } else if (urlPath === '/channel.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(CHANNEL_PAGE(imgBaseURL));
    } else if (urlPath === '/test-video.webm') {
      res.writeHead(200, { 'Content-Type': 'video/webm' });
      res.end(fs.readFileSync(WEBM));
    } else if (urlPath === '/static.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fs.readFileSync(STATIC_PNG));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => imgServer.close(resolve));
});

async function setup(page, opts = {}) {
  // Playwright/CDP pages report navigator.userActivation.isActive === true
  // even with zero input (see linkedin-video.spec.js). A real hover grants no
  // activation, so the hover tests stub it off to model reality.
  if (!opts.keepActivation) {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'userActivation', {
        get() { return { isActive: false, hasBeenActive: false }; }
      });
    });
  }
  // byteFixtures: { urlSubstring: number[] } — the mocked background's
  // byteProbe response, standing in for the service worker's CORS-free
  // Range fetch.
  await page.addInitScript((byteFixtures) => {
    window.browser = {
      storage: { local: { get(keys, cb) { cb({ enabled: true, allowlist: [] }); }, set() {} } },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(msg) {
          if (msg && msg.type === 'byteProbe' && byteFixtures) {
            for (const key of Object.keys(byteFixtures)) {
              if (msg.url.includes(key)) {
                return Promise.resolve({ ok: true, bytes: byteFixtures[key] });
              }
            }
            return Promise.resolve({ ok: false, status: 404 });
          }
          return Promise.resolve();
        },
        getURL(p) { return 'http://127.0.0.1:1/' + p; }
      }
    };
  }, opts.byteFixtures || null);
  await page.goto(baseURL + (opts.page || '/grid.html') + (opts.query || ''));
  await page.addScriptTag({ path: MAIN_WORLD_PATCH });
  await page.addScriptTag({ path: CONTENT_SCRIPT });
  await page.waitForTimeout(200); // initial scan
}

const previewState = (page) => page.evaluate(() => {
  const v = window.__lastPreview;
  return {
    paused: v ? v.paused : null,
    currentTime: v ? v.currentTime : null,
    userPlayMark: v ? v.hasAttribute('data-still-user-play') : null,
    playAttempts: window.__playAttempts
  };
});

test.describe('YouTube hover-preview autoplay', () => {

  test('hover-triggered play on the reused preview element is re-paused', async ({ page }) => {
    await setup(page);
    await page.hover('#thumb1');
    await page.waitForFunction(() => window.__playAttempts > 0, null, { timeout: 5000 });
    await page.waitForTimeout(1500); // several retries while still hovered

    const s = await previewState(page);
    expect(s.playAttempts).toBeGreaterThan(2); // the page kept trying
    expect(s.paused).toBe(true);               // and stayed paused
    expect(s.userPlayMark).toBe(false);
    expect(s.currentTime).toBeLessThan(0.5);   // no perceptible playback
  });

  test('moving between thumbnails cannot sustain playback', async ({ page }) => {
    await setup(page);
    await page.hover('#thumb1');
    await page.waitForTimeout(600);
    await page.hover('#thumb2');
    await page.waitForTimeout(600);

    const s = await previewState(page);
    expect(s.playAttempts).toBeGreaterThan(1);
    expect(s.paused).toBe(true);
    expect(s.currentTime).toBeLessThan(0.5);
  });

  test('a fresh <video> inserted per hover is also kept paused', async ({ page }) => {
    await setup(page, { query: '?fresh' });
    await page.hover('#thumb1');
    await page.waitForFunction(() => window.__playAttempts > 0, null, { timeout: 5000 });
    await page.waitForTimeout(1000);

    const s = await previewState(page);
    expect(s.paused).toBe(true);
    expect(s.currentTime).toBeLessThan(0.5);
  });

  test('a gestured play does not unlock later hover previews on the reused element', async ({ page }) => {
    await setup(page);
    // User clicks thumb1 — that playback is legitimately exempt and marked.
    // (Wait on the mark, not the first play attempt: the mouseover fires a
    // play a beat before the click's pointerdown lands; a retry earns it.)
    await page.click('#thumb1');
    await page.waitForFunction(
      () => window.__lastPreview && window.__lastPreview.hasAttribute('data-still-user-play'),
      null, { timeout: 5000 });
    await page.evaluate(() => { // hover off: stop the retry loop, YouTube-style
      document.getElementById('thumb1').dispatchEvent(new Event('mouseout'));
    });

    // >2s later (gesture window expired), hover the other thumbnail: YouTube
    // swaps src on the SAME element and play()s it. The loadstart from the
    // src swap must have cleared the mark, so this preview stays paused.
    await page.waitForTimeout(2300);
    await page.hover('#thumb2');
    await page.waitForTimeout(1200);

    const s = await previewState(page);
    expect(s.paused).toBe(true);
    expect(s.userPlayMark).toBe(false);
  });

  // Channel pages animate thumbnails with a hover-swapped animated WebP from
  // i.ytimg.com (user report 2026-07-31, youtube.com/@metalmarshmallowllc) —
  // no <video> involved. i.ytimg.com sends no Access-Control-Allow-Origin,
  // so the content script's own Range probe rejects and the old code marked
  // the img "static", letting the animation run. The fix routes the byte
  // probe through the background worker (byteProbe message).
  test('hover-swapped cross-origin animated WebP is replaced via the background byte probe', async ({ page }) => {
    const byteFixtures = { 'anim_6s.webp': Array.from(fs.readFileSync(ANIMATED_WEBP)) };
    await setup(page, { page: '/channel.html', byteFixtures });
    expect(await page.evaluate(() => document.getElementById('thumb').dataset.still || ''))
      .not.toBe('replaced'); // static PNG untouched before hover

    await page.hover('#thumb');
    await page.waitForFunction(
      () => document.getElementById('thumb').dataset.still === 'replaced',
      null, { timeout: 5000 });

    const src = await page.evaluate(() => document.getElementById('thumb').src);
    expect(src.startsWith('data:image/svg')).toBe(true); // pause placeholder
  });

  test('hover-swapped cross-origin STATIC WebP stays visible (no false positive)', async ({ page }) => {
    const byteFixtures = { 'still_6s.webp': Array.from(fs.readFileSync(STATIC_WEBP)) };
    await setup(page, { page: '/channel.html', query: '?staticwebp', byteFixtures });
    await page.hover('#thumb');
    await page.waitForFunction(
      () => document.getElementById('thumb').dataset.still === 'static',
      null, { timeout: 5000 });

    const s = await page.evaluate(() => {
      const img = document.getElementById('thumb');
      return { src: img.src, visible: getComputedStyle(img).visibility !== 'hidden' };
    });
    expect(s.src).toContain('still_6s.webp');
    expect(s.visible).toBe(true);
  });

  test('click-to-play on the same element still works (watch-page safety)', async ({ page }) => {
    await setup(page, { keepActivation: true });
    // User clicks the thumbnail — gesture-adjacent play must be exempt, or
    // YouTube's real watch player (also play()ed from script after a click)
    // would stick paused.
    await page.click('#thumb1');
    await page.evaluate(() => {
      const v = document.getElementById('preview');
      v.src = '/test-video.webm?click';
      window.__lastPreview = v;
      v.play().catch(() => {});
    });
    await page.waitForFunction(() => {
      const v = document.getElementById('preview');
      return v && !v.paused;
    }, null, { timeout: 5000 });

    expect((await previewState(page)).userPlayMark).toBe(true);
  });
});
