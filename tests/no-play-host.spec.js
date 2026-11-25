// @ts-check
// No-play hosts (user request 2026-11-25, x.com on iPhone): on x.com and
// twitter.com no video plays at all, not even when tapped. Opening a post used
// to start the post's video and the reply videos (the SPA rule: the tap
// changed the URL and the videos loaded after it), and an accidental tap on a
// video is no more welcome. A non-listed host keeps tap-to-play.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const CONTENT_SCRIPT = path.resolve(__dirname, '..', 'web-extension', 'content.js');
const MAIN_WORLD_PATCH = path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js');
const WEBM = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'test-video.webm'));

// Timeline with a post whose text opens the thread (SPA navigation), and a
// video the page plays when it is tapped — x.com's own tap handler shape.
const PAGE = `<!doctype html><html><body style="margin:0">
  <div id="posttext" style="height:120px">post text — tap to open thread</div>
  <video id="tl" muted playsinline loop src="/test-video.webm" width="320" height="240"></video>
  <div id="thread"></div>
  <script>
    const tl = document.getElementById('tl');
    tl.addEventListener('click', () => tl.play().catch(() => {}));
    document.getElementById('posttext').addEventListener('click', () => {
      history.pushState({}, '', '/user/status/123');
      for (const id of ['post', 'reply1', 'reply2']) {
        const v = document.createElement('video');
        v.id = id; v.muted = true; v.setAttribute('playsinline', '');
        v.src = '/test-video.webm?' + id; v.width = 320; v.height = 240;
        document.getElementById('thread').appendChild(v);
        v.play().catch(() => {});
      }
    });
  </script>
</body></html>`;

async function setup(page, origin) {
  await page.route(origin + '/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/test-video.webm') {
      return route.fulfill({ status: 200, contentType: 'video/webm', body: WEBM });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  });
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
  await page.goto(origin + '/home');
  await page.addScriptTag({ path: MAIN_WORLD_PATCH });
  await page.addScriptTag({ path: CONTENT_SCRIPT });
  await page.waitForTimeout(200);
}

const states = (page, ids) => page.evaluate((ids) => ids.map((id) => {
  const v = document.getElementById(id);
  return { id, paused: v.paused, t: v.currentTime };
}), ids);

for (const host of ['https://x.com', 'https://mobile.twitter.com']) {
  test.describe(`no-play host ${host}`, () => {
    test('tapping a video does not play it', async ({ page }) => {
      await setup(page, host);
      await page.mouse.click(160, 240); // on #tl
      await page.waitForTimeout(800);
      for (const s of await states(page, ['tl'])) {
        expect(s.paused).toBe(true);
        expect(s.t).toBeLessThan(0.3);
      }
    });

    test('opening a thread plays neither the post video nor the replies', async ({ page }) => {
      await setup(page, host);
      await page.mouse.click(100, 50); // post text
      await page.waitForTimeout(800);
      for (const s of await states(page, ['post', 'reply1', 'reply2'])) {
        expect(s.paused).toBe(true);
        expect(s.t).toBeLessThan(0.3);
      }
    });

    test('native-controls playback is paused too', async ({ page }) => {
      await setup(page, host);
      await page.mouse.click(160, 240);
      // Bypass play() entirely (as a native control does) — the play event
      // listener must still pause it.
      await page.evaluate(() => { document.getElementById('tl').autoplay = true;
        document.getElementById('tl').load(); });
      await page.waitForTimeout(800);
      const [s] = await states(page, ['tl']);
      expect(s.paused).toBe(true);
      expect(s.t).toBeLessThan(0.3);
    });
  });
}

test('a non-listed host keeps tap-to-play', async ({ page }) => {
  await setup(page, 'https://example.com');
  await page.mouse.click(160, 240);
  await page.waitForFunction(() => !document.getElementById('tl').paused, null, { timeout: 5000 });
});
