// @ts-check
// Regression tests for the LinkedIn feed-video report (2026-07-28): a muted
// playsinline <video> played as the user scrolled, with the extension active.
// LinkedIn plays feed videos from an IntersectionObserver when they scroll
// into view — no DOM mutation accompanies the .play() call, so no scan fires.
// The fix: content.js's capture-phase 'play' listener re-pauses ungestured
// playback synchronously with the event instead of waiting for a scan.
const { test, expect } = require('@playwright/test');
const path = require('path');
const http = require('http');
const fs = require('fs');

const CONTENT_SCRIPT = path.resolve(__dirname, '..', 'web-extension', 'content.js');
const MAIN_WORLD_PATCH = path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js');
const WEBM = path.resolve(__dirname, 'fixtures', 'test-video.webm');

let server;
let baseURL;

// LinkedIn-feed-shaped page: tall filler, then a muted playsinline video
// (no autoplay attribute) that an IntersectionObserver .play()s at 50%
// visibility — the exact pattern of LinkedIn's feed player. ?retry adds an
// autoplay-retry loop (players that re-call play() after every pause).
const FEED_PAGE = `<!doctype html><html><body>
  <div style="height:2400px">feed filler</div>
  <video id="feedvid" muted playsinline loop preload="auto"
         src="/test-video.webm" width="320" height="240"></video>
  <div style="height:1200px">more filler</div>
  <script>
    const v = document.getElementById('feedvid');
    window.__playAttempts = 0;
    const tryPlay = () => { window.__playAttempts++; v.play().catch(() => {}); };
    new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          tryPlay();
          if (location.search.includes('retry')) setInterval(tryPlay, 300);
        }
      }
    }, { threshold: 0.5 }).observe(v);
  </script>
</body></html>`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/feed.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FEED_PAGE);
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
  // even with zero input (verified by probe). Real trackpad scrolling grants
  // no activation, so the no-gesture tests stub it off to model reality.
  if (opts.noActivation) {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'userActivation', {
        get() { return { isActive: false, hasBeenActive: false }; }
      });
    });
  }
  await page.addInitScript(() => {
    window.browser = {
      storage: { local: { get(keys, cb) { cb({ enabled: true, allowlist: [] }); }, set() {} } },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() { return Promise.resolve(); },
        getURL(p) { return 'http://127.0.0.1:1/' + p; }
      }
    };
  });
  await page.goto(baseURL + '/feed.html' + (opts.query || ''));
  await page.addScriptTag({ path: MAIN_WORLD_PATCH });
  await page.addScriptTag({ path: CONTENT_SCRIPT });
  await page.waitForTimeout(200); // initial scan
}

const vidState = (page) => page.evaluate(() => {
  const v = document.getElementById('feedvid');
  return {
    paused: v.paused,
    currentTime: v.currentTime,
    userPlayMark: v.hasAttribute('data-still-user-play'),
    playAttempts: window.__playAttempts
  };
});

test.describe('LinkedIn scroll-autoplay', () => {

  test('IO-triggered play with no gesture is re-paused at the play event, no scan needed', async ({ page }) => {
    await setup(page, { noActivation: true });
    expect((await vidState(page)).paused).toBe(true);

    // Trackpad-style scroll: no pointerdown, no user activation. Scripted
    // scroll is equivalent on both axes the exemption writers see.
    await page.evaluate(() => window.scrollTo(0, 2450));
    await page.waitForFunction(() => window.__playAttempts > 0, null, { timeout: 5000 });
    await page.waitForTimeout(600);

    const s = await vidState(page);
    expect(s.playAttempts).toBeGreaterThan(0); // the page really tried
    expect(s.paused).toBe(true);               // and was re-paused immediately
    expect(s.userPlayMark).toBe(false);
    expect(s.currentTime).toBeLessThan(0.3);   // no visible playback happened
  });

  test('autoplay-retry loop cannot sustain playback', async ({ page }) => {
    await setup(page, { noActivation: true, query: '?retry' });
    await page.evaluate(() => window.scrollTo(0, 2450));
    await page.waitForFunction(() => window.__playAttempts > 0, null, { timeout: 5000 });

    await page.waitForTimeout(3000); // ~10 retries
    const s = await vidState(page);
    expect(s.playAttempts).toBeGreaterThan(3);
    expect(s.paused).toBe(true);
    // Each retry is paused synchronously with its play event; accumulated
    // playback across all retries must stay imperceptible.
    expect(s.currentTime).toBeLessThan(0.5);
  });

  test('a click within the gesture window still exempts the video (YouTube safety)', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.scrollTo(0, 2200)); // video near viewport edge
    await page.mouse.click(200, 100); // e.g. reacting to a post
    await page.evaluate(() => window.scrollTo(0, 2450)); // video now in view; IO fires
    await page.waitForFunction(() => !document.getElementById('feedvid').paused,
      null, { timeout: 5000 });

    expect((await vidState(page)).userPlayMark).toBe(true);

    // Scans don't pause it either.
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.innerHTML = '<span>new feed item</span>';
      document.body.appendChild(d);
    });
    await page.waitForTimeout(800);
    expect((await vidState(page)).paused).toBe(false);
  });
});
