/* Still — main-world patch
 *
 * Runs in the page's main JS world (not the content-script isolated world)
 * so that prototype patches here affect the SAME Element.prototype that
 * page scripts see when they call setAttribute.
 *
 * Loaded via manifest.json content_scripts entry with "world": "MAIN" at
 * document_start — fires BEFORE any page script has a chance to start
 * mutating SVG.
 *
 * Scope: defuse D3-style chart reveal animations that mutate an SVG
 * element's geometry attributes (`d` on path, cx/cy/r on circle, etc.)
 * every rAF tick. Neither CSS animation overrides, WAAPI cancellation,
 * nor stroke-dashoffset rules catch this because the geometry itself is
 * changing. The patch adds `data-still-svg-settling` synchronously on
 * every relevant write, and a 300ms debounced timer removes it once
 * mutations stop — meaning the chart has reached its final state. A CSS
 * rule in content.js (isolated world, via <style> injection) hides
 * elements with that attribute.
 */
(function () {
  // Marker so we can tell from outside whether this main-world script
  // ever ran on a page. Useful when diagnosing CSP / world:MAIN drops on
  // sites with strict CSPs (Google's `require-trusted-types-for 'script'`
  // is the canonical case) — without this marker the only way to tell is
  // observing prototype.play.toString() at runtime, which is racy.
  try {
    if (document && document.documentElement) {
      document.documentElement.setAttribute('data-still-mwp', 'loaded');
    }
  } catch (e) {}

  const SETTLE_MS = 300;
  const svgSettleTimers = new WeakMap();
  const origSetAttribute = Element.prototype.setAttribute;
  const origSetAttributeNS = Element.prototype.setAttributeNS;

  // SVG geometry attributes that chart libraries animate. We keep this list
  // narrow on purpose — including `x`, `y`, `width`, `height` would catch bar-
  // chart reveal animations but also trigger 300ms hides on static SVG icons
  // that frameworks (React hydration, etc.) re-apply those attrs to during
  // mount. That flash-of-hidden-content across potentially every icon on a
  // page isn't worth the coverage. Chart libraries targeting those attrs
  // specifically will slip through; revisit if reported.
  const GEOM_ATTRS = new Set([
    'd', 'points', 'transform',
    'cx', 'cy', 'r', 'rx', 'ry',
    'x1', 'y1', 'x2', 'y2',
  ]);

  function markSettling(el) {
    origSetAttribute.call(el, 'data-still-svg-settling', '');
    const existing = svgSettleTimers.get(el);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      el.removeAttribute('data-still-svg-settling');
      svgSettleTimers.delete(el);
    }, SETTLE_MS);
    svgSettleTimers.set(el, t);
  }

  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof SVGElement && GEOM_ATTRS.has(name)) {
      markSettling(this);
    }
    return origSetAttribute.apply(this, arguments);
  };

  Element.prototype.setAttributeNS = function (ns, name, value) {
    if (this instanceof SVGElement && GEOM_ATTRS.has(name)) {
      markSettling(this);
    }
    return origSetAttributeNS.apply(this, arguments);
  };

  // --- jQuery animation disable ---
  // jQuery's .animate / .fadeIn / .slideUp etc use requestAnimationFrame and
  // write inline style per frame — invisible to our CSS transition override
  // and the WAAPI cancellation pass (they're not Animation objects). Pages
  // like president.mit.edu's hero "curtain-bars" sweep 6 colored bars across
  // the viewport via `$(el).delay(N).animate({left:'98%'}, 500–700)` — a
  // migraine-grade flourish that the rest of our pipeline misses.
  //
  // jQuery ships a global kill-switch: `jQuery.fx.off = true` completes every
  // animation synchronously on the next tick, skipping straight to the end
  // state. We intercept `window.jQuery` and `window.$` via defineProperty so
  // the flag is flipped the instant the page assigns either one. Zepto uses
  // the same `fx.off` convention so this patch covers it too.
  function patchAnimatedLibrary(v) {
    // jQuery's `.fx` is `Tween.prototype.init`, which is a function (with
    // .step, .speeds, .tick, .off attached). Zepto's `.fx` is also a function
    // (constructor). Check for function OR object — excluding only null/prim.
    if (v && v.fx && (typeof v.fx === 'object' || typeof v.fx === 'function')) {
      try { v.fx.off = true; } catch (e) { /* frozen / sealed fx */ }
    }
    return v;
  }
  function defineJQueryGlobal(name) {
    let slot = window[name];
    if (slot) patchAnimatedLibrary(slot);
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return slot; },
        set: function (val) { slot = patchAnimatedLibrary(val); },
      });
    } catch (e) { /* existing non-configurable property; best-effort only */ }
  }
  defineJQueryGlobal('jQuery');
  defineJQueryGlobal('$');

  // --- HTMLMediaElement.play() interception for image-substitute videos ---
  // Inline <video> previews used as animated-GIF substitutes (Google Shopping
  // AR spin previews on the SERP, etc.) bypass autoplay blockers because they
  // ship with `muted+playsinline` (spec-exempt) and no `autoplay` attribute —
  // the page calls `.play()` from an IntersectionObserver/hover handler.
  //
  // We catch them two ways here, both synchronous to the .play() call so
  // there's no window in which a video can slip through:
  //   1. data-still-video="blocked" attribute (set by content.js when it
  //      walks the DOM; also set by us below when we match by URL).
  //   2. URL pattern check on src / currentSrc / <source> children. This is
  //      the race-safe path: Google inserts a video card and calls .play()
  //      in the SAME tick, before content.js's MutationObserver fires. If we
  //      gated only on the tag, the first .play() call would slip through
  //      (user reported: "after I scrolled down and started hovering, later
  //      stuff started playing"). The URL check runs before content.js has
  //      to do anything.
  const VIDEO_PREVIEW_BLOCKLIST_RE = /\/\/[^/]*\.gstatic\.com\/search-ar-dev\//i;
  function srcMatchesBlocklist(v) {
    const csrc = v.currentSrc;
    if (csrc && VIDEO_PREVIEW_BLOCKLIST_RE.test(csrc)) return true;
    const src = v.getAttribute && v.getAttribute('src');
    if (src && VIDEO_PREVIEW_BLOCKLIST_RE.test(src)) return true;
    if (v.querySelectorAll) {
      const sources = v.querySelectorAll('source');
      for (let i = 0; i < sources.length; i++) {
        const ss = sources[i].getAttribute && sources[i].getAttribute('src');
        if (ss && VIDEO_PREVIEW_BLOCKLIST_RE.test(ss)) return true;
      }
    }
    return false;
  }
  const origMediaPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const tagged = this.getAttribute && this.getAttribute('data-still-video') === 'blocked';
    if (tagged || srcMatchesBlocklist(this)) {
      try { this.pause(); } catch (e) {}
      // Tag the element so the CSS hide rule + MutationObserver re-checks
      // also see it. setAttribute writes a real DOM attribute that's visible
      // to the isolated-world content script too.
      try {
        if (!tagged && this.setAttribute) this.setAttribute('data-still-video', 'blocked');
      } catch (e) {}
      return Promise.resolve();
    }
    return origMediaPlay.apply(this, arguments);
  };

  // --- Canvas animation detector ---
  // Decorative canvas animations (confetti, particle backgrounds, WebGL
  // hero scenes) draw new pixels every rAF tick. URL rules can't catch
  // them, image scanning can't see canvas pixels, getAnimations() doesn't
  // know about them, and there's no <video>/<img> hook. The defining
  // invariant: they keep drawing.
  //
  // Migraine-safety constraint: never show even a single animated frame.
  // So we mirror the .gif "probing" pattern — every canvas is hidden by
  // default (CSS rule in content.js: `canvas:not([data-still-canvas="static"])
  // { visibility: hidden !important }`), and we classify each one within
  // a short probe window:
  //   - probing: hidden, count frames
  //   - threshold reached → blocked: display:none, no-op subsequent draws
  //   - probe window expires under threshold → static: revealed
  //
  // Interactive canvases (maps, charts, games) typically render 1–2 frames
  // at setup and then idle until user input, so they classify as static and
  // are free to redraw under interaction without retriggering us.
  const PROBE_WINDOW_MS = 200;
  const FRAME_THRESHOLD = 3;
  const SAME_FRAME_DEBOUNCE_MS = 5;
  const canvasStats = new WeakMap();

  function classify(canvas) {
    if (!canvas || canvas.getAttribute('data-still-canvas') !== 'probing') return;
    const s = canvasStats.get(canvas);
    const frames = s ? s.frames : 0;
    try {
      canvas.setAttribute('data-still-canvas', frames >= FRAME_THRESHOLD ? 'blocked' : 'static');
    } catch (e) {}
  }

  function instrumentCanvas(canvas) {
    if (!canvas || canvas.getAttribute('data-still-canvas')) return;
    try { canvas.setAttribute('data-still-canvas', 'probing'); } catch (e) {}
    canvasStats.set(canvas, { last: 0, frames: 0 });
    setTimeout(() => classify(canvas), PROBE_WINDOW_MS);
  }

  function recordDraw(canvas) {
    if (!canvas) return false;
    const state = canvas.getAttribute('data-still-canvas');
    if (state === 'blocked') return true; // signal: skip the draw entirely
    if (!state) instrumentCanvas(canvas);
    else if (state !== 'probing') return false; // static — leave it alone
    const s = canvasStats.get(canvas);
    if (!s) return false;
    const now = performance.now();
    if (now - s.last < SAME_FRAME_DEBOUNCE_MS) return false;
    s.last = now;
    s.frames++;
    // Cross threshold mid-probe → block immediately, no point waiting for
    // the timer.
    if (s.frames >= FRAME_THRESHOLD) {
      try { canvas.setAttribute('data-still-canvas', 'blocked'); } catch (e) {}
      return true;
    }
    return false;
  }

  // getContext is the universal entry-point — every canvas that draws goes
  // through it. Instrumenting here means we mark "probing" the instant a
  // page touches a canvas, before the first draw call lands.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function () {
    instrumentCanvas(this);
    return origGetContext.apply(this, arguments);
  };

  function patchDrawMethods(proto, methods) {
    if (!proto) return;
    methods.forEach((m) => {
      const orig = proto[m];
      if (typeof orig !== 'function') return;
      proto[m] = function () {
        const skip = recordDraw(this && this.canvas);
        if (skip) return; // blocked: no-op (saves CPU on the rAF loop)
        return orig.apply(this, arguments);
      };
    });
  }

  if (typeof CanvasRenderingContext2D !== 'undefined') {
    patchDrawMethods(CanvasRenderingContext2D.prototype, [
      'clearRect', 'fillRect', 'strokeRect',
      'drawImage', 'fill', 'stroke',
      'fillText', 'strokeText', 'putImageData',
    ]);
  }
  if (typeof WebGLRenderingContext !== 'undefined') {
    patchDrawMethods(WebGLRenderingContext.prototype, ['drawArrays', 'drawElements']);
  }
  if (typeof WebGL2RenderingContext !== 'undefined') {
    patchDrawMethods(WebGL2RenderingContext.prototype, [
      'drawArrays', 'drawElements',
      'drawArraysInstanced', 'drawElementsInstanced',
    ]);
  }
})();
