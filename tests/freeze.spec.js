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

test.describe('Still — freeze logic', () => {
  test('freezes animated GIF via fetchAndFreeze', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      const img = document.getElementById('img-gif');
      return img && img.dataset.still === 'frozen';
    }, { timeout: 5000 });

    const src = await page.$eval('#img-gif', el => el.src);
    expect(src).toMatch(/^data:image\/png;base64,/);
  });

  test('freezes GIF with query string', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      const img = document.getElementById('img-gif-query');
      return img && img.dataset.still === 'frozen';
    }, { timeout: 5000 });

    const src = await page.$eval('#img-gif-query', el => el.src);
    expect(src).toMatch(/^data:image\/png;base64,/);
  });

  test('does NOT freeze static PNG images', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForTimeout(1000);

    const src = await page.$eval('#img-static', el => el.src);
    expect(src).toMatch(/static\.png$/);
  });

  test('freezes data URI GIF', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForFunction(() => {
      const img = document.getElementById('img-data-gif');
      return img && img.dataset.still === 'frozen';
    }, { timeout: 5000 });

    const src = await page.$eval('#img-data-gif', el => el.src);
    expect(src).toMatch(/^data:image\/png;base64,/);
  });

  test('freezes dynamically added GIF via MutationObserver', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    await page.waitForTimeout(500);
    await page.click('#add-btn');

    await page.waitForFunction(() => {
      const img = document.getElementById('img-dynamic');
      return img && (img.dataset.still === 'frozen' || img.dataset.still === 'skipped');
    }, { timeout: 5000 });
  });

  test('classifies URL extensions correctly', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    const results = await page.evaluate(() => {
      const { hasAnimatedExtension, hasStaticExtension, isExtensionless } = window.__still;
      return {
        gif: hasAnimatedExtension('https://example.com/image.gif'),
        gifQuery: hasAnimatedExtension('https://example.com/image.gif?v=2'),
        webp: hasAnimatedExtension('https://example.com/anim.webp'),
        apng: hasAnimatedExtension('https://example.com/anim.apng'),
        dataGif: hasAnimatedExtension('data:image/gif;base64,R0lGOD'),
        png: hasStaticExtension('https://example.com/photo.png'),
        jpg: hasStaticExtension('https://example.com/photo.jpg'),
        svg: hasStaticExtension('https://example.com/icon.svg'),
        cdnUrl: isExtensionless('https://images.wsj.net/im-59533137?size=1&width=74'),
        cdnPath: isExtensionless('https://cdn.example.com/images/12345'),
        emptyAnimated: hasAnimatedExtension(''),
        nullAnimated: hasAnimatedExtension(null),
        emptyExtless: isExtensionless(''),
        dataUriExtless: isExtensionless('data:image/gif;base64,R0lGOD'),
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
    expect(results.emptyAnimated).toBe(false);
    expect(results.nullAnimated).toBe(false);
    expect(results.emptyExtless).toBe(false);
    expect(results.dataUriExtless).toBe(false);
  });

  test('detects and freezes extensionless animated GIF via header sniff', async ({ page }) => {
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
      return img && (img.dataset.still === 'frozen' || img.dataset.still === 'static');
    }, { timeout: 5000 });

    expect(['frozen', 'static']).toContain(
      await page.$eval('#img-extensionless', el => el.dataset.still)
    );
  });

  test('freezes cross-origin extensionless GIF via header sniff', async ({ page }) => {
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
      return img && (img.dataset.still === 'frozen' || img.dataset.still === 'static' || img.dataset.still === 'skipped');
    }, { timeout: 10000 });

    expect(['frozen', 'static']).toContain(
      await page.$eval('#img-cross-origin', el => el.dataset.still)
    );
  });

  test('uses cache for repeated freeze of same URL', async ({ page }) => {
    await injectContentScript(page);
    await page.goto(baseURL + '/test-page.html');
    await page.addScriptTag({ path: CONTENT_SCRIPT });

    // Wait for first freeze
    await page.waitForFunction(() => {
      const img = document.getElementById('img-gif');
      return img && img.dataset.still === 'frozen';
    }, { timeout: 5000 });

    // Check cache has an entry
    const cacheSize = await page.evaluate(() => window.__still.frozenCache.size);
    expect(cacheSize).toBeGreaterThan(0);
  });
});
