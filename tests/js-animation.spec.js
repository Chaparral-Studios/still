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
  <div id="scrub" class="box"></div>
  <div id="centered" class="box" style="margin:0 auto; width:200px; transform:translateX(0px)"></div>
  <div id="frame" style="position:relative; width:300px; height:200px">
    <div id="overlay" style="position:absolute; inset:0; background:#c33"></div>
  </div>
  <div id="important" class="box" style="position:relative; left:10px !important"></div>
  <div id="stepLeft" class="box" style="position:relative; left:0px"></div>
  <div id="stepTf" class="box" style="transform:translateX(0px)"></div>
  <div id="shaker" class="box" style="transform:translateX(0px)"></div>
  <div id="sprite" class="box" style="background-image:linear-gradient(90deg,#000 50%,#fff 50%); background-size:64px 64px"></div>
  <div id="slowsprite" class="box" style="background-image:linear-gradient(90deg,#000 50%,#fff 50%); background-size:64px 64px"></div>
  <div id="tip" class="box" style="position:absolute; left:0; top:0; opacity:0"></div>
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

    // A ScrollTrigger-style scrub WITH smoothing: follows scrollY through an
    // easing loop that keeps drifting after the scrolling stops.
    window.scrub = (id) => {
      const el = document.getElementById(id);
      let target = 0, cur = 0, raf = 0;
      const step = () => {
        cur += (target - cur) * 0.12;
        if (Math.abs(target - cur) < 0.5) cur = target;
        el.style.transform = 'translateY(' + cur.toFixed(2) + 'px)';
        raf = cur === target ? 0 : requestAnimationFrame(step);
      };
      window.addEventListener('scroll', () => { target = window.scrollY; if (!raf) raf = requestAnimationFrame(step); }, { passive: true });
    };
    // Document-relative top of an element, sampled every frame, plus the worst
    // distance from where a 1:1 scroll follower should be.
    window.trackTop = (id, ms, follow) => {
      const el = document.getElementById(id);
      const base = el.offsetTop;
      window.__tops = []; window.__maxErr = 0; window.__trackDone = false;
      const t0 = performance.now();
      const tick = () => {
        const top = el.getBoundingClientRect().top + window.scrollY - base;
        window.__tops.push(Math.round(top));
        if (follow) window.__maxErr = Math.max(window.__maxErr, Math.abs(top - window.scrollY));
        if (performance.now() - t0 > ms) { window.__trackDone = true; return; }
        requestAnimationFrame(tick);
      };
      tick();
    };
    // Hand-rolled steppers that read their own inline style back each frame.
    window.stepLeft = (id) => {
      const el = document.getElementById(id); window.__stepLeftIters = 0; window.__stepLeftDone = false;
      const step = () => {
        window.__stepLeftIters++;
        el.style.left = (parseFloat(el.style.left) + 10) + 'px';
        if (parseFloat(el.style.left) < 300) requestAnimationFrame(step); else window.__stepLeftDone = true;
      };
      step();
    };
    window.stepTransform = (id) => {
      const el = document.getElementById(id); window.__stepTfDone = false;
      const step = () => {
        const x = Number(/translateX\\(([-\\d.]+)px\\)/.exec(el.style.transform)[1]) + 10;
        el.style.transform = 'translateX(' + x + 'px)';
        if (x < 300) requestAnimationFrame(step); else window.__stepTfDone = true;
      };
      step();
    };
    // A shake that returns to rest: the last write equals the starting value.
    window.shake = (id, ms = 500) => {
      const el = document.getElementById(id); const t0 = performance.now(); window.__shakeDone = false;
      const step = () => {
        const p = Math.min(1, (performance.now() - t0) / ms);
        el.style.transform = 'translateX(' + (((window.__shakeI = (window.__shakeI || 0) + 1) % 2 ? 1 : -1) * 12 * (1 - p)).toFixed(2) + 'px)';
        if (p < 1) requestAnimationFrame(step); else window.__shakeDone = true;
      };
      step();
    };
    // A JS sprite-sheet ticker (the classic animated-image substitute).
    window.sprite = (id, everyMs) => {
      const el = document.getElementById(id); let i = 0;
      setInterval(() => { i = (i + 1) % 8; el.style.backgroundPosition = (-8 * i) + 'px 0px'; }, everyMs);
    };
    window.countBgStates = async (id, ms) => {
      const el = document.getElementById(id); const seen = []; const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        const v = getComputedStyle(el).backgroundPositionX;
        if (seen[seen.length - 1] !== v) seen.push(v);
        await new Promise(requestAnimationFrame);
      }
      return seen.length;
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

  // --- Review-finding regressions (PR #28 rework) ---

  test('a smoothed scroll-scrub element never snaps BACK when scrolling stops', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.scrub('scrub'); window.trackTop('scrub', 2200, false); });
    await page.mouse.move(200, 300);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 60); await page.waitForTimeout(60); }
    await page.waitForFunction(() => window.__trackDone);
    const r = await page.evaluate(() => {
      let back = 0;
      for (let i = 1; i < window.__tops.length; i++) back = Math.max(back, window.__tops[i - 1] - window.__tops[i]);
      return { back, final: window.__tops[window.__tops.length - 1], scrollY: Math.round(window.scrollY) };
    });
    expect(r.scrollY).toBeGreaterThan(300);
    expect(r.back).toBeLessThanOrEqual(3);      // was: the whole scroll distance
    expect(Math.abs(r.final - r.scrollY)).toBeLessThanOrEqual(1);
  });

  for (const how of ['keyboard', 'momentum']) {
    test(`scroll-driven rows keep tracking under ${how} scrolling (no wheel/touch events)`, async ({ page }) => {
      await setup(page);
      await page.evaluate(() => { window.virtualize('vlist'); window.trackTop('vlist', 1800, true); });
      if (how === 'keyboard') {
        await page.mouse.click(600, 300);
        await page.waitForTimeout(200);
        for (let i = 0; i < 4; i++) { await page.keyboard.press('PageDown'); await page.waitForTimeout(250); }
      } else {
        // iOS momentum shape: the page keeps scrolling with no input events.
        await page.evaluate(() => {
          const t0 = performance.now();
          const go = () => { window.scrollBy(0, 14); if (performance.now() - t0 < 1000) requestAnimationFrame(go); };
          go();
        });
      }
      await page.waitForFunction(() => window.__trackDone);
      const r = await page.evaluate(() => ({
        maxErr: Math.round(window.__maxErr), scrollY: Math.round(window.scrollY),
        self: window.__still.isSelfAnimator(document.getElementById('vlist')),
      }));
      expect(r.scrollY).toBeGreaterThan(400);
      expect(r.maxErr).toBeLessThanOrEqual(2);  // was: hundreds of px, rows stranded
      expect(r.self).toBe(false);
    });
  }

  test('shorthand-authored inline styles survive withholding (margin:auto, inset:0, !important)', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      for (const id of ['centered', 'overlay']) {
        const el = document.getElementById(id); const t0 = performance.now();
        const step = () => { el.style.transform = 'translateX(' + (Math.sin((performance.now() - t0) / 200) * 30).toFixed(2) + 'px)'; requestAnimationFrame(step); };
        step();
      }
      const imp = document.getElementById('important'); const t0 = performance.now();
      const step = () => { imp.style.setProperty('left', (10 + ((performance.now() - t0) / 10) % 200).toFixed(1) + 'px', 'important'); requestAnimationFrame(step); };
      step();
    });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const c = document.getElementById('centered'), o = document.getElementById('overlay'), i = document.getElementById('important');
      const or = o.getBoundingClientRect();
      return {
        withheld: window.__still.isMotionWithheld(c) && window.__still.isMotionWithheld(o) && window.__still.isMotionWithheld(i),
        marginLeft: c.style.marginLeft, marginRight: c.style.marginRight,
        centeredLeft: Math.round(c.getBoundingClientRect().left), expectLeft: Math.round((document.documentElement.clientWidth - 200) / 2),
        overlay: Math.round(or.width) + 'x' + Math.round(or.height), overlayTop: o.style.top,
        impLeft: i.style.left, impPrio: i.style.getPropertyPriority('left'),
      };
    });
    expect(r.withheld).toBe(true);
    expect(r.marginLeft).toBe('auto');
    expect(r.marginRight).toBe('auto');
    expect(r.centeredLeft).toBe(r.expectLeft);
    expect(r.overlay).toBe('300x200');
    expect(r.overlayTop).toBe('0px');
    expect(r.impLeft).toBe('10px');
    expect(r.impPrio).toBe('important');
  });

  test('press-and-hold, right-click and an unrelated drag do not release withheld loops', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.loop('looper'); });
    await page.waitForTimeout(300);
    const states = async () => {
      await page.evaluate(() => window.startSampling('looper', 700));
      await page.waitForFunction(() => window.__samplingDone);
      return page.evaluate(() => window.distinctStates());
    };
    await page.mouse.move(700, 500);
    await page.mouse.down();                       // hold, no movement
    expect(await states()).toBeLessThanOrEqual(GLIDE_THRESHOLD);
    for (let x = 700; x < 800; x += 10) { await page.mouse.move(x, 500); await page.waitForTimeout(20); }
    expect(await states()).toBeLessThanOrEqual(GLIDE_THRESHOLD);   // selection-style drag elsewhere
    await page.mouse.up();
    await page.mouse.down({ button: 'right' });    // pointerup may never arrive after a context menu
    expect(await states()).toBeLessThanOrEqual(GLIDE_THRESHOLD);
    await page.mouse.up({ button: 'right' });
  });

  test('read-modify-write steppers finish unseen and pop into place (accordion/drawer pattern)', async ({ page }) => {
    await setup(page);
    // Sample what is actually RENDERED every frame while the steppers run.
    await page.evaluate(() => {
      window.__seenLeft = new Set(); window.__seenTf = new Set(); window.__sampling = true;
      const a = document.getElementById('stepLeft'), b = document.getElementById('stepTf');
      (function s() {
        window.__seenLeft.add(Math.round(a.getBoundingClientRect().left));
        window.__seenTf.add(Math.round(b.getBoundingClientRect().left));
        if (window.__sampling) requestAnimationFrame(s);
      })();
      window.stepLeft('stepLeft'); window.stepTransform('stepTf');
    });
    await page.waitForFunction(() => window.__stepLeftDone && window.__stepTfDone, null, { timeout: 4000 });
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      window.__sampling = false;
      const el = document.getElementById('stepLeft');
      return {
        left: el.style.left, tf: document.getElementById('stepTf').style.transform,
        rendered: Math.round(el.getBoundingClientRect().left),
        seenLeft: window.__seenLeft.size, seenTf: window.__seenTf.size,
        stepper: window.__still.isReadBackStepper(el), exempt: window.__still.isMotionExempt(el),
        heldAttr: el.hasAttribute('data-still-hold'), rules: (document.getElementById('__still-hold') || {}).textContent,
      };
    });
    expect(r.left).toBe('300px');                 // the loop ran to completion…
    expect(r.tf).toBe('translateX(300px)');
    expect(r.rendered).toBe(300);                 // …and the element landed there
    // …without ANY of the 30 intermediate positions ever rendering: only the
    // start and the end. The first write is held provisionally, so not even
    // the early frames before a run is recognised are painted.
    expect(r.seenLeft).toBeLessThanOrEqual(2);
    expect(r.seenTf).toBeLessThanOrEqual(2);
    expect(r.stepper).toBe(true);
    expect(r.exempt).toBe(false);                 // held, not handed back
    expect(r.heldAttr).toBe(false);               // hold released on settle
    expect(r.rules).toBe('');
  });

  test('a first-time rAF zoom-in entrance paints no intermediate frame: hidden, then final', async ({ page }) => {
    await setup(page);
    const r = await page.evaluate(async () => {
      const el = document.createElement('h2'); el.textContent = 'zoom'; el.style.cssText = 'width:300px;opacity:0;transform:scale(.6)';
      document.body.appendChild(el);
      await new Promise((res) => setTimeout(res, 100));
      const seen = new Set(); let sampling = true;
      (function s() { seen.add(Math.round(el.getBoundingClientRect().width) + '/' + (+getComputedStyle(el).opacity).toFixed(2)); if (sampling) requestAnimationFrame(s); })();
      const t0 = performance.now();
      await new Promise((done) => { (function f(now) { const t = Math.min(1, (now - t0) / 700); el.style.opacity = String(t); el.style.transform = 'scale(' + (0.6 + 0.4 * t) + ')'; if (t < 1) requestAnimationFrame(f); else done(); })(performance.now()); });
      await new Promise((res) => setTimeout(res, 400)); sampling = false;
      return { seen: [...seen], final: Math.round(el.getBoundingClientRect().width) + '/' + (+getComputedStyle(el).opacity).toFixed(2) };
    });
    expect(r.final).toBe('300/1.00');
    expect(r.seen.sort()).toEqual(['180/0.00', '300/1.00']); // never visible at the small scale
  });

  test('a loop that starts transparent is not left invisible: shown after the rescue window', async ({ page }) => {
    await setup(page);
    const r = await page.evaluate(async () => {
      const el = document.createElement('div'); el.textContent = 'pulse'; el.style.cssText = 'width:80px;opacity:0';
      document.body.appendChild(el);
      await new Promise((res) => setTimeout(res, 100));
      const t0 = performance.now();
      (function f(now) { el.style.opacity = String(0.5 + 0.5 * Math.sin((now - t0) / 200)); requestAnimationFrame(f); })(performance.now());
      await new Promise((res) => setTimeout(res, 600));
      const early = getComputedStyle(el).opacity;
      await new Promise((res) => setTimeout(res, 1900));
      const seen = new Set(); const s0 = performance.now();
      await new Promise((res) => { (function s() { seen.add(getComputedStyle(el).opacity); if (performance.now() - s0 < 400) requestAnimationFrame(s); else res(); })(); });
      return { early, late: [...seen] };
    });
    expect(r.early).toBe('0');       // held where it started, no pulsing
    expect(r.late).toEqual(['1']);   // then shown, steady — never left hidden
  });

  test('a known read-back stepper is held from its first write the next time it runs', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.stepLeft('stepLeft'));
    await page.waitForFunction(() => window.__stepLeftDone, null, { timeout: 4000 });
    await page.waitForTimeout(500);
    const seen = await page.evaluate(async () => {
      const el = document.getElementById('stepLeft');
      const seen = new Set(); let sampling = true;
      (function s() { seen.add(Math.round(el.getBoundingClientRect().left)); if (sampling) requestAnimationFrame(s); })();
      // Close it again: step back down from 300 to 0, reading its own value.
      await new Promise((done) => {
        const step = () => {
          el.style.left = (parseFloat(el.style.left) - 10) + 'px';
          if (parseFloat(el.style.left) > 0) requestAnimationFrame(step); else done();
        };
        step();
      });
      await new Promise((res) => setTimeout(res, 400));
      sampling = false;
      return { n: seen.size, final: Math.round(el.getBoundingClientRect().left), left: el.style.left };
    });
    expect(seen.left).toBe('0px');
    expect(seen.final).toBe(0);
    expect(seen.n).toBeLessThanOrEqual(2); // 300, then 0 — nothing in between
  });

  test('a read-back loop that never ends (marquee) stays frozen while its own values keep advancing', async ({ page }) => {
    await setup(page);
    const r = await page.evaluate(async () => {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;top:400px;left:500px;width:50px;height:20px;background:#a3a';
      document.body.appendChild(el);
      const tick = () => { el.style.left = (parseFloat(el.style.left) - 1) + 'px'; requestAnimationFrame(tick); };
      tick();
      await new Promise((res) => setTimeout(res, 700)); // detection window
      const seen = new Set(); const t0 = performance.now();
      const inline0 = parseFloat(el.style.left);
      await new Promise((res) => { (function s() { seen.add(Math.round(el.getBoundingClientRect().left)); if (performance.now() - t0 < 600) requestAnimationFrame(s); else res(); })(); });
      return { rendered: seen.size, inlineMoved: inline0 - parseFloat(el.style.left) };
    });
    expect(r.rendered).toBe(1);                    // nothing moves on screen
    expect(r.inlineMoved).toBeGreaterThan(10);     // the page's own counter is untouched
  });

  test('a return-to-rest animation lands AT rest, not on its penultimate frame', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.shake('shaker'));
    await page.waitForFunction(() => window.__shakeDone);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.getElementById('shaker').style.transform)).toBe('translateX(0px)');
    expect(await page.evaluate(() => Math.round(document.getElementById('shaker').getBoundingClientRect().left * 100))).toBe(0);
  });

  test('JS sprite tickers (background-position) are withheld, fast and slow', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.sprite('sprite', 50); window.sprite('slowsprite', 150); });
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => window.countBgStates('sprite', 1200))).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.countBgStates('slowsprite', 1200))).toBeLessThanOrEqual(2);
  });

  test('a positioner writing several times inside one frame is not an animation: it lands once, after the provisional hold', async ({ page }) => {
    await setup(page);
    const r = await page.evaluate(async () => {
      const el = document.getElementById('tip');
      const start = Math.round(el.getBoundingClientRect().left);
      const seen = new Set(); let sampling = true;
      (function s() { seen.add(Math.round(el.getBoundingClientRect().left)); if (sampling) requestAnimationFrame(s); })();
      el.style.transform = 'translate(10px, 10px)';
      await Promise.resolve(); await new Promise((res) => queueMicrotask(res));
      el.style.transform = 'translate(200px, 80px)';
      await Promise.resolve(); await new Promise((res) => queueMicrotask(res));
      el.style.transform = 'translate(220px, 90px)';
      await Promise.resolve(); await new Promise((res) => queueMicrotask(res));
      el.style.opacity = '1';
      await new Promise((res) => setTimeout(res, 200)); // past MOTION_PROVISIONAL_MS
      sampling = false;
      const b = el.getBoundingClientRect();
      return { start, left: Math.round(b.left), seen: [...seen], withheld: window.__still.isMotionWithheld(el), self: window.__still.isSelfAnimator(el), tf: el.style.transform };
    });
    expect(r.withheld).toBe(false);
    expect(r.self).toBe(false);
    expect(r.tf).toBe('translate(220px, 90px)');
    expect(r.left).toBe(r.start + 220);
    // Rendered only where it started and where it ended up — never at the
    // intermediate 10px / 200px positions.
    expect(r.seen.sort((a, b) => a - b)).toEqual([r.start, r.start + 220]);
  });

  test('a known self-animator is withheld from its FIRST frame (no forward-forward-snap-back)', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.tween('reveal', 300, { noOpacity: true }));
    await page.waitForFunction(() => window.__tweenDone);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__still.isSelfAnimator(document.getElementById('reveal')))).toBe(true);
    await page.evaluate(() => { window.startSampling('reveal', 900); window.tween('reveal', 400, { noOpacity: true }); });
    await page.waitForFunction(() => window.__samplingDone);
    // Rest before, rest after, and nothing in between: the tween starts 40px
    // away and ends where it began, so a fully withheld run renders ONE state.
    expect(await page.evaluate(() => window.distinctStates())).toBe(1);
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
