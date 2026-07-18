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
  // keeps repainting — a SUSTAINED run of paints, not the mere existence of
  // draws — and freeze it; one-shot/static canvases (charts, a single WebGL
  // scene, occasional redraws on resize/theme-toggle) are never touched.
  // Motion is the signal, not the element.
  //
  // Split across worlds like the rest of Still. This main-world code owns the
  // prototype hooks — getContext, the context's draw methods,
  // transferControlToOffscreen, and Worker.postMessage all execute in the page
  // world — and applies the freeze directly. The isolated content.js counts
  // freezes on the badge via the `data-still-canvas` attribute, and owns the
  // `data-still-off` disable/allowlist signal on <html>. That attribute is
  // page-visible, so content.js also DEFENDS it: foreign writes are reverted
  // from the isolated world, which the page cannot reach.
  (function () {
    var MIN_SIZE = 96;         // ignore small canvases (icon glyphs, sparklines)
    var FRAME_THRESHOLD = 3;   // paint-bursts in ONE run => animating (main thread)
    var TICK_THRESHOLD = 6;    // spaced postMessages in one run => animating
                               // (worker path; stricter so a short init
                               // handshake of 2-3 messages never trips it)
    var FRAME_GAP_MS = 5;      // draws closer together than this are one frame
    var RUN_RESET_MS = 300;    // silence longer than this starts a NEW run —
                               // unrelated one-shot redraws (load, resize,
                               // dark-mode toggle) minutes apart never
                               // accumulate into a false "animating"
    var TIME_MS = 400;         // ...or many draws still arriving this long into a run
    var TIME_DRAWS = 8;
    var ATTEMPT_MS = 250;      // min spacing of freeze-eligibility checks
                               // (sizeOK reads clientWidth = forced layout;
                               // never do that at draw-call rate)

    var origRAF = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window) : null;

    function now() { try { return performance.now(); } catch (e) { return Date.now(); } }
    function stillOff() {
      try { var de = document.documentElement; return !!(de && de.hasAttribute('data-still-off')); }
      catch (e) { return false; }
    }
    // Layout size only, and the canvas must be in the document. A detached or
    // display:none canvas paints no pixels (no motion harm) and is commonly a
    // processing surface (video-frame analysis, thumbnailing) whose draws must
    // keep working — the first version's width-attribute fallback froze those.
    // If a hidden canvas is attached/shown later while still animating, the
    // classifier (which keeps evaluating) freezes it then.
    function sizeOK(canvas) {
      if (!canvas.isConnected) return false;
      return canvas.clientWidth >= MIN_SIZE && canvas.clientHeight >= MIN_SIZE;
    }

    var trackers = new WeakMap();   // canvas -> tracker
    var wrappedCtx = new WeakSet(); // contexts whose draw methods we've wrapped
    var trackedCount = 0;           // lets input listeners early-out on canvas-free pages

    function getTracker(canvas) {
      var tr = trackers.get(canvas);
      if (!tr) {
        tr = { frames: 0, count: 0, first: 0, lastDraw: 0, attemptAt: 0,
               frozen: false, noop: false };
        trackers.set(canvas, tr);
        trackedCount++;
      }
      return tr;
    }

    // Interaction exemption: a canvas the user CLICKS or TYPES into is an app
    // (game, map, drawing tool) — never freeze it, and undo an earlier freeze.
    // 'click'/'keydown' only — deliberately NOT wheel/touchstart/pointerdown:
    // scroll gestures target whatever sits under the pointer, so for a
    // full-viewport background canvas (the exact case this feature exists for)
    // wheel/touch-scroll would permanently unfreeze the animation the user
    // installed Still to stop. A touch that becomes a scroll never fires
    // 'click', and 'keydown' only reaches a canvas that holds focus — both
    // express intent to use the canvas, not to pass by it.
    function markInteracted(target) {
      if (!trackedCount) return;
      var el = target && target.nodeType === 1 ? target : null;
      var canvas = el && el.closest ? el.closest('canvas') : null;
      if (!canvas) return;
      canvas.__stillUserCanvas = true;
      var tr = trackers.get(canvas);
      if (tr && tr.frozen) unfreeze(canvas, tr);
    }
    ['click', 'keydown'].forEach(function (t) {
      try {
        document.addEventListener(t, function (e) { markInteracted(e.target); },
          { capture: true, passive: true });
      } catch (e) {}
    });

    // Shared classifier for draw calls (main thread) and worker frame-ticks.
    // Frames are derived from time gaps — no rAF wrapping needed: paints
    // closer than FRAME_GAP_MS are one visual frame, and RUN_RESET_MS of
    // silence resets the run, so only a sustained sequence of frames counts.
    function classify(canvas, tr, threshold) {
      if (tr.frozen || canvas.__stillUserCanvas) return false;
      var t = now();
      if (tr.lastDraw && t - tr.lastDraw > RUN_RESET_MS) {
        tr.frames = 0; tr.count = 0; tr.first = 0;
      }
      if (!tr.first) tr.first = t;
      if (!tr.lastDraw || t - tr.lastDraw > FRAME_GAP_MS) tr.frames++;
      tr.lastDraw = t;
      tr.count++;
      return tr.frames >= threshold ||
             (tr.count >= TIME_DRAWS && t - tr.first > TIME_MS);
    }

    function tryFreeze(canvas, tr, worker) {
      // Eligibility is re-checked (throttled) every time the classifier says
      // "animating": a canvas that is too small / hidden / disabled NOW gets
      // frozen later if it becomes eligible while still animating. The first
      // version's one-shot decisions left late-shown canvases animating
      // forever and re-enabled sites unprotected.
      var t = now();
      if (t - tr.attemptAt < ATTEMPT_MS) return;
      tr.attemptAt = t;
      if (stillOff() || !sizeOK(canvas)) return;
      tr.frozen = true;
      if (worker) {
        // Can't snapshot or no-op a transferred canvas (the page world can't
        // reach the worker's context) — hide it. Hiding alone guarantees no
        // motion reaches the screen, whatever the worker keeps rendering.
        try { canvas.style.setProperty('visibility', 'hidden', 'important'); } catch (e) {}
        try { canvas.setAttribute('data-still-canvas', 'frozen-worker'); } catch (e) {}
      } else {
        // Zero-DOM freeze: swallow draws from the NEXT frame boundary on. The
        // 2D bitmap / GL drawing buffer (preserved via getContext below) then
        // holds the last COMPLETE frame. Engaging mid-frame froze clear-then-
        // draw loops as a blank canvas — the clear ran, the scene draws were
        // swallowed. One extra frame of animation is the price of never
        // freezing a torn or blank image.
        var engage = function () { if (tr.frozen) tr.noop = true; };
        if (origRAF) origRAF(engage); else setTimeout(engage, 0);
        try { canvas.setAttribute('data-still-canvas', 'frozen'); } catch (e) {}
      }
    }

    // One unfreeze for both freeze kinds — the visibility removal is a no-op
    // for main-thread freezes and the counter reset is harmless for worker
    // ones. (The first version had two hand-copied paths; they drifted.)
    function unfreeze(canvas, tr) {
      tr.frozen = false; tr.noop = false;
      tr.frames = 0; tr.count = 0; tr.first = 0; tr.lastDraw = 0;
      try { canvas.style.removeProperty('visibility'); } catch (e) {}
      try { canvas.removeAttribute('data-still-canvas'); } catch (e) {}
    }

    // Draw entry points. Wrapping these feeds the classifier and, once frozen,
    // swallows the calls (freeze the frame + stop wasted paint work).
    var GL_DRAWS = ['drawArrays', 'drawElements', 'drawArraysInstanced',
                    'drawElementsInstanced', 'drawRangeElements', 'clear', 'clearBufferfv'];
    var CTX2D_DRAWS = ['drawImage', 'fill', 'stroke', 'fillRect', 'clearRect',
                       'putImageData', 'fillText', 'strokeText'];

    function wrapDraws(ctx, canvas, names) {
      if (wrappedCtx.has(ctx)) return;
      wrappedCtx.add(ctx);
      var tr = getTracker(canvas);   // closed over: no per-draw WeakMap lookups
      names.forEach(function (m) {
        var orig = ctx[m];
        if (typeof orig !== 'function') return;
        try {
          ctx[m] = function () {
            if (tr.noop) return undefined;   // frozen: swallow the draw
            if (classify(canvas, tr, FRAME_THRESHOLD)) tryFreeze(canvas, tr, false);
            // `this`, not the closed-over ctx: a borrowed method call
            // (ctx.drawImage.call(other, ...)) keeps native receiver
            // semantics instead of silently painting the wrong canvas.
            return orig.apply(this, arguments);
          };
        } catch (e) {}
      });
    }

    var origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      var t = String(type);
      var isGL = /webgl/i.test(t);
      var ctx;
      // Force preserveDrawingBuffer for WebGL so a frozen (no-op'd) canvas
      // keeps its last frame instead of losing the buffer after compositing.
      // Applied whether or not the page passed attrs (the first version keyed
      // on arguments.length and silently skipped the common no-attrs call,
      // defeating its own mechanism), but NOT when Still is off for the site.
      // Known cost: apps that legally rely on the implicit post-composite
      // clear may accumulate frames — but those repaint continuously and
      // would be frozen here anyway.
      if (isGL && !stillOff()) {
        var callAttrs = {};
        try {
          if (attrs && typeof attrs === 'object') { for (var k in attrs) callAttrs[k] = attrs[k]; }
        } catch (e) {}
        callAttrs.preserveDrawingBuffer = true;
        ctx = origGetContext.call(this, type, callAttrs);
      } else {
        ctx = arguments.length > 1
          ? origGetContext.call(this, type, attrs)
          : origGetContext.call(this, type);
      }
      try {
        if (ctx && (isGL || t === '2d')) {
          wrapDraws(ctx, this, isGL ? GL_DRAWS : CTX2D_DRAWS);
        }
      } catch (e) {}
      return ctx;
    };

    // --- Worker / OffscreenCanvas case ---
    // Rendering moves into a Worker: canvas.transferControlToOffscreen() ->
    // worker.postMessage(offscreen, [offscreen]). The page world can't reach
    // the worker's context, so there are no draw calls to count. The evidence
    // channel is the frame FEED instead: main-driven render loops post a
    // message to the worker every tick. Those go through the same classifier
    // (stricter threshold — an init handshake is 2-3 messages, a render loop
    // is a sustained stream), and a sustained tick run freezes the canvas by
    // hiding it. Messages are always DELIVERED, never suppressed: the first
    // version dropped ALL traffic to the render worker, which silently broke
    // pages that multiplex rendering with data/RPC on one worker — and the
    // dropped messages were unrecoverable after unfreezing. Hiding the canvas
    // already guarantees zero motion; killing the program was overreach.
    // Known gap, accepted: a fully worker-self-driven loop (worker-side rAF,
    // zero main-thread ticks) produces no observable evidence — hiding on no
    // evidence hid real static content (offscreen-rendered charts), which is
    // worse than missing the rare self-driving case.
    var offscreenSource = new WeakMap();   // OffscreenCanvas -> source <canvas>
    var workerCanvas = new WeakMap();      // Worker -> the source <canvas> it renders

    var origTransfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
    if (typeof origTransfer === 'function') {
      HTMLCanvasElement.prototype.transferControlToOffscreen = function () {
        var off = origTransfer.apply(this, arguments);
        try { offscreenSource.set(off, this); getTracker(this); } catch (e) {}
        return off;
      };
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
              if (src) workerCanvas.set(this, src);
            }
          }
          var canvas = workerCanvas.get(this);
          if (canvas) {
            var tr = getTracker(canvas);
            if (classify(canvas, tr, TICK_THRESHOLD)) tryFreeze(canvas, tr, true);
          }
        } catch (e) {}
        return origPost.apply(this, arguments);
      };
    }

    // Undo every freeze when content.js signals disabled/allowlisted (it sets
    // data-still-off on <html> once storage resolves — which may land just
    // after an early freeze, so this is the self-correcting path). Frozen
    // canvases are found by attribute, not held in a Set: the first version's
    // strong Set retained SPA-discarded canvases (and their GL buffers) for
    // the page lifetime.
    function unfreezeAll() {
      try {
        document.querySelectorAll('canvas[data-still-canvas]').forEach(function (canvas) {
          var tr = trackers.get(canvas);
          if (tr) { unfreeze(canvas, tr); return; }
          try { canvas.style.removeProperty('visibility'); } catch (e) {}
          try { canvas.removeAttribute('data-still-canvas'); } catch (e) {}
        });
      } catch (e) {}
    }
    // documentElement normally exists at document_start, but not in every
    // embedding (test harness init scripts run pre-parse; defensive for odd
    // browser timings too) — retry the install once the DOM root exists.
    function installOffObserver() {
      try {
        new MutationObserver(function () { if (stillOff()) unfreezeAll(); })
          .observe(document.documentElement, { attributes: true, attributeFilter: ['data-still-off'] });
        return true;
      } catch (e) { return false; }
    }
    if (!installOffObserver()) {
      try {
        document.addEventListener('DOMContentLoaded', installOffObserver, { once: true });
      } catch (e) {}
    }

    // Test hook (main world).
    try {
      window.__stillCanvas = {
        frozenCount: function () {
          try { return document.querySelectorAll('canvas[data-still-canvas]').length; }
          catch (e) { return 0; }
        },
        isFrozen: function (c) { var tr = trackers.get(c); return !!(tr && tr.frozen); },
        MIN_SIZE: MIN_SIZE, FRAME_THRESHOLD: FRAME_THRESHOLD,
      };
    } catch (e) {}
  })();
})();
