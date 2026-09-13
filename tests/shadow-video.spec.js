// @ts-check
// Regression tests for the nytimes.com iOS flicker report (2026-09-11).
//
// NYT's "betamax" player renders each promo <video> inside a shadow root and
// plays it from an IntersectionObserver. Media events don't compose, so
// content.js's document-level play/loadstart listeners and its
// querySelectorAll('video') pass never saw those videos — Still had zero
// effect on them. Worse, the player re-calls play() whenever playback stops
// unexpectedly, so any blocker that pauses AFTER the play event (content.js's
// own pattern, or StopTheMadness) enters a fight: ~1,200 play() calls per
// scroll pass, the play button toggling display ~120x per 1.5s — a strobe.
//
// The fix lives in main-world-patch.js: HTMLMediaElement.prototype.play
// REFUSES ungestured <video> playback with NotAllowedError (what the
// browser's autoplay policy does; players settle into their paused state and
// stop retrying), and every shadow root gets play/loadstart guards for
// natively-autoplayed videos. content.js publishes `data-still-on` so the
// refusal only engages once state is resolved and the site isn't allowlisted.
const { test, expect } = require('@playwright/test');
const path = require('path');
const http = require('http');
const fs = require('fs');

const CONTENT_SCRIPT = path.resolve(__dirname, '..', 'web-extension', 'content.js');
const MAIN_WORLD_PATCH = path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js');
const WEBM = path.resolve(__dirname, 'fixtures', 'test-video.webm');

let server;
let baseURL;

// betamax-shaped page. <nyt-player> hosts an open shadow root containing the
// <video>, a poster <img>, and a play button. The player:
//   - play()s from an IntersectionObserver when the video is 50% visible
//   - hides the poster + button on the `play` event, shows the button on `pause`
//   - re-calls play() on any `pause` it did not request (the retry loop)
// ?autoplay puts a native `autoplay` attribute on the video instead of the
// IO-driven play() call. ?light renders the same player in the light DOM.
const PAGE = `<!doctype html><html><body>
  <div style="height:2400px">filler</div>
  <div id="host"></div>
  <div style="height:1200px">filler</div>
  <script>
    const light = location.search.includes('light');
    const auto = location.search.includes('autoplay');
    const host = document.getElementById('host');
    const root = light ? host : host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div id="player" style="position:relative;width:320px;height:240px">' +
      '<img id="poster" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" ' +
      '     style="position:absolute;inset:0;width:100%;height:100%;background:#888">' +
      '<video id="vid" muted playsinline loop preload="auto" width="320" height="240"' +
      (auto ? ' autoplay' : '') + ' src="/test-video.webm" style="position:absolute;inset:0"></video>' +
      '<div id="btn" style="position:absolute;left:130px;top:90px;width:60px;height:60px;background:#fff">play</div>' +
      '</div>';
    const v = root.querySelector('#vid');
    const poster = root.querySelector('#poster');
    const btn = root.querySelector('#btn');
    window.__stats = { playCalls: 0, playEvents: 0, pauseEvents: 0, btnToggles: 0, rejections: [], wantPlaying: false };
    const S = window.__stats;
    const setBtn = (shown) => {
      const cur = btn.style.display !== 'none';
      if (cur !== shown) { btn.style.display = shown ? '' : 'none'; S.btnToggles++; }
    };
    const tryPlay = () => {
      S.playCalls++;
      const p = v.play();
      if (p && p.catch) p.catch((err) => { S.rejections.push(err && err.name); S.wantPlaying = false; setBtn(true); });
    };
    v.addEventListener('play', () => { S.playEvents++; poster.style.display = 'none'; setBtn(false); });
    v.addEventListener('pause', () => {
      S.pauseEvents++; setBtn(true);
      // betamax: an unexpected pause while we still want playback → retry
      if (S.wantPlaying) setTimeout(tryPlay, 0);
    });
    window.__userPlay = () => { S.wantPlaying = true; tryPlay(); };
    btn.addEventListener('click', window.__userPlay);
    new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !auto) { S.wantPlaying = true; tryPlay(); }
        if (!e.isIntersecting) { S.wantPlaying = false; v.pause(); }
      }
    }, { threshold: 0.5 }).observe(v);
    window.__vid = v;
  </script>
</body></html>`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/player.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PAGE);
    } else if (urlPath === '/test-video.webm') {
      res.writeHead(200, { 'Content-Type': 'video/webm' });
      res.end(fs.readFileSync(WEBM));
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
});

