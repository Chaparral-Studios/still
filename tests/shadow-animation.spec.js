// @ts-check
// Regression tests for the animation channels Still let through as of
// 2026-09-12 (tests/motion/gap-probe.mts): CSS transitions and keyframes
// inside shadow roots, and Web Animations API animations created after the
// timed cancelAnimations passes. Coverage comes from two writers —
// main-world-patch.js at attachShadow() time (open + closed roots) and
// content.js during scans (declarative open roots) — plus a main-world wrap
// of Element.prototype.animate / Animation.prototype.play / reverse.
const { test, expect } = require('@playwright/test');
const path = require('path');
const http = require('http');

const CONTENT_SCRIPT = path.resolve(__dirname, '..', 'web-extension', 'content.js');
const MAIN_WORLD_PATCH = path.resolve(__dirname, '..', 'web-extension', 'main-world-patch.js');

let server;
let baseURL;

const FINAL = 'matrix(1, 0, 0, 1, 0, 300)';
const PAGE = `<!doctype html><html><head><style>
  .box { position:absolute; left:20px; width:60px; height:60px; background:#c33; }
  #light { top:20px; transition: transform 2s linear; }
  #light.go { transform: translateY(300px); }
  #w-light { top:100px; }
</style></head><body>
  <div id="light" class="box"></div>
  <div id="w-light" class="box"></div>
  <div id="open-host"></div>
  <div id="closed-host"></div>
  <div id="decl-host"><template shadowrootmode="open">
    <style>.box{position:absolute;left:220px;top:20px;width:60px;height:60px;background:#393}
      #decl{transition:transform 2s linear} #decl.go{transform:translateY(300px)}
      @keyframes dspin{to{transform:rotate(360deg)}} #decl-anim{top:100px;animation:dspin 2s linear infinite}</style>
    <div id="decl" class="box"></div><div id="decl-anim" class="box"></div>
  </template></div>
  <script>
    const CSS = '<style>.box{position:absolute;left:120px;width:60px;height:60px;background:#36c}' +
      '#t{top:20px;transition:transform 2s linear}#t.go{transform:translateY(300px)}' +
      '@keyframes spin{to{transform:rotate(360deg)}}#a{top:100px;animation:spin 2s linear infinite}#w{top:180px}</style>' +
      '<div id="t" class="box"></div><div id="a" class="box"></div><div id="w" class="box"></div>';
    window.__open = document.getElementById('open-host').attachShadow({ mode: 'open' });
    window.__open.innerHTML = CSS;
    window.__closed = document.getElementById('closed-host').attachShadow({ mode: 'closed' });
    window.__closed.innerHTML = CSS;
    window.__decl = document.getElementById('decl-host').shadowRoot;
    window.__go = () => {
      document.getElementById('light').classList.add('go');
      window.__open.getElementById('t').classList.add('go');
      window.__closed.getElementById('t').classList.add('go');
      if (window.__decl) window.__decl.getElementById('decl').classList.add('go');
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
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function setup(page, opts = {}) {
  await page.addInitScript((state) => {
    window.browser = {
      storage: { local: { get(keys, cb) { cb(state); }, set() {} } },
      runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); }, getURL(p) { return 'http://127.0.0.1:1/' + p; } }
    };
  }, opts.state || { enabled: true, allowlist: [] });
  if (!opts.noMainWorld) await page.addInitScript({ path: MAIN_WORLD_PATCH });
  await page.goto(baseURL + '/');
  await page.addScriptTag({ path: CONTENT_SCRIPT });
  await page.waitForTimeout(150);
}

// Computed transform of an element by root ('doc' | 'open' | 'closed' | 'decl') + id.
const tf = (page, root, id) => page.evaluate(([r, i]) => {
  const scope = r === 'doc' ? document : window['__' + r];
  return getComputedStyle(scope.getElementById(i)).transform;
}, [root, id]);
const moving = async (page, root, id) => {
  const seen = new Set();
  for (let i = 0; i < 4; i++) { seen.add(await tf(page, root, id)); await page.waitForTimeout(120); }
  return seen.size > 1;
};

test.describe('shadow-root and late-WAAPI animation coverage', () => {

  test('CSS transitions inside open, closed, and declarative shadow roots snap to the end state', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.__go());
    await page.waitForTimeout(120); // well inside the 2s transition if it ran
    expect(await tf(page, 'doc', 'light')).toBe(FINAL);
    expect(await tf(page, 'open', 't')).toBe(FINAL);
    expect(await tf(page, 'closed', 't')).toBe(FINAL);
    expect(await tf(page, 'decl', 'decl')).toBe(FINAL);
  });

  test('CSS keyframe animations inside shadow roots are stopped', async ({ page }) => {
    await setup(page);
    expect(await moving(page, 'open', 'a')).toBe(false);
    expect(await moving(page, 'closed', 'a')).toBe(false);
    expect(await moving(page, 'decl', 'decl-anim')).toBe(false);
  });

  test('a keyframe animation that starts later inside a shadow root is cancelled at animationstart', async ({ page }) => {
    await setup(page);
    await page.waitForTimeout(700); // past the 500ms timed pass
    await page.evaluate(() => {
      const el = window.__open.getElementById('w');
      el.style.animation = 'spin 2s linear infinite';
    });
    await page.waitForTimeout(100);
    expect(await moving(page, 'open', 'w')).toBe(false);
  });

  test('declarative shadow roots are covered by content.js alone (no main world)', async ({ page }) => {
    await setup(page, { noMainWorld: true });
    await page.evaluate(() => window.__go());
    await page.waitForTimeout(120);
    expect(await tf(page, 'decl', 'decl')).toBe(FINAL);
    expect(await moving(page, 'decl', 'decl-anim')).toBe(false);
    // and an open imperative root found during the scan
    expect(await tf(page, 'open', 't')).toBe(FINAL);
  });

  test('element.animate() created late is neutralized at creation: finite snaps to end, infinite is cancelled', async ({ page }) => {
    await setup(page);
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      const fin = document.getElementById('w-light').animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], { duration: 5000 });
      const inf = window.__open.getElementById('w').animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], { duration: 2000, iterations: Infinity });
      return {
        finState: fin.playState, finTf: getComputedStyle(document.getElementById('w-light')).transform,
        infState: inf.playState,
      };
    });
    expect(r.finState).toBe('finished');
    expect(r.finTf).toBe('matrix(1, 0, 0, 1, 300, 0)'); // end state, immediately, fill upgraded to forwards
    expect(r.infState).toBe('idle');
    expect(await moving(page, 'open', 'w')).toBe(false);
  });

  test('play() and reverse() on a neutralized animation do not restart motion', async ({ page }) => {
    await setup(page);
    await page.waitForTimeout(700);
    const r = await page.evaluate(async () => {
      const el = document.getElementById('w-light');
      const a = el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], { duration: 5000 });
      a.play();
      const afterPlay = { state: a.playState, tf: getComputedStyle(el).transform };
      a.reverse(); // the "close" animation pattern
      await new Promise((res) => setTimeout(res, 50));
      const afterReverse = { state: a.playState, tf: getComputedStyle(el).transform };
      return { afterPlay, afterReverse };
    });
    expect(r.afterPlay.state).toBe('finished');
    expect(r.afterPlay.tf).toBe('matrix(1, 0, 0, 1, 300, 0)');
    expect(r.afterReverse.state).toBe('finished');
    // A reversed animation's end is its start: finished at time 0 sits in the
    // before-phase, where fill:forwards doesn't apply, so the element simply
    // shows its own resting transform (none) — the instant "closed" state.
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(r.afterReverse.tf);
  });

  test('chained animations (finished-promise loops, animationend restarts) terminate instead of spinning', async ({ page }) => {
    // With each finite animation finishing instantly, a page that starts the
    // next one from .finished would loop in microtasks and never yield; the
    // burst guard cancels after a few, which rejects the chain and ends it.
    await setup(page);
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      window.__waapi = 0; window.__css = 0;
      const el = document.getElementById('w-light');
      const step = (dir) => {
        window.__waapi++;
        const a = el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], { duration: 400, direction: dir ? 'normal' : 'reverse' });
        a.finished.then(() => step(!dir)).catch(() => {});
      };
      step(true);
      const c = window.__open.getElementById('w');
      c.addEventListener('animationend', () => { window.__css++; c.style.animation = 'none'; void c.offsetWidth; c.style.animation = 'spin 400ms'; });
      c.style.animation = 'spin 400ms';
    });
    await page.waitForTimeout(1500);
    const t0 = Date.now();
    const r = await Promise.race([
      page.evaluate(() => ({ waapi: window.__waapi, css: window.__css })),
      new Promise((res) => setTimeout(() => res('hung'), 4000)),
    ]);
    expect(r).not.toBe('hung');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.waapi).toBeLessThanOrEqual(6);
    expect(r.css).toBeLessThanOrEqual(6);
    expect(await moving(page, 'doc', 'w-light')).toBe(false);
    expect(await moving(page, 'open', 'w')).toBe(false);
  });

  test('a component that reassigns adoptedStyleSheets after attach (Lit pattern) stays covered', async ({ page }) => {
    await setup(page);
    // Lit's adoptStyles: wholesale assignment that would drop Still's sheet.
    const r = await page.evaluate(async () => {
      const root = window.__open;
      const own = new CSSStyleSheet(); own.replaceSync('#t { background: green }');
      root.adoptedStyleSheets = [own];
      await new Promise((res) => setTimeout(res, 50));
      const covered = root.adoptedStyleSheets.some((sh) => { try { return sh.cssRules[0].selectorText === '#-still-shadow-marker'; } catch (e) { return false; } });
      root.getElementById('t').classList.add('go');
      await new Promise((res) => setTimeout(res, 120));
      return { covered, tf: getComputedStyle(root.getElementById('t')).transform, own: root.adoptedStyleSheets.includes(own) };
    });
    expect(r.own).toBe(true);      // the component's own sheet is untouched
    expect(r.covered).toBe(true);  // ours was re-appended
    expect(r.tf).toBe(FINAL);      // and the transition still snaps
  });

  test('an allowlisted site gets none of this', async ({ page }) => {
    await setup(page, { state: { enabled: true, allowlist: ['127.0.0.1'] } });
    await page.evaluate(() => window.__go());
    await page.waitForTimeout(200);
    expect(await tf(page, 'open', 't')).not.toBe(FINAL);   // transition in flight
    expect(await moving(page, 'open', 'a')).toBe(true);     // keyframes running
    const st = await page.evaluate(() => document.getElementById('w-light')
      .animate([{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], { duration: 5000 }).playState);
    expect(st).toBe('running');
    const covered = await page.evaluate(() => window.__still.shadowRootCovered(window.__open));
    expect(covered).toBe(false);
  });
});
