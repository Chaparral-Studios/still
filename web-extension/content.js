/* Still — content script
   Blocks animated images, replacing them with a static placeholder.

   Strategy:
   1. declarativeNetRequest blocks .gif URLs at network level (always animated)
   2. .webp/.apng — fetched partially to check for animation markers before replacing
   3. Extensionless URLs — HEAD request to check content-type
   4. lockImage() overrides img.src setter to prevent page JS from swapping back
   5. Cancels CSS animations
   Note: video elements are left to other extensions (e.g. StopTheMadness Pro) */

(function () {
  'use strict';

  const GIF_EXT_RE = /\.gif(\?|$)/i;
  const MAYBE_ANIMATED_EXT_RE = /\.(webp|apng)(\?|$)/i;
  const DATA_GIF_RE = /^data:image\/gif[;,]/i;
  const STATIC_EXT_RE = /\.(jpe?g|png|svg|bmp|ico|avif)(\?|$)/i;
  let enabled = true;
  let siteAllowed = false;

  // Inline SVG placeholder — pause icon on light gray background
  const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23e8e8e8' rx='4'/%3E%3Crect x='35' y='25' width='8' height='50' fill='%23bbb' rx='2'/%3E%3Crect x='57' y='25' width='8' height='50' fill='%23bbb' rx='2'/%3E%3C/svg%3E";

  const replacedURLs = new Set();
  const flaggedAnimatedURLs = new Set();

  // --- CSS: hide potentially-animated images while checking; stabilize replaced images;
  //         kill all transitions to prevent smooth/subliminal motion ---
  const style = document.createElement('style');
  style.id = '__still-hide';
  style.textContent = [
    // Kill all CSS transitions so style changes are instant (prevents smooth
    // crossfades, carousel glides, etc.).
    '*, *::before, *::after { transition-duration: 0s !important; }',
    // Kill animations ONLY on html/body. Universal `animation-duration: 0s`
    // breaks sites that animate interior elements (page icons, filter chips,
    // etc.) from a larger staging state to their resting size — tested and
    // confirmed on vons.com. Scoping to html/body is enough to kill the
    // common "body fade-in reveal" pattern (WordPress pattern that hid the
    // whole page on nplusonemag.com) without affecting page-internal
    // animations. JS cancelAnimations() handles other page-level concerns
    // with selective finish/cancel semantics.
    'html, body {',
    '  animation-duration: 0s !important;',
    '  animation-delay: 0s !important;',
    '  animation-fill-mode: forwards !important;',
    '}',
    // Hide .gif/.webp/.apng while we check — visibility:hidden preserves layout (no shift)
    'img[src$=".gif"], img[src*=".gif?"],',
    'img[src$=".webp"], img[src*=".webp?"],',
    'img[src$=".apng"], img[src*=".apng?"]',
    '{ visibility: hidden !important; }',
    'img[data-still="replacing"] { visibility: hidden !important; }',
    // Once confirmed static, unhide (set by JS via data-still="static")
    'img[data-still="static"] { visibility: visible !important; }',
    // Keep replaced images visually stable even if page JS briefly changes src
    'img[data-still="replaced"] {',
    '  visibility: visible !important;',
    "  background: #e8e8e8 url(\"" + PLACEHOLDER + "\") center/contain no-repeat !important;",
    '  object-position: -9999px -9999px !important;',
    '}'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  const api = typeof browser !== 'undefined' ? browser : chrome;

  // --- Helpers: wrap callback APIs to handle both Promise (Safari) and callback (Chrome) ---

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        const result = api.storage.local.get(keys, (r) => resolve(r));
        if (result && typeof result.then === 'function') {
          result.then(resolve);
        }
      } catch (e) {
        resolve({});
      }
    });
  }

  function sendMsg(msg) {
    try {
      const result = api.runtime.sendMessage(msg);
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
      }
    } catch (e) {}
  }

  // --- State ---

  function checkState() {
    storageGet(['enabled', 'allowlist']).then((result) => {
      enabled = result.enabled !== false;
      const allowlist = result.allowlist || [];
      siteAllowed = allowlist.includes(location.hostname);

      if (!enabled || siteAllowed) {
        style.remove();
        document.querySelectorAll('img[data-still="replacing"]').forEach((img) => {
          img.dataset.still = '';
          img.style.visibility = '';
        });
      } else {
        init();
      }
    });
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'stateChanged') checkState();
    if (msg.type === 'animatedURL') {
      flaggedAnimatedURLs.add(msg.url);
      document.querySelectorAll('img').forEach((img) => {
        const src = img.currentSrc || img.src;
        if (src === msg.url && img.dataset.still !== 'replaced') {
          replaceWithPlaceholder(img);
        }
      });
    }
  });

  // --- URL helpers ---

  function isDefinitelyAnimated(src) {
    if (!src) return false;
    if (DATA_GIF_RE.test(src)) return true;
    return GIF_EXT_RE.test(src);
  }

  function isMaybeAnimated(src) {
    if (!src) return false;
    return MAYBE_ANIMATED_EXT_RE.test(src);
  }

  function hasStaticExtension(src) {
    if (!src) return false;
    return STATIC_EXT_RE.test(src);
  }

  function isExtensionless(src) {
    if (!src) return false;
    if (src.startsWith('data:')) return false;
    return !GIF_EXT_RE.test(src) && !MAYBE_ANIMATED_EXT_RE.test(src) && !STATIC_EXT_RE.test(src);
  }

  // --- Replace image with placeholder ---

  function replaceWithPlaceholder(img) {
    const originalSrc = img.currentSrc || img.src;
    replacedURLs.add(originalSrc);

    clearPictureSources(img);
    if (img.srcset) img.srcset = '';
    img.src = PLACEHOLDER;
    img.dataset.still = 'replaced';
    img.style.visibility = '';
    lockImage(img);
    sendMsg({ type: 'imageFrozen' });
  }

  function clearPictureSources(img) {
    const picture = img.closest('picture');
    if (!picture) return;
    picture.querySelectorAll('source').forEach((source) => {
      source.removeAttribute('srcset');
      source.removeAttribute('src');
    });
  }

  function lockImage(img) {
    if (img.__stillLocked) return;
    img.__stillLocked = true;

    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');

    Object.defineProperty(img, 'src', {
      get() {
        return descriptor.get.call(this);
      },
      set(val) {
        if (val === PLACEHOLDER) {
          descriptor.set.call(this, val);
        }
        // Everything else is silently dropped
      },
      configurable: true
    });

    const srcsetDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset');
    if (srcsetDescriptor) {
      Object.defineProperty(img, 'srcset', {
        get() { return srcsetDescriptor.get.call(this); },
        set() { /* drop */ },
        configurable: true
      });
    }
  }

  // --- Animation detection for WebP/APNG (partial fetch) ---

  function isAnimatedWebPBuffer(bytes) {
    // Fast check: VP8X header at byte 20 has an animation flag (bit 1).
    // RIFF(4) + size(4) + WEBP(4) + VP8X(4) + chunk_size(4) = offset 20
    if (bytes.length > 20 &&
        bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      if (bytes[20] & 0x02) return true;
    }
    // Fallback: scan for ANMF chunk which indicates animation frames
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x41 && bytes[i+1] === 0x4E && bytes[i+2] === 0x4D && bytes[i+3] === 0x46) return true;
    }
    return false;
  }

  function isAnimatedPNGBuffer(bytes) {
    // Look for acTL chunk which indicates APNG animation
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x61 && bytes[i+1] === 0x63 && bytes[i+2] === 0x54 && bytes[i+3] === 0x4C) return true;
    }
    return false;
  }

  function checkAnimationByPartialFetch(url) {
    // Fetch first 4KB — enough to find ANMF (WebP) or acTL (APNG) markers
    return fetch(url, {
      credentials: 'omit',
      headers: { 'Range': 'bytes=0-4095' }
    })
      .then((res) => res.arrayBuffer())
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        if (url.match(/\.webp(\?|$)/i)) return isAnimatedWebPBuffer(bytes);
        if (url.match(/\.apng(\?|$)/i)) return isAnimatedPNGBuffer(bytes);
        // Check both if unclear
        return isAnimatedWebPBuffer(bytes) || isAnimatedPNGBuffer(bytes);
      })
      .catch(() => false);
  }

  // --- Detect animation for extensionless URLs ---
  // Two-step: HEAD to get content-type, then partial fetch if needed

  function detectAnimationForExtensionless(url) {
    return fetch(url, { method: 'HEAD', credentials: 'omit' })
      .then((res) => {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        // GIF is always animated
        if (ct.includes('image/gif')) return true;
        // Static formats — definitely not animated
        if (ct.includes('image/jpeg') || ct.includes('image/svg') ||
            ct.includes('image/bmp') || ct.includes('image/avif')) return false;
        // WebP/APNG could be either — need to check the bytes
        if (ct.includes('image/webp') || ct.includes('image/png') || ct.includes('image/apng')) {
          return fetch(url, {
            credentials: 'omit',
            headers: { 'Range': 'bytes=0-4095' }
          })
            .then((res2) => res2.arrayBuffer())
            .then((buf) => {
              const bytes = new Uint8Array(buf);
              return isAnimatedWebPBuffer(bytes) || isAnimatedPNGBuffer(bytes);
            });
        }
        return false;
      })
      .catch(() => false);
  }

  // --- Spacer detection ---
  // Skip tiny images (spacers, tracking pixels) — not worth replacing.
  // Check both natural size and declared HTML/CSS size, because
  // declarativeNetRequest may redirect a 1x1.gif to frozen.svg,
  // changing naturalWidth to the SVG's dimensions.
  // Filename patterns that are almost certainly spacers / tracking pixels.
  // Tight match: the spacer keyword must be the exact filename basename (no
  // `-suffix` variants), optionally followed by `.trans`/`.blank`/etc. before
  // the extension. This avoids false negatives on real GIFs whose name
  // happens to contain one of these keywords (e.g., `clear-skies.gif`).
  //   matches: 1x1.gif, blank.gif, spacer.gif, transparent.gif,
  //            1x1.trans.gif, blank-spacer.gif (via .spacer.), etc.
  //   does NOT match: clear-skies.gif, blank-square.gif, 1x1-foo.gif
  const SPACER_URL_HINT_RE =
    /(?:^|\/)(?:1x1|blank|spacer|transparent|pixel|clear|empty)(?:\.(?:trans|spacer|blank|empty|clear))?\.(?:gif|png)(?:$|\?)/i;

  function isSpacer(img) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    // Only trust natural dimensions when the current src has actually
    // finished loading. `img.complete` is false after `src` is reassigned
    // and before the new resource has loaded; trusting nw/nh then would
    // let a real animated GIF leak through after a lazy-load swap from a
    // 1×1 placeholder (whose nw/nh briefly remain as 1×1).
    if (img.complete && nw > 0 && nh > 0 && nw <= 1 && nh <= 1) return true;
    // Check HTML attributes (width="1" height="1")
    const aw = parseInt(img.getAttribute('width'), 10);
    const ah = parseInt(img.getAttribute('height'), 10);
    if (aw <= 1 && ah <= 1 && aw > 0 && ah > 0) return true;
    // Check if the element is invisible (zero layout size) — but only if
    // natural dimensions confirm it's truly tiny (not just unloaded/hidden)
    if (img.offsetWidth === 0 && img.offsetHeight === 0 && nw > 0 && nh > 0) return true;
    // Filename hints — classic spacer names (1x1.trans.gif, blank.gif, etc.).
    // Narrow match: spacer keyword must be the filename basename, not a prefix.
    const src = img.currentSrc || img.src || '';
    if (SPACER_URL_HINT_RE.test(src)) return true;
    return false;
  }

  // Check if a data:image/gif URI is actually animated (has multiple frames).
  // Single-frame GIFs (spacers, static icons) should not be replaced.
  function isAnimatedDataGif(src) {
    // Look for the Netscape application extension block that signals animation:
    // bytes 0x21 0xFF 0x0B "NETSCAPE"
    // For data URIs we can decode and check.
    try {
      const b64 = src.split(/[;,]/)[2];
      if (!b64) return true; // can't parse, assume animated
      const bin = atob(b64);
      // Search for 0x21 0xFF (application extension introducer)
      for (let i = 0; i < bin.length - 3; i++) {
        if (bin.charCodeAt(i) === 0x21 && bin.charCodeAt(i + 1) === 0xFF) {
          return true; // has application extension — likely animated
        }
      }
      return false; // no animation extension found — single-frame GIF
    } catch (e) {
      return true; // can't decode, assume animated to be safe
    }
  }

  // --- Process each image ---

  function processImage(img) {
    if (!enabled || siteAllowed) return;
    if (img.dataset.still === 'replaced' || img.dataset.still === 'replacing') return;

    const src = img.currentSrc || img.src;

    // --- Path A: .gif or data:image/gif — replace immediately (always animated) ---
    if (isDefinitelyAnimated(src)) {
      // Skip tiny spacer/tracking pixels — mark static so CSS unhides them.
      // isSpacer is reliable once the image has loaded (naturalWidth>0); a
      // URL-filename match is also reliable without waiting.
      if (isSpacer(img)) { img.dataset.still = 'static'; return; }
      // For data: GIF URIs, check if actually animated (skip single-frame GIFs)
      if (DATA_GIF_RE.test(src) && !isAnimatedDataGif(src)) { img.dataset.still = 'static'; return; }
      // Not yet loaded and no URL hint — could still be a 1×1 spacer we can't
      // tell about yet. Hide until we know (defer via load event). Without
      // this, a race between page parse and our scan would have us either
      // (a) falsely replace a lazy-load placeholder (blocks the page's src
      // swap), or (b) flash the placeholder-as-pause-icon. The probing
      // state + visibility:hidden mirrors what we do for extensionless URLs.
      if (!img.complete || (img.naturalWidth === 0 && img.naturalHeight === 0)) {
        img.dataset.still = 'probing';
        img.style.visibility = 'hidden';
        const settle = () => {
          if (isSpacer(img)) {
            img.dataset.still = 'static';
            img.style.visibility = '';
          } else {
            img.dataset.still = 'replacing';
            replaceWithPlaceholder(img);
          }
        };
        img.addEventListener('load', settle, { once: true });
        // If the image fails to load (broken URL), unhide rather than leave
        // the viewport empty. It'll be re-checked if src changes.
        img.addEventListener('error', () => {
          if (img.dataset.still === 'probing') {
            img.dataset.still = 'static';
            img.style.visibility = '';
          }
        }, { once: true });
        return;
      }
      img.dataset.still = 'replacing';
      replaceWithPlaceholder(img);
      return;
    }

    // --- Path B: known static extension — skip ---
    if (hasStaticExtension(src)) return;

    // --- Path C: flagged by webRequest header inspection ---
    if (flaggedAnimatedURLs.has(src)) {
      img.dataset.still = 'replacing';
      replaceWithPlaceholder(img);
      return;
    }

    // --- Path D: .webp/.apng — check if actually animated (most aren't) ---
    if (isMaybeAnimated(src)) {
      if (img.dataset.still === 'probing' || img.dataset.still === 'static') return;
      img.dataset.still = 'probing';

      checkAnimationByPartialFetch(src).then((animated) => {
        if (animated) {
          replaceWithPlaceholder(img);
        } else {
          img.dataset.still = 'static';
        }
      });
      return;
    }

    // --- Path E: extensionless URL — hide, then HEAD + partial fetch to check ---
    if (isExtensionless(src)) {
      if (img.dataset.still === 'probing' || img.dataset.still === 'static') return;
      img.dataset.still = 'probing';
      img.style.visibility = 'hidden';

      detectAnimationForExtensionless(src).then((animated) => {
        if (animated) {
          replaceWithPlaceholder(img);
        } else {
          img.dataset.still = 'static';
          img.style.visibility = '';
        }
      });
    }
  }

  // --- CSS background-image GIF detection ---

  const bgChecked = new WeakSet();

  function scanBackgroundImages() {
    // querySelectorAll('*') is expensive — limit to elements likely to have bg images
    const candidates = document.querySelectorAll('div, span, a, section, aside, figure, li, td, button, header, footer');
    for (const el of candidates) {
      if (bgChecked.has(el)) continue;
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') continue;
      bgChecked.add(el);
      // Check if any url() in the background-image points to a GIF
      if (/url\(["']?[^"')]*\.gif(\?[^"')]*)?["']?\)/i.test(bg)) {
        el.style.setProperty('background-image', 'none', 'important');
        el.dataset.stillBg = 'blocked';
      }
    }
  }

  // --- SVG SMIL animation removal ---

  function killSVGAnimations() {
    // Pause all SVG elements' built-in animation timelines
    document.querySelectorAll('svg').forEach((svg) => {
      try { if (svg.pauseAnimations) svg.pauseAnimations(); } catch (e) {}
    });
    // Remove SMIL animation elements
    document.querySelectorAll('animate, animateTransform, animateMotion, set').forEach((el) => {
      el.remove();
    });
  }

  // --- Pause all videos ---

  function pauseVideos() {
    document.querySelectorAll('video').forEach((v) => {
      try { v.pause(); } catch (e) {}
    });
  }

  // --- Scanning ---

  function scanAll() {
    document.querySelectorAll('img').forEach(processImage);
    scanBackgroundImages();
    killSVGAnimations();
    pauseVideos();
    // Also re-run cancelAnimations on every scan so late-arriving animations
    // (async-loaded widgets like Fidelity's SVG pie chart that kicks in after
    // the data finishes loading — well past DOMContentLoaded) get caught as
    // soon as the MutationObserver notices the SVG being injected.
    cancelAnimations();
  }

  // --- MutationObserver ---

  let scanTimer = null;

  function scheduleScan() {
    if (scanTimer) return;
    if (typeof requestIdleCallback === 'function') {
      scanTimer = requestIdleCallback(() => { scanTimer = null; scanAll(); });
    } else {
      scanTimer = setTimeout(() => { scanTimer = null; scanAll(); }, 50);
    }
  }

  function observeMutations() {
    const observer = new MutationObserver((mutations) => {
      let needsScan = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.tagName === 'IMG') {
                processImage(node);
              } else if (node.tagName === 'VIDEO') {
                try { node.pause(); } catch (e) {}
              } else if (node.querySelectorAll) {
                node.querySelectorAll('img').forEach(processImage);
                node.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch (e) {} });
                // Check for SVG animations in added subtree
                if (node.tagName === 'SVG' || node.querySelector?.('svg, animate, animateTransform, animateMotion, set')) {
                  killSVGAnimations();
                }
                needsScan = true;
              }
            }
          }
        } else if (mutation.type === 'attributes') {
          const target = mutation.target;
          // Skip already-replaced images — the lock and CSS handle them
          if (target.tagName === 'IMG' && target.dataset.still === 'replaced') {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
            if (descriptor) {
              const currentSrc = descriptor.get.call(target);
              if (currentSrc !== PLACEHOLDER) {
                descriptor.set.call(target, PLACEHOLDER);
              }
            }
            continue;
          }
          // Re-process on src change unless the image is mid-probe (await'ing
          // load event). In particular, `static` images MUST be re-processed:
          // a lazy-load swap from a 1×1 spacer (marked static) to a real
          // animated GIF would otherwise leak through unblocked.
          if (target.tagName === 'IMG' && target.dataset.still !== 'probing') {
            target.dataset.still = '';
            processImage(target);
          }
          // Re-clear <source> if page JS restores it on a replaced <picture>
          if (target.tagName === 'SOURCE' && target.parentElement?.tagName === 'PICTURE') {
            const replacedImg = target.parentElement.querySelector('img[data-still="replaced"]');
            if (replacedImg) {
              target.removeAttribute('srcset');
              target.removeAttribute('src');
            }
          }
        }
      }
      if (needsScan) scheduleScan();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset']
    });
  }

  // --- CSS animation cancellation ---

  function cancelAnimations() {
    // `Animation.cancel()` reverts to PRE-animation style. `finish()` jumps to
    // the end of the active duration — but for a finite animation with fill:none
    // (default), once the active period ends the animated properties no longer
    // apply and the element reverts anyway. To reliably "snap to the end state"
    // regardless of the author's fill mode (the migraine-safety goal: "show
    // whatever the animation is progressing toward"), we upgrade fill to
    // 'forwards' via updateTiming() before calling finish(). This works for
    // Fidelity-style SVG stroke-dashoffset reveals (pie chart fill animation)
    // where the author didn't set fill: forwards — the animated pie stays fully
    // drawn instead of reverting to an invisible base.
    //
    // Rules:
    //   - Infinite iterations: cancel() — no meaningful end state; these are the
    //     ones we actually want to stop outright (spinners, loops).
    //   - Finite with any fill mode: upgrade to fill:forwards + finish() —
    //     snaps instantly to the animation's end state and keeps it there.
    try {
      for (const a of document.getAnimations({ subtree: true })) {
        try {
          const timing = a.effect && typeof a.effect.getComputedTiming === 'function'
            ? a.effect.getComputedTiming()
            : null;
          const iterations = timing && timing.iterations;
          if (iterations === Infinity) {
            a.cancel();
          } else if (a.effect && typeof a.effect.updateTiming === 'function') {
            // Force fill to forwards so the end state persists post-finish,
            // even if the author specified fill: none (default).
            try { a.effect.updateTiming({ fill: 'forwards' }); } catch (e) {}
            a.finish();
          } else {
            a.cancel();
          }
        } catch (e) {
          try { a.cancel(); } catch (e2) {}
        }
      }
    } catch (e) {}
  }

  // --- Init ---

  let initialized = false;

  function init() {
    if (initialized) return;
    initialized = true;

    scanAll();
    observeMutations();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { scanAll(); cancelAnimations(); });
    } else {
      cancelAnimations();
    }

    window.addEventListener('load', scanAll);

    // Backup cancellation passes for animations that appear after all the
    // usual hooks (lazy widgets, dashboards that load data async then render
    // an animated SVG, etc.). Cheap — cancelAnimations is just a
    // document.getAnimations() iteration; if there's nothing to cancel these
    // are near no-ops.
    [500, 1500, 4000, 10000].forEach((ms) => setTimeout(cancelAnimations, ms));
  }

  // Expose for testing
  if (typeof window !== 'undefined') {
    window.__still = {
      processImage, replaceWithPlaceholder, replacedURLs,
      isDefinitelyAnimated, isMaybeAnimated, hasStaticExtension, isExtensionless,
      isSpacer, isAnimatedDataGif,
      scanAll, scanBackgroundImages, killSVGAnimations, flaggedAnimatedURLs
    };
  }

  checkState();
})();