async function setup(page, opts = {}) {
  // Playwright/CDP pages report navigator.userActivation.isActive === true
  // with zero input. Real scrolling grants no activation, so the no-gesture
  // tests stub it off (see linkedin-video.spec.js).
  if (!opts.activation) {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'userActivation', {
        get() { return { isActive: false, hasBeenActive: false }; }
      });
    });
  }
  await page.addInitScript((state) => {
    window.browser = {
      storage: { local: { get(keys, cb) { cb(state); }, set() {} } },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() { return Promise.resolve(); },
        getURL(p) { return 'http://127.0.0.1:1/' + p; }
      }
    };
  }, opts.state || { enabled: true, allowlist: [] });
  // The main-world patch must be in place before the page calls attachShadow.
  await page.addInitScript({ path: MAIN_WORLD_PATCH });
  await page.goto(baseURL + '/player.html' + (opts.query || ''));
  await page.addScriptTag({ path: CONTENT_SCRIPT });
  await page.waitForTimeout(200);
}

const state = (page) => page.evaluate(() => {
  const v = window.__vid;
  return {
    ...window.__stats,
    paused: v.paused,
    currentTime: v.currentTime,
    userPlayMark: v.hasAttribute('data-still-user-play'),
    stillOn: document.documentElement.hasAttribute('data-still-on'),
  };
});

const scrollToPlayer = (page) => page.evaluate(() => window.scrollTo(0, 2450));

test.describe('shadow-DOM video (nytimes betamax pattern)', () => {

  test('IO-triggered play() inside a shadow root is refused, no fight, no flicker', async ({ page }) => {
    await setup(page);
    expect((await state(page)).stillOn).toBe(true);
    await scrollToPlayer(page);
    await page.waitForFunction(() => window.__stats.playCalls > 0, null, { timeout: 5000 });
    await page.waitForTimeout(1500);

    const s = await state(page);
    expect(s.paused).toBe(true);
    expect(s.currentTime).toBe(0);
    expect(s.userPlayMark).toBe(false);
    expect(s.rejections[0]).toBe('NotAllowedError');
    // The refusal happens before any play event, so the player's retry-on-
    // pause loop never engages: one attempt, no events, no button strobe.
    expect(s.playEvents).toBe(0);
    expect(s.pauseEvents).toBe(0);
    expect(s.playCalls).toBeLessThanOrEqual(2);
    expect(s.btnToggles).toBeLessThanOrEqual(1);
  });

  test('the same player in the light DOM no longer fights either', async ({ page }) => {
    await setup(page, { query: '?light' });
    await scrollToPlayer(page);
    await page.waitForFunction(() => window.__stats.playCalls > 0, null, { timeout: 5000 });
    await page.waitForTimeout(1500);

    const s = await state(page);
    expect(s.paused).toBe(true);
    expect(s.playEvents).toBe(0);
    expect(s.playCalls).toBeLessThanOrEqual(2);
    expect(s.btnToggles).toBeLessThanOrEqual(1);
  });

  test('a natively autoplayed video inside a shadow root is paused by the shadow-root guard', async ({ page }) => {
    await setup(page, { query: '?autoplay' });
    await scrollToPlayer(page);
    await page.waitForTimeout(1500);

    const s = await state(page);
    expect(s.paused).toBe(true);
    expect(s.userPlayMark).toBe(false);
    expect(s.currentTime).toBeLessThan(0.3);
    // The player's retry after our pause goes through play() and is refused,
    // so the pause→retry→pause loop cannot sustain itself.
    expect(s.playEvents).toBeLessThanOrEqual(2);
  });

  test('a click on the shadow-DOM play button is honoured', async ({ page }) => {
    await setup(page, { activation: true });
    await scrollToPlayer(page);
    await page.waitForTimeout(500);
    // Click the button inside the shadow root: a real gesture on the video's
    // rect, so the main-world override marks and allows the play.
    const box = await page.evaluate(() => {
      const r = document.getElementById('host').shadowRoot.getElementById('btn').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await page.waitForFunction(() => !window.__vid.paused, null, { timeout: 5000 });
    await page.waitForTimeout(600);

    const s = await state(page);
    expect(s.paused).toBe(false);
    expect(s.userPlayMark).toBe(true);
    expect(s.currentTime).toBeGreaterThan(0.2);
  });

  test('an allowlisted site is left alone', async ({ page }) => {
    await setup(page, { state: { enabled: true, allowlist: ['127.0.0.1'] } });
    expect((await state(page)).stillOn).toBe(false);
    await scrollToPlayer(page);
    await page.waitForFunction(() => window.__stats.playCalls > 0, null, { timeout: 5000 });
    await page.waitForFunction(() => !window.__vid.paused, null, { timeout: 5000 });

    const s = await state(page);
    expect(s.paused).toBe(false);
    expect(s.rejections.length).toBe(0);
  });

  test('a page cannot switch the refusal off by clearing data-still-on', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => document.documentElement.removeAttribute('data-still-on'));
    await page.waitForTimeout(50); // content.js's observer re-asserts before paint
    expect((await state(page)).stillOn).toBe(true);
    await scrollToPlayer(page);
    await page.waitForFunction(() => window.__stats.playCalls > 0, null, { timeout: 5000 });
    await page.waitForTimeout(500);
    const s = await state(page);
    expect(s.paused).toBe(true);
    expect(s.rejections[0]).toBe('NotAllowedError');
  });
});
