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

  // No-op writes are skipped: React/Vue re-renders re-apply IDENTICAL attr
  // values on every commit, and D3 writes static `transform`s on every <g>.
  // Marking those hid entire charts/icons for 300ms per render pass —
  // scroll-triggered re-renders (sticky headers, virtualized lists) made
  // whole widgets blink in and out while scrolling. Only a write that
  // actually CHANGES geometry indicates animation.
  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof SVGElement && GEOM_ATTRS.has(name) &&
        this.getAttribute(name) !== String(value)) {
      markSettling(this);
    }
    return origSetAttribute.apply(this, arguments);
  };

  Element.prototype.setAttributeNS = function (ns, name, value) {
    if (this instanceof SVGElement && GEOM_ATTRS.has(name) &&
        this.getAttributeNS(ns, name) !== String(value)) {
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
    // Record user-initiated playback so the content script's re-pause pass
    // leaves this video alone (it re-pauses autoplaying videos on every scan;
    // without this mark it kept pausing YouTube mid-watch).
    // userActivation.isActive is the TRANSIENT bit — true only briefly after
    // a real gesture — so script-driven autoplay retries don't qualify.
    try {
      if (typeof navigator !== 'undefined' && navigator.userActivation &&
          navigator.userActivation.isActive && this.setAttribute) {
        this.setAttribute('data-still-user-play', '');
      }
    } catch (e) {}
    return origMediaPlay.apply(this, arguments);
  };

  // --- Animated <canvas> freezing ---
  // Canvas animations (WebGL shaders, 2D particle fields, worker/OffscreenCanvas
  // renders) are invisible to every other Still defense: they're not <img>,
  // <video>, SVG, CSS animation, or attribute mutation. We detect a canvas that
  // keeps repainting across animation frames and freeze it; one-shot/static
  // canvases (charts, a single WebGL scene) draw in a frame or two and are never
  // touched. Motion is the signal, not the element.
  //
  // Split across worlds like the rest of Still. This main-world code owns the
  // prototype hooks — getContext, the context's draw methods,
  // transferControlToOffscreen, and Worker.postMessage all execute in the page
  // world — and applies the freeze directly. The isolated content.js watches
  // the `data-still-canvas` attribute to count the freeze on the badge, and
  // signals disable/allowlist to us via a `data-still-off` attribute on <html>.
  (function () {
    var MIN_SIZE = 96;          // ignore small canvases (icon glyphs, sparklines)
    var FRAME_THRESHOLD = 3;    // distinct animation frames with draws => animating
    var TIME_MS = 400;          // ...or draws still arriving this long after the first
    var TIME_DRAWS = 8;         // ...with at least this many, to catch setTimeout loops
    var WORKER_CHECK_MS = 600;  // delay before judging a worker/offscreen canvas

    function now() { try { return performance.now(); } catch (e) { return Date.now(); } }
    function stillOff() {
      try { var de = document.documentElement; return !!(de && de.hasAttribute('data-still-off')); }
      catch (e) { return false; }
    }
    function sizeOK(canvas) {
      var w = canvas.clientWidth || canvas.width || 0;
      var h = canvas.clientHeight || canvas.height || 0;
      return w >= MIN_SIZE && h >= MIN_SIZE;
    }

    // The timestamp rAF passes every callback is identical within a frame and
    // changes between frames — so it's a free per-frame id. Draws sharing a ts
    // are one frame; a draw at a new ts is a new frame. That's how we tell
    // "repaints every frame" (animating) from "drew once and stopped" (static).
    var frameTs = 0;
    var origRAF = window.requestAnimationFrame;
    if (typeof origRAF === 'function') {
      try {
        window.requestAnimationFrame = function (cb) {
          return origRAF.call(window, function (t) { frameTs = t; return cb(t); });
        };
      } catch (e) {}
    }

    var trackers = new WeakMap();   // canvas -> tracker
    var wrappedCtx = new WeakSet();  // contexts whose draw methods we've wrapped
    var frozen = new Set();          // frozen source canvases (live refs, for unfreeze)

    function getTracker(canvas) {
      var tr = trackers.get(canvas);
      if (!tr) {
        tr = { frames: 0, lastTs: -1, count: 0, first: 0, last: 0,
               frozen: false, noop: false, kind: null };
        trackers.set(canvas, tr);
      }
      return tr;
    }

    // Interaction exemption: a canvas the user points at, scrolls on, or types
    // into is an app (game, map, drawing tool, WebGL viewer, video-call) — never
    // freeze it, and undo the freeze if we already applied one. Mirrors the
    // user-initiated-video exemption.
    function markInteracted(target) {
      var el = target;
      while (el && el.nodeType === 1 && el !== document.documentElement) {
        if (el.tagName === 'CANVAS') {
          el.__stillUserCanvas = true;
          var tr = trackers.get(el);
          if (tr && tr.frozen) unfreeze(el, tr);
          return;
        }
        el = el.parentNode;
      }
    }
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (t) {
      try {
        document.addEventListener(t, function (e) { markInteracted(e.target); },
          { capture: true, passive: true });
      } catch (e) {}
    });

    function onDraw(canvas) {
      var tr = trackers.get(canvas);
      if (!tr || tr.frozen || canvas.__stillUserCanvas) return;
      var t = now();
      if (!tr.first) tr.first = t;
      tr.last = t;
      tr.count++;
      if (frameTs !== tr.lastTs) { tr.lastTs = frameTs; tr.frames++; }
      if (tr.frames >= FRAME_THRESHOLD ||
          (tr.count >= TIME_DRAWS && (tr.last - tr.first) > TIME_MS)) {
        freezeMainThread(canvas, tr);
      }
    }

    function freezeMainThread(canvas, tr) {
      if (tr.frozen || canvas.__stillUserCanvas || stillOff() || !sizeOK(canvas)) return;
      tr.frozen = true;
      tr.noop = true;           // draw wrappers now swallow calls => the loop stops painting
      tr.kind = 'main';
      frozen.add(canvas);
      try { canvas.setAttribute('data-still-canvas', 'frozen'); } catch (e) {}
      // No overlay, no DOM surgery: a 2D canvas keeps its last bitmap, and a
      // WebGL canvas keeps its last frame because we forced preserveDrawingBuffer
      // at getContext (see below). So no-op'ing further draws leaves the final
      // frame frozen on screen — and stops wasted GPU work.
    }

    function unfreeze(canvas, tr) {
      tr.frozen = false; tr.noop = false;
      tr.frames = 0; tr.lastTs = -1; tr.count = 0; tr.first = 0; tr.last = 0;
      frozen.delete(canvas);
      try { canvas.style.removeProperty('visibility'); } catch (e) {}
      try { canvas.removeAttribute('data-still-canvas'); } catch (e) {}
    }

    // Draw entry points. Wrapping these reports paints to onDraw and, once
    // frozen, makes them no-ops (freeze the frame + halt the render loop's work).
    var GL_DRAWS = ['drawArrays', 'drawElements', 'drawArraysInstanced',
                    'drawElementsInstanced', 'drawRangeElements', 'clear', 'clearBufferfv'];
    var CTX2D_DRAWS = ['drawImage', 'fill', 'stroke', 'fillRect', 'clearRect',
                       'putImageData', 'fillText', 'strokeText'];

    function wrapDraws(ctx, canvas, names) {
      if (wrappedCtx.has(ctx)) return;
      wrappedCtx.add(ctx);
      names.forEach(function (m) {
        var orig = ctx[m];
        if (typeof orig !== 'function') return;
        try {
          ctx[m] = function () {
            var tr = trackers.get(canvas);
            if (tr && tr.noop) return undefined;   // frozen: swallow the draw
            onDraw(canvas);
            return orig.apply(ctx, arguments);
          };
        } catch (e) {}
      });
    }

    var origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      var t = String(type);
      var isGL = /webgl/i.test(t);
      var callAttrs = attrs;
      // Force preserveDrawingBuffer for WebGL so a frozen (no-op'd) canvas keeps
      // showing its last frame instead of clearing to blank on the next
      // composite. Modest cost; it's what makes the zero-DOM freeze work for GL.
      if (isGL) {
        try {
          callAttrs = {};
          if (attrs && typeof attrs === 'object') { for (var k in attrs) callAttrs[k] = attrs[k]; }
          callAttrs.preserveDrawingBuffer = true;
        } catch (e) { callAttrs = attrs; }
      }
      var ctx = arguments.length > 1
        ? origGetContext.call(this, type, callAttrs)
        : origGetContext.call(this, type);
      try {
        if (ctx && (isGL || t === '2d')) {
          getTracker(this);
          wrapDraws(ctx, this, isGL ? GL_DRAWS : CTX2D_DRAWS);
        }
      } catch (e) {}
      return ctx;
    };

    // --- Worker / OffscreenCanvas case ---
    // Rendering moves into a Worker: canvas.transferControlToOffscreen() ->
    // worker.postMessage(offscreen). The page world can't reach the worker's GL
    // context or read the canvas back, so there's no draw to count, no snapshot,
    // and no draw to no-op. Policy: an offscreen-transferred canvas that ends up
    // visibly sized is a continuous renderer (nobody spins up a worker to draw a
    // static image once). Freeze it by (1) hiding the live canvas — a guaranteed
    // motion-stop whether the loop is main-driven or worker-self-driven — and
    // (2) cutting the frame feed by suppressing postMessage to its render worker
    // (kill the loop, per the chosen aggressiveness, not just hide it).
    var offscreenSource = new WeakMap();   // OffscreenCanvas -> source <canvas>
    var canvasWorker = new WeakMap();      // source <canvas> -> its render Worker
    var suppressedWorkers = new WeakSet();

    var origTransfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
    if (typeof origTransfer === 'function') {
      HTMLCanvasElement.prototype.transferControlToOffscreen = function () {
        var off = origTransfer.apply(this, arguments);
        try {
          offscreenSource.set(off, this);
          getTracker(this).kind = 'worker';
          this.setAttribute('data-still-canvas', 'worker');
          var canvas = this;
          setTimeout(function () { maybeFreezeWorkerCanvas(canvas); }, WORKER_CHECK_MS);
        } catch (e) {}
        return off;
      };
    }

    function maybeFreezeWorkerCanvas(canvas) {
      var tr = getTracker(canvas);
      if (tr.frozen || canvas.__stillUserCanvas || stillOff() || !sizeOK(canvas)) return;
      tr.frozen = true; tr.kind = 'worker';
      frozen.add(canvas);
      try { canvas.setAttribute('data-still-canvas', 'frozen-worker'); } catch (e) {}
      var w = canvasWorker.get(canvas);
      if (w) suppressedWorkers.add(w);   // cut the frame feed to the render worker
      // Can't snapshot a transferred canvas, so there's no frozen frame to show;
      // hide it (mirrors how blocked image-substitute videos are removed).
      try { canvas.style.setProperty('visibility', 'hidden', 'important'); } catch (e) {}
    }

    if (typeof Worker !== 'undefined' && Worker.prototype && Worker.prototype.postMessage) {
      var origPost = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (msg, transferOrOpts) {
        try {
          var transfer = Array.isArray(transferOrOpts)
            ? transferOrOpts
            : (transferOrOpts && transferOrOpts.transfer);
          if (transfer) {
            for (var i = 0; i < transfer.length; i++) {
              var src = offscreenSource.get(transfer[i]);
              if (src) canvasWorker.set(src, this);
            }
          }
          if (msg && offscreenSource.get(msg)) canvasWorker.set(offscreenSource.get(msg), this);
        } catch (e) {}
        if (suppressedWorkers.has(this)) return undefined;   // frozen: drop frame ticks
        return origPost.apply(this, arguments);
      };
    }

    // Undo every freeze when content.js signals disabled/allowlisted (it sets
    // data-still-off on <html> once storage resolves — which may land just after
    // an early freeze, so this is the self-correcting path).
    function unfreezeAll() {
      frozen.forEach(function (canvas) {
        var tr = trackers.get(canvas);
        if (!tr) return;
        if (tr.kind === 'worker') {
          var w = canvasWorker.get(canvas);
          if (w) suppressedWorkers.delete(w);
          tr.frozen = false;
          try { canvas.style.removeProperty('visibility'); } catch (e) {}
          try { canvas.removeAttribute('data-still-canvas'); } catch (e) {}
        } else {
          unfreeze(canvas, tr);
        }
      });
      frozen.clear();
    }
    try {
      new MutationObserver(function () { if (stillOff()) unfreezeAll(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-still-off'] });
    } catch (e) {}

    // Test hook (main world).
    try {
      window.__stillCanvas = {
        frozenCount: function () { return frozen.size; },
        isFrozen: function (c) { var tr = trackers.get(c); return !!(tr && tr.frozen); },
        MIN_SIZE: MIN_SIZE, FRAME_THRESHOLD: FRAME_THRESHOLD,
      };
    } catch (e) {}
  })();
})();
