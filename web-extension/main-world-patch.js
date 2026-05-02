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
})();
