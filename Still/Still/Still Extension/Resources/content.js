/* Still — content script
   Blocks animated images, replacing them with a static placeholder.

   Strategy:
   1. CSS pre-hide at document_start for URLs that look animated (.gif/.webp/
      .apng in src, srcset, or <picture> sources) — nothing paints unverified
   2. .gif — always animated; replaced with a static placeholder
   3. .webp/.apng — fetched partially to check for animation markers before replacing
   4. .png/.svg/.avif — usually static, but all three CAN animate; probed
      fail-open (visible while checking, replaced if animation is found)
   5. Extensionless URLs — HEAD request to check content-type
   6. lockImage() overrides img.src setter to prevent page JS from swapping back
   7. Cancels CSS animations
   Note: the gif/webp/apng declarativeNetRequest rulesets ship DISABLED — the
   redirect-to-frozen.svg broke spacer detection (naturalWidth becomes the
   SVG's dimensions). GIF blocking is CSS pre-hide + JS replacement, here.
   Videos: paused until user-initiated playback (see pauseVideos); gstatic AR
   preview videos are blocked outright (network rule + play() neutering). */

(function () {
  'use strict';

  const GIF_EXT_RE = /\.gif(\?|$)/i;
  const MAYBE_ANIMATED_EXT_RE = /\.(webp|apng)(\?|$)/i;
  const DATA_GIF_RE = /^data:image\/gif[;,]/i;
  const STATIC_EXT_RE = /\.(jpe?g|bmp|ico)(\?|$)/i;
  // Usually static, but each CAN animate: APNG is almost always served with a
  // plain `.png` extension (`.apng` is rare in the wild), SVG-in-<img> can run
  // SMIL/CSS animations, and animated AVIF (image sequences) exists. These are
  // far too common to hide while checking — probed fail-open instead (Path B2).
  const OPEN_PROBE_EXT_RE = /\.(png|svg|avif)(\?|$)/i;
  let enabled = true;
  let siteAllowed = false;

  // Inline SVG placeholder — pause icon on light gray background
  const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23e8e8e8' rx='4'/%3E%3Crect x='35' y='25' width='8' height='50' fill='%23bbb' rx='2'/%3E%3Crect x='57' y='25' width='8' height='50' fill='%23bbb' rx='2'/%3E%3C/svg%3E";

  const replacedURLs = new Set();
  const flaggedAnimatedURLs = new Set();

  // Selectors under which the stylesheet below pre-hides an <img>.
  // The ` i` flag matters: attribute selectors are case-sensitive by default,
  // and a cached `foo.GIF` could paint-and-animate in the window between
  // parse and our first JS scan. The srcset selectors are substring matches
  // (can false-positive on e.g. `gift-card.jpg`), which is safe: a hidden
  // static image is unhidden by processImage; a visible animated one is not
  // recoverable.
  const HIDE_IMG_SELECTOR = [
    'img[src$=".gif" i]', 'img[src*=".gif?" i]',
    'img[src$=".webp" i]', 'img[src*=".webp?" i]',
    'img[src$=".apng" i]', 'img[src*=".apng?" i]',
    'img[srcset*=".gif" i]', 'img[srcset*=".webp" i]', 'img[srcset*=".apng" i]',
    'img[src^="data:image/gif" i]'
  ].join(',\n');
  // <picture> can source the animated URL from a <source> sibling while the
  // <img> itself carries no hint. :has() is Safari 15.4+ / Chrome 105+; kept
  // as a separate rule so engines without :has() drop only this rule, not
  // the block above.
  const HIDE_PICTURE_SELECTOR = [
    'picture:has(source[srcset*=".gif" i]) img',
    'picture:has(source[srcset*=".webp" i]) img',
    'picture:has(source[srcset*=".apng" i]) img'
  ].join(',\n');

  // Whether our stylesheet is (potentially) pre-hiding this img. Used to
  // decide if a verified-static image needs the explicit data-still="static"
  // unhide. We deliberately do NOT blanket-mark every static image: the
  // `visibility: visible !important` rule would override visibility states
  // the page manages itself (carousel off-slides, dropdown thumbnails).
  function matchesHide(img) {
    if (!img.matches) return false;
    try { if (img.matches(HIDE_IMG_SELECTOR)) return true; } catch (e) {}
    try { return img.matches(HIDE_PICTURE_SELECTOR); } catch (e) { return false; }
  }

  // --- CSS: hide potentially-animated images while checking; stabilize replaced images;
  //         kill all transitions to prevent smooth/subliminal motion ---
  const style = document.createElement('style');
  style.id = '__still-hide';
  style.textContent = [
    // Kill all CSS transitions so style changes are instant (prevents smooth
    // crossfades, carousel glides, etc.).
    '*, *::before, *::after { transition-duration: 0s !important; }',
    // Specificity-armored copy of the same kill. When a site declares its own
    // `transition: ... !important` (urop.mit.edu's Max Mega Menu:
    // `#mega-menu-wrap… a.mega-menu-link { transition: 100ms all !important }`),
    // both declarations are author-origin !important and the cascade
    // tie-breaks on SPECIFICITY — the universal `*` rule (0,0,0) loses to any
    // real selector, so nav links still glide on hover. Each `:not(#…)`
    // matches every element while adding ID-level specificity; six of them
    // (6,0,0) beat any realistic site selector. Kept as a separate rule from
    // the plain one above so a parser that chokes on it drops only the armor.
    ':not(#-still-):not(#-still-):not(#-still-):not(#-still-):not(#-still-):not(#-still-),' +
    ':not(#-still-):not(#-still-):not(#-still-):not(#-still-):not(#-still-):not(#-still-)::before,' +
    ':not(#-still-):not(#-still-):not(#-still-):not(#-still-):not(#-still-):not(#-still-)::after' +
    ' { transition-duration: 0s !important; }',
    // Kill animations ONLY on html/body (covers WordPress body fade-in reveal
    // pattern that hid the whole page on nplusonemag.com). JS cancelAnimations
    // handles other page-level animations via updateTiming+finish.
    'html, body {',
    '  animation-duration: 0s !important;',
    '  animation-delay: 0s !important;',
    '  animation-fill-mode: forwards !important;',
    '}',
    // SVG path d-attribute mutation reveal animations (D3-style charts like
    // Fidelity's Goals pie chart) get hidden during their active period and
    // revealed only once `d` has stabilized — see observeMutations for the
    // settle-tracking logic. This CSS rule is the hide mechanism for light-DOM
    // SVG only; document CSS can't pierce shadow roots, so main-world-patch.js
    // inline-hides settling elements inside shadow DOM (ADP's Stencil-wrapped
    // Highcharts pie is the canonical case).
    'svg [data-still-svg-settling] {',
    '  visibility: hidden !important;',
    '}',
    // Hide .gif/.webp/.apng while we check — visibility:hidden preserves layout (no shift)
    HIDE_IMG_SELECTOR,
    '{ visibility: hidden !important; }',
    HIDE_PICTURE_SELECTOR,
    '{ visibility: hidden !important; }',
    'img[data-still="replacing"] { visibility: hidden !important; }',
    // Once confirmed static, unhide (set by JS via data-still="static")
    'img[data-still="static"] { visibility: visible !important; }',
    // Keep replaced images visually stable even if page JS briefly changes src
    'img[data-still="replaced"] {',
    '  visibility: visible !important;',
    "  background: #e8e8e8 url(\"" + PLACEHOLDER + "\") center/contain no-repeat !important;",
    '  object-position: -9999px -9999px !important;',
    '}',
    // Inline video previews used as image substitutes (Google Shopping AR
    // spin previews, e.g. `gstatic.com/search-ar-dev/...`). display:none
    // (not visibility:hidden) — Google's product cards position the video
    // absolutely over the static poster <img>, so removing it from layout
    // doesn't shift anything. visibility:hidden was leaking visible motion
    // (user report 2026-05-09) — likely because the video element kept a
    // composited layer that decoded frames even while "invisible". Pairs
    // with blockVideoPreview() which pauses and neuters .play() so JS-
    // driven hover/intersection handlers can't restart playback.
    'video[data-still-video="blocked"] {',
    '  display: none !important;',
    '}'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  const api = typeof browser !== 'undefined' ? browser : chrome;

  // --- Per-host CSS rule pack ---
  // host-rules.json is a curated list of `!important` CSS overrides for sites
  // where our general defenses don't catch all motion (e.g. JS-driven jQuery
  // animations against elements with predictable class names — see
  // president.mit.edu's `.curtain-bar`). Rules are pinned with `!important`
  // so they beat any inline styles the page's animation library writes per
  // frame — the animation still "runs", but each frame's value is overridden
  // before paint, so nothing visibly moves. Async-loaded but applied before
  // the kinds of animations we target typically fire (jQuery animate triggers
  // on image-load events, hundreds of ms after document_start).
  if (api.runtime && typeof api.runtime.getURL === 'function') {
    fetch(api.runtime.getURL('host-rules.json'))
      .then((r) => r.json())
      .then((rules) => {
        const list = rules[location.hostname];
        if (!list || !list.length) return;
        // checkState() is async and may have run before this fetch resolves.
        // If it concluded the extension is disabled / site is allowlisted,
        // skip the inject — otherwise the sheet would land in the DOM after
        // the cleanup pass and stick around forever (e.g. allowlisting
        // president.mit.edu would still pin curtain bars at left:100%).
        if (!enabled || siteAllowed) return;
        const sheet = document.createElement('style');
        sheet.id = '__still-host-rules';
        sheet.textContent = list.join('\n');
        (document.head || document.documentElement).appendChild(sheet);
      })
      .catch(() => {});
  }

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

      // Signal the main-world patch (canvas freezing lives there and has no
      // storage access). Setting this on <html> makes it skip new freezes and,
      // via its observer, undo any freeze already applied before storage
      // resolved. Cleared when enabled so a re-enable path isn't left blocked.
      try {
        if (!enabled || siteAllowed) document.documentElement.setAttribute('data-still-off', '');
        else document.documentElement.removeAttribute('data-still-off');
      } catch (e) {}

      if (!enabled || siteAllowed) {
        style.remove();
        // Also drop the per-host CSS rule pack — otherwise allowlisting a
        // site that has a host-rules entry (e.g. president.mit.edu) would
        // leave the curtain bars permanently pinned at left:100%, since the
        // !important rule keeps overriding the page's inline-style writes.
        document.getElementById('__still-host-rules')?.remove();
        // Release pinned custom props — the page's own writes resume having
        // effect on its next update (scroll event etc.); no restore needed.
        unpinAllStyles();
        document.querySelectorAll('img[data-still="replacing"]').forEach((img) => {
          img.dataset.still = '';
          img.style.visibility = '';
        });
      } else {
        // Note: init() short-circuits via `initialized` after its first run,
        // so flipping disabled→enabled on the same page won't re-inject
        // `style`, the host-rules sheet, or re-scan for missed images. The
        // popup's expected UX is "toggle requires reload to take effect" and
        // this preserves that. If we ever want hot re-enable, init() and the
        // host-rules injector would both need to be made idempotent.
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
    return !GIF_EXT_RE.test(src) && !MAYBE_ANIMATED_EXT_RE.test(src) &&
           !STATIC_EXT_RE.test(src) && !OPEN_PROBE_EXT_RE.test(src);
  }

  // --- Replace image with placeholder ---

  function freezeDimensions(img) {
    // Pin the layout box BEFORE swapping src: the placeholder SVG is 100×100
    // intrinsic, so an intrinsically-sized image would reflow (e.g. a
    // 1814×504 hero collapsing to 100×100) and everything below it jumps —
    // masonry grids re-layout under the user mid-scroll (measured on
    // giphy.com; scroll "page jumps" are a reported migraine trigger).
    // width/height attrs are presentational hints: they pin intrinsically-
    // sized images but lose to any page CSS, so responsive layouts keep
    // control.
    if (img.getAttribute('width') || img.getAttribute('height')) return;
    let w = img.offsetWidth;
    let h = img.offsetHeight;
    if (!(w > 0 && h > 0)) {
      // Not laid out (display:none subtree etc.) — fall back to the
      // original resource's intrinsic size, captured before the swap.
      w = img.naturalWidth;
      h = img.naturalHeight;
    }
    if (w > 0 && h > 0) {
      try {
        img.setAttribute('width', String(w));
        img.setAttribute('height', String(h));
      } catch (e) {}
    }
  }

  // Verdicts arrive one probe at a time, so applying each instantly makes
  // tiles pop in one-by-one during scroll (measured on giphy.com: roughly
  // one tile per frame dribbling in over ~750ms after each scroll step).
  // Queue hidden→visible state flips and flush them together so a batch
  // appears in a single paint. Only used for images that are currently
  // HIDDEN (probing) — delaying those is fail-safe. Never used for the
  // fail-open Path B2, where a delay would extend visible animation.
  const revealQueue = [];
  let revealTimer = null;
  function queueReveal(fn) {
    revealQueue.push(fn);
    if (revealTimer) return;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      const q = revealQueue.splice(0);
      for (const f of q) { try { f(); } catch (e) {} }
    }, 120);
  }

  function replaceWithPlaceholder(img) {
    const originalSrc = img.currentSrc || img.src;
    replacedURLs.add(originalSrc);

    freezeDimensions(img);
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
    // Fallback: scan for ANMF chunk which indicates animation frames.
    // Bound is length - 3 (not - 4): a marker occupying the final 4 bytes
    // must still be checked.
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0x41 && bytes[i+1] === 0x4E && bytes[i+2] === 0x4D && bytes[i+3] === 0x46) return true;
    }
    return false;
  }

  function isAnimatedPNGBuffer(bytes) {
    // Look for acTL chunk which indicates APNG animation
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0x61 && bytes[i+1] === 0x63 && bytes[i+2] === 0x54 && bytes[i+3] === 0x4C) return true;
    }
    return false;
  }

  function isAnimatedAVIFBuffer(bytes) {
    // Animated AVIF (image sequence) declares the 'avis' brand in its ftyp
    // box; still AVIF uses 'avif'. The ftyp box is the first box in the
    // file, so scanning the first 64 bytes covers major + compatible brands
    // without ever reading codec payload (no false-positive risk).
    const limit = Math.min(bytes.length - 3, 64);
    for (let i = 8; i < limit; i++) {
      if (bytes[i] === 0x61 && bytes[i+1] === 0x76 && bytes[i+2] === 0x69 && bytes[i+3] === 0x73) return true;
    }
    return false;
  }

  // Read at most `limit` bytes of a response body. We ask for
  // `Range: bytes=0-4095`, but many CDNs ignore Range and return 200 with
  // the FULL body — `res.arrayBuffer()` would then buffer the entire file,
  // double-downloading every probed image (the probe races the renderer's
  // own fetch). Stream just the prefix and cancel.
  function readFirstBytes(res, limit) {
    if (res.status === 206 || !res.body || typeof res.body.getReader !== 'function') {
      return res.arrayBuffer().then((buf) => new Uint8Array(buf));
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    const concat = () => {
      // Hard-cap at `limit`: a single read() chunk can carry the whole body
      // (fast/local origins), and scanning past the requested window would
      // make classification depend on network chunking.
      const out = new Uint8Array(Math.min(total, limit));
      let o = 0;
      for (const c of chunks) {
        const room = out.length - o;
        if (room <= 0) break;
        out.set(room >= c.length ? c : c.subarray(0, room), o);
        o += Math.min(c.length, room);
      }
      return out;
    };
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) return concat();
      chunks.push(value);
      total += value.length;
      if (total >= limit) {
        reader.cancel().catch(() => {});
        return concat();
      }
      return pump();
    });
    return pump();
  }

  // --- Per-URL probe memoization ---
  // Pages repeat the same asset across many <img> elements (product grids,
  // avatars, emoji). Probing each element separately costs a network
  // round-trip per instance and holds each one hidden while its own probe
  // resolves — most of the visible "pop-in" on real pages. Memoize by URL so
  // repeats resolve from the same promise. Transient verdicts ('unknown' /
  // null, e.g. a Cloudflare interstitial 403) are evicted so the load-event
  // retry paths get a fresh probe instead of the stale failure.
  const probeCache = new Map();
  function memoProbe(prefix, url, fn) {
    const key = prefix + url;
    let p = probeCache.get(key);
    if (!p) {
      p = fn(url).then((result) => {
        if (result === 'unknown' || result === null || result === undefined) {
          probeCache.delete(key);
        }
        return result;
      });
      probeCache.set(key, p);
    }
    return p;
  }

  function classifyFrameBytes(u, bytes) {
    if (u.match(/\.webp(\?|$)/i)) return isAnimatedWebPBuffer(bytes);
    if (u.match(/\.apng(\?|$)/i)) return isAnimatedPNGBuffer(bytes);
    // Check both if unclear
    return isAnimatedWebPBuffer(bytes) || isAnimatedPNGBuffer(bytes);
  }

  function bytesViaBackground(url) {
    // Byte-level sibling of probeViaBackground: the service worker's Range
    // fetch is not bound by page CORS, so it can read file prefixes from
    // CDNs with no Access-Control-Allow-Origin (i.ytimg.com an_webp hover
    // thumbnails). Resolves a Uint8Array or null.
    try {
      const p = api.runtime.sendMessage({ type: 'byteProbe', url });
      if (!p || typeof p.then !== 'function') return Promise.resolve(null);
      return p.then((r) => (r && r.ok && Array.isArray(r.bytes) && r.bytes.length)
        ? Uint8Array.from(r.bytes) : null)
        .catch(() => null);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function checkAnimationByPartialFetch(url) {
    // Fetch first 4KB — enough to find ANMF (WebP) or acTL (APNG) markers.
    // A CORS-rejected local fetch retries through the background worker
    // before giving up. Resolves true/false, or null when both fail (treated
    // as static by callers — fail open — but not memoized, so a later retry
    // can succeed).
    return memoProbe('pf:', url, (u) => fetch(u, {
      credentials: 'omit',
      headers: { 'Range': 'bytes=0-4095' }
    })
      .then((res) => readFirstBytes(res, 4096))
      .then((bytes) => classifyFrameBytes(u, bytes))
      .catch(() => bytesViaBackground(u)
        .then((bytes) => (bytes ? classifyFrameBytes(u, bytes) : null))));
  }

  // --- Fail-open probes for .png/.svg/.avif (Path B2) ---
  // These stay visible while we check (hiding every PNG on every page would
  // flicker constantly), and get replaced if the probe finds animation —
  // typically within one round-trip of first paint.

  function checkSVGAnimated(url) {
    return fetch(url, { credentials: 'omit' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        if (!text) return null;
        // SMIL animation elements, or CSS keyframes that are actually
        // referenced by an animation property (requiring both avoids
        // flagging files that ship unused keyframe defs).
        if (/<(animateTransform|animateMotion|animate|set)[\s>]/i.test(text)) return true;
        if (/@keyframes/i.test(text) && /animation(-name)?\s*:/i.test(text)) return true;
        return false;
      })
      .catch(() => null);
  }

  function checkOpenProbe(url) {
    return memoProbe('op:', url, (u) => {
      if (/\.svg(\?|$)/i.test(u)) return checkSVGAnimated(u);
      const classify = (bytes) => {
        if (/\.avif(\?|$)/i.test(u)) return isAnimatedAVIFBuffer(bytes);
        return isAnimatedPNGBuffer(bytes);
      };
      return fetch(u, { credentials: 'omit', headers: { 'Range': 'bytes=0-4095' } })
        .then((res) => readFirstBytes(res, 4096))
        .then(classify)
        .catch(() => bytesViaBackground(u)
          .then((bytes) => (bytes ? classify(bytes) : null)));
    });
  }

  // --- Detect animation for extensionless URLs ---
  // Two-step: HEAD to get content-type, then partial fetch if needed.
  // Returns 'animated', 'static', or 'unknown'. 'unknown' means HEAD failed
  // or returned a content-type we can't classify (e.g., a Cloudflare
  // interstitial returning text/html with status 403 before the page passes
  // verification). Caller should defer the decision in that case.

  function classifyByContentType(rawCt) {
    const ct = (rawCt || '').toLowerCase();
    if (ct.includes('image/gif')) return 'animated';
    if (ct.includes('image/jpeg') || ct.includes('image/svg') ||
        ct.includes('image/bmp')) return 'static';
    if (ct.includes('image/webp') || ct.includes('image/png') ||
        ct.includes('image/apng') || ct.includes('image/avif')) return 'frame-data';
    return 'unknown';
  }

  function probeViaBackground(url) {
    // Content-script fetch is bound by page CORS, so cross-origin CDN URLs
    // without Access-Control-Allow-Origin reject with TypeError. The service
    // worker runs in the extension's own origin and uses our manifest
    // host_permissions, so it can read response headers for any URL we're
    // authorized for. Used as a fallback when the local HEAD throws.
    // (newyorker.com homepage is the canonical case — animated GIFs are
    // served from media.newyorker.com via URLs ending in `/undefined`.)
    try {
      const p = api.runtime.sendMessage({ type: 'headProbe', url });
      if (!p || typeof p.then !== 'function') return Promise.resolve('unknown');
      return p.then((response) => {
        if (!response || !response.ok) return 'unknown';
        const cls = classifyByContentType(response.contentType);
        // 'frame-data' means we'd need byte-level inspection (animated WebP /
        // APNG marker) — that's also a cross-origin range fetch we can't do
        // from the content script, and we don't currently round-trip the
        // bytes through the service worker. Treat as unknown for now.
        return cls === 'frame-data' ? 'unknown' : cls;
      }).catch(() => 'unknown');
    } catch (e) {
      return Promise.resolve('unknown');
    }
  }

  function detectAnimationForExtensionless(url) {
    return memoProbe('hd:', url, (u) => fetch(u, { method: 'HEAD', credentials: 'omit' })
      .then((res) => {
        if (!res.ok) return 'unknown';
        const cls = classifyByContentType(res.headers.get('content-type'));
        if (cls !== 'frame-data') return cls;
        // WebP / APNG / non-animated PNG / AVIF: need byte-level inspection.
        return fetch(u, {
          credentials: 'omit',
          headers: { 'Range': 'bytes=0-4095' }
        })
          .then((res2) => readFirstBytes(res2, 4096))
          .then((bytes) => {
            return (isAnimatedWebPBuffer(bytes) || isAnimatedPNGBuffer(bytes) ||
                    isAnimatedAVIFBuffer(bytes)) ? 'animated' : 'static';
          })
          .catch(() => 'unknown');
      })
      .catch(() => probeViaBackground(u)));
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
  //            1x1.trans.gif, blank.spacer.gif (dot-separated infix), etc.
  //   does NOT match: clear-skies.gif, blank-square.gif, blank-spacer.gif,
  //                   1x1-foo.gif (hyphenated variants don't satisfy the
  //                   dot-separator requirement in the optional group)
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
    // HTML width="1" height="1" attrs. Only trust alongside natural-dim
    // confirmation: homedepot.com sets width="1" height="1" on real `<img>`
    // elements that CSS (`sui-w-full sui-h-full`) sizes to the container,
    // so the attrs are a layout placeholder, not a 1×1 spacer. Without
    // natural-dim corroboration we'd mark a 1814×504 animated hero static.
    const aw = parseInt(img.getAttribute('width'), 10);
    const ah = parseInt(img.getAttribute('height'), 10);
    if (aw <= 1 && ah <= 1 && aw > 0 && ah > 0 &&
        img.complete && nw > 0 && nh > 0 && nw <= 4 && nh <= 4) return true;
    // Zero layout size + tiny natural — collapsed-parent genuine spacer.
    // Don't catch large-natural images in collapsed parents: those are
    // real images temporarily hidden by their layout chain, not spacers.
    if (img.offsetWidth === 0 && img.offsetHeight === 0 &&
        nw > 0 && nh > 0 && nw <= 4 && nh <= 4) return true;
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
          // src swapped mid-probe (lazy-load) — the observer deliberately
          // ignores src changes while probing, so decide here against the
          // NEW resource instead of stale evidence about the old one.
          if ((img.currentSrc || img.src) !== src) {
            img.dataset.still = '';
            img.style.visibility = '';
            processImage(img);
            return;
          }
          if (isSpacer(img)) {
            img.dataset.still = 'static';
            img.style.visibility = '';
          } else {
            img.dataset.still = 'replacing';
            replaceWithPlaceholder(img);
          }
        };
        // Batch the reveal: the img is hidden during the probe, so deferring
        // the state flip by one flush window is fail-safe, and grouped flips
        // stop the one-tile-per-frame dribble on grid pages.
        img.addEventListener('load', () => queueReveal(settle), { once: true });
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

    // --- Path B: known static extension — skip. One wrinkle: our CSS may be
    // pre-hiding this img via a srcset substring match (e.g. srcset mentions
    // ".webp" variants while src is the .jpg fallback). Unhide via
    // data-still="static" — but only once loading settles, so we mark the
    // resource that actually won selection, not the fallback. ---
    if (hasStaticExtension(src)) {
      if (matchesHide(img)) {
        if (img.complete) {
          img.dataset.still = 'static';
        } else {
          img.addEventListener('load', () => { img.dataset.still = ''; processImage(img); }, { once: true });
          img.addEventListener('error', () => { if (!img.dataset.still) img.dataset.still = 'static'; }, { once: true });
        }
      }
      return;
    }

    // --- Path B2: .png/.svg/.avif — usually static, but APNG ships as .png,
    // SVG-in-<img> can run SMIL/CSS animations, and animated AVIF exists.
    // Probe fail-OPEN: the image stays visible while we check and is replaced
    // if animation is found. State is 'checking' (not 'probing') on purpose:
    // the MutationObserver still re-dispatches on src swaps, so a lazy-load
    // to .gif mid-check is caught immediately rather than after the probe. ---
    if (OPEN_PROBE_EXT_RE.test(src)) {
      if (img.dataset.still === 'checking' || img.dataset.still === 'checked' ||
          img.dataset.still === 'static') return;
      img.dataset.still = 'checking';
      checkOpenProbe(src).then((animated) => {
        if (img.dataset.still !== 'checking') return; // re-dispatched meanwhile
        if ((img.currentSrc || img.src) !== src) {
          img.dataset.still = '';
          processImage(img);
          return;
        }
        if (animated) {
          replaceWithPlaceholder(img);
        } else {
          // 'checked' carries no CSS rule — we never hid the image, so we
          // must not force `visibility: visible` on it either (that would
          // override page-managed visibility, e.g. carousel off-slides).
          // 'static' only when our own stylesheet is hiding it.
          img.dataset.still = matchesHide(img) ? 'static' : 'checked';
        }
      });
      return;
    }

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

      checkAnimationByPartialFetch(src).then((animated) => queueReveal(() => {
        // src swapped mid-probe — re-dispatch against the new resource.
        // (Checked at flush time, inside the queued closure, so the batch
        // delay can't reintroduce the stale-verdict race.)
        if ((img.currentSrc || img.src) !== src) {
          img.dataset.still = '';
          processImage(img);
          return;
        }
        if (animated) {
          replaceWithPlaceholder(img);
        } else {
          img.dataset.still = 'static';
        }
      }));
      return;
    }

    // --- Path E: extensionless URL — hide, then HEAD + partial fetch to check ---
    if (isExtensionless(src)) {
      if (img.dataset.still === 'probing' || img.dataset.still === 'static') return;
      img.dataset.still = 'probing';
      img.style.visibility = 'hidden';

      const apply = (result) => queueReveal(() => {
        // src swapped mid-probe (lazy-load placeholder → real image). The
        // old URL's verdict must not be applied: it could replace a now-
        // static image or, worse, mark data-still="static" (visible
        // !important) while the element now shows an animated GIF.
        // (Checked at flush time, inside the queued closure.)
        if ((img.currentSrc || img.src) !== src) {
          img.dataset.still = '';
          img.style.visibility = '';
          processImage(img);
          return;
        }
        if (result === 'animated') {
          replaceWithPlaceholder(img);
        } else {
          // 'static' or final 'unknown' — fail open (show image). The retry
          // path below already handled the recoverable-unknown case.
          img.dataset.still = 'static';
          img.style.visibility = '';
        }
      });

      detectAnimationForExtensionless(src).then((result) => {
        if (result !== 'unknown') {
          apply(result);
          return;
        }
        // HEAD failed at scan time. Common cause: the page navigated through
        // Cloudflare's "Just a moment..." interstitial, our scan ran on the
        // pre-verification document, and the resource was 403'd. Defer the
        // decision until the image actually loads — by then the resource is
        // definitely fetchable, and a fresh HEAD will return real headers.
        const retry = () => detectAnimationForExtensionless(src).then(apply);
        if (img.complete) {
          // Image is already done loading. Either it succeeded
          // (naturalWidth > 0 → retry the HEAD now that the resource is
          // definitely live) or it errored (naturalWidth === 0 → no
          // future load/error event will fire, so settle as static now;
          // otherwise the image would stay visibility:hidden forever).
          if (img.naturalWidth > 0) retry();
          else apply('static');
        } else {
          img.addEventListener('load', retry, { once: true });
          img.addEventListener('error', () => apply('static'), { once: true });
        }
      });
      return;
    }

    // --- Path F: no usable URL yet (empty src, srcset not yet resolved) ---
    // Our CSS may still be pre-hiding this img via a srcset/<picture>
    // substring match, and srcset resolution mutates no attribute (so the
    // observer never fires). Re-dispatch once the browser has selected and
    // loaded a resource; unhide if it never loads.
    if (!src && matchesHide(img) && !img.__stillAwaitingSrc) {
      img.__stillAwaitingSrc = true;
      img.addEventListener('load', () => {
        img.__stillAwaitingSrc = false;
        img.dataset.still = '';
        processImage(img);
      }, { once: true });
      img.addEventListener('error', () => {
        img.__stillAwaitingSrc = false;
        if (!img.dataset.still) img.dataset.still = 'static';
      }, { once: true });
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
      if (!bg || bg === 'none') {
        // Negative-cache, but only once the page has fully loaded: caching
        // "no background" while stylesheets are still arriving would
        // permanently skip an element whose gif background applies late.
        // Without this cache, every mutation-triggered scan re-ran
        // getComputedStyle (a forced style resolution) on nearly every
        // element on the page — the dominant scan cost on large pages.
        if (document.readyState === 'complete') bgChecked.add(el);
        continue;
      }
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

  // --- Pause all videos + neuter image-substitute video previews ---

  // URL patterns for inline videos used as animated-image substitutes —
  // muted, playsinline, aria-hidden previews that ordinary autoplay blockers
  // (Safari's built-in, StopTheMadness Pro) let through because there's no
  // `autoplay` attribute and `muted+playsinline` is exempt under spec.
  // First entry: Google Shopping's AR product spin previews on the SERP.
  const VIDEO_PREVIEW_BLOCKLIST_RE = /\/\/[^/]*\.gstatic\.com\/search-ar-dev\//i;

  function videoSrcs(v) {
    const out = [];
    if (v.currentSrc) out.push(v.currentSrc);
    if (v.src) out.push(v.src);
    v.querySelectorAll('source').forEach((s) => { if (s.src) out.push(s.src); });
    return out;
  }

  function isVideoPreviewToBlock(v) {
    return videoSrcs(v).some((s) => VIDEO_PREVIEW_BLOCKLIST_RE.test(s));
  }

  function blockVideoPreview(v) {
    if (v.dataset.stillVideo === 'blocked') return;
    v.dataset.stillVideo = 'blocked';
    try { v.pause(); } catch (e) {}
    try { v.removeAttribute('autoplay'); } catch (e) {}
    // Override .play() on this specific element so JS-triggered playback
    // (Google's IntersectionObserver / hover handlers) becomes a no-op.
    // We resolve the returned Promise to keep callers from throwing.
    try {
      Object.defineProperty(v, 'play', {
        value: function () { return Promise.resolve(); },
        writable: false,
        configurable: false,
      });
    } catch (e) {}
  }

  // Autoplay policy: a video is kept paused until playback is user-initiated.
  // Re-pause on every scan (autoplay implementations retry), EXCEPT videos
  // marked data-still-user-play — set when playback starts close to a real
  // user gesture. Two independent writers set that mark:
  //   1. main-world-patch.js's play() override, via navigator.userActivation
  //      (synchronous with the play call — most reliable);
  //   2. the gesture tracker below — capture-phase listeners in the isolated
  //      world, which keeps working when a strict CSP drops the main-world
  //      patch (google.com's require-trusted-types-for is the canonical case).
  // Without the exemption, every DOM mutation triggered a scan that re-paused
  // ALL videos, including ones the user deliberately started — YouTube kept
  // pausing mid-watch (user report 2026-07-01).
  let lastGestureAt = -Infinity;
  ['pointerdown', 'keydown', 'touchstart'].forEach((t) => {
    try {
      document.addEventListener(t, () => { lastGestureAt = performance.now(); },
        { capture: true, passive: true });
    } catch (e) {}
  });
  // 'play' doesn't bubble, but capture-phase listeners on document still see
  // it. The 2s window is wide enough for click→play handlers and SPA
  // navigations, narrow enough that scroll-triggered autoplay (wheel/trackpad
  // scrolling fires no pointerdown) stays out.
  //
  // Ungestured play is re-paused HERE, synchronously with the event — not
  // left to the next scan. Scans only fire on childList insertions, so an
  // IntersectionObserver-driven .play() on an already-inserted video (the
  // LinkedIn feed pattern, user report 2026-07-28) produces no mutation and
  // used to run until an unrelated feed mutation finally landed — or forever
  // on an idle page. The mark check below also honors the main-world patch's
  // play() override, which sets data-still-user-play synchronously *before*
  // the play event fires when navigator.userActivation is transiently active.
  document.addEventListener('play', (e) => {
    const v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    if (v.dataset.stillVideo === 'blocked') return;
    if (performance.now() - lastGestureAt < 2000) {
      try { v.setAttribute('data-still-user-play', ''); } catch (err) {}
      return;
    }
    // No recent gesture: script-driven autoplay. `initialized` gates the few
    // ms before storage resolves (init()'s first scanAll covers that window);
    // enabled/siteAllowed are re-checked live for the mid-page disable case.
    if (!initialized || !enabled || siteAllowed) return;
    if (v.hasAttribute('data-still-user-play')) return;
    try { v.pause(); } catch (err) {}
  }, true);

  // The user-play exemption covers one playback, not the element for life.
  // YouTube's hover preview reuses a single <video>, swapping src per hover
  // (user report 2026-07-31): with a sticky mark, one gestured play — a click
  // landing near any preview — unlocked every later hover preview for the
  // session. loadstart fires when the element begins loading a new resource;
  // an ungestured one clears the mark, so each new source re-earns it at its
  // play event. Gestured loadstarts keep the mark because click handlers do
  // `src = ...; v.play()` in one task and the loadstart/play event order is
  // unspecified — clearing unconditionally could wipe a just-earned mark.
  // Like 'play', 'loadstart' doesn't bubble but is seen by capture-phase
  // document listeners. MSE players keep one blob src across a watch session
  // (no re-fired loadstart), so quality switches and seeks are unaffected.
  // The pause() below is load-bearing, not belt-and-braces: swapping src on a
  // playing element does NOT set .paused back to true — the new resource
  // resumes with no paused→playing transition, so no 'play' event ever fires
  // and the re-pause listener above never sees it. loadstart is the only
  // signal for that continuation.
  document.addEventListener('loadstart', (e) => {
    const v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    if (performance.now() - lastGestureAt < 2000) return;
    try { v.removeAttribute('data-still-user-play'); } catch (err) {}
    if (!initialized || !enabled || siteAllowed) return;
    try { v.pause(); } catch (err) {}
  }, true);

  function handleVideo(v) {
    if (!v.hasAttribute('data-still-user-play')) {
      try { v.pause(); } catch (e) {}
    }
    if (isVideoPreviewToBlock(v)) blockVideoPreview(v);
  }

  function pauseVideos() {
    document.querySelectorAll('video').forEach(handleVideo);
  }

  // --- Scanning ---

  // Canvas freezes are applied by main-world-patch.js; count them on the badge
  // here (the main world can't reach extension APIs). The attribute-mutation
  // branch of the observer catches freezes that happen live; this sweep
  // catches ones that landed before the observer started (the main-world
  // patch can freeze within a few frames, while our observer waits on the
  // async storage read) or while the canvas was detached from the DOM.
  function countFrozenCanvases() {
    document.querySelectorAll(
      'canvas[data-still-canvas="frozen"], canvas[data-still-canvas="frozen-worker"]'
    ).forEach((c) => {
      if (!c.__stillCounted) {
        c.__stillCounted = true;
        sendMsg({ type: 'imageFrozen' });
      }
    });
  }

  function scanAll() {
    document.querySelectorAll('img').forEach(processImage);
    scanBackgroundImages();
    killSVGAnimations();
    pauseVideos();
    countFrozenCanvases();
    // Also re-run cancelAnimations on every scan so late-arriving animations
    // (async-loaded widgets like Fidelity's SVG pie chart that kicks in after
    // the data finishes loading — well past DOMContentLoaded) get caught as
    // soon as the MutationObserver notices the SVG being injected.
    cancelAnimations();
  }

  // --- Scroll-linked custom-property animation pinning ---
  // Pattern (gothamist.com article reading-progress bar): page JS rewrites a
  // CSS custom property in an element's inline `style` on every scroll event,
  // and a stylesheet consumes it via var() — Gothamist's Nuxt build writes
  // `--v4fda71aa: N%` (Vue v-bind() in <style>) into the fixed article header,
  // feeding a linear-gradient that sweeps solid black across the top 68px of
  // the viewport as you scroll. No Animation object (cancelAnimations can't
  // see it), nothing transitions (duration-zeroing is moot), no rAF loop, no
  // geometry attribute writes (SVG settling detector doesn't apply) — the
  // motion lives entirely in repeated inline style attribute writes.
  //
  // Detection: a SUSTAINED run of inline-style writes whose only effect is
  // changing custom properties (`--*`). Ordinary style writes (tooltip
  // positioning, show/hide, measurement) touch real properties and never
  // qualify; a theme switch rewrites custom props but lands in one or two
  // writes, under the run threshold. Once a run qualifies, the element's
  // custom properties are PINNED: current values recorded, and every later
  // write that changes one is reverted from this isolated world. Observer
  // callbacks run before paint, so reverts are invisible — the page's writes
  // simply stop reaching the screen (same before-paint trick as the
  // data-still-off defense). Pinning, not hiding: the element (a page header)
  // is legitimate UI; only its per-scroll repaint fuel is frozen.

  const STYLE_PIN_THRESHOLD = 4;   // distinct-frame custom-prop writes => pin
  const STYLE_FRAME_GAP_MS = 5;    // writes closer than this are one frame
  const STYLE_RUN_RESET_MS = 1500; // silence longer than this starts a new run
                                   // (long enough to bridge discrete mouse-
                                   // wheel clicks, short enough that isolated
                                   // writes minutes apart never accumulate)

  const styleSnaps = new WeakMap(); // el -> Map(prop -> value) last observed
  const styleRuns = new WeakMap();  // el -> { frames, lastWrite }
  const stylePins = new WeakMap();  // el -> Map(customProp -> [value, priority])

  function snapshotStyle(el) {
    const m = new Map();
    const s = el.style;
    for (let i = 0; i < s.length; i++) {
      const p = s[i];
      m.set(p, s.getPropertyValue(p));
    }
    return m;
  }

  function handleStyleMutation(el) {
    if (!enabled || siteAllowed) return;
    const cur = snapshotStyle(el);
    const prev = styleSnaps.get(el);
    styleSnaps.set(el, cur);
    if (!prev) return;
    const changed = [];
    for (const [p, v] of cur) if (prev.get(p) !== v) changed.push(p);
    for (const p of prev.keys()) if (!cur.has(p)) changed.push(p);
    if (!changed.length) return;
    if (!changed.every((p) => p.startsWith('--'))) {
      // A real style property moved too — this is ordinary DOM styling, not
      // the var()-feed pattern. Reset any run in progress.
      styleRuns.delete(el);
      return;
    }

    const pins = stylePins.get(el);
    if (pins) {
      // Pinned: revert each changed custom prop to its pinned value. A custom
      // prop first appearing after the pin gets pinned at its initial value
      // (the page introducing new per-scroll vars post-pin shouldn't reopen
      // the motion channel).
      for (const p of changed) {
        if (!pins.has(p)) {
          pins.set(p, [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
          continue;
        }
        const [v, prio] = pins.get(p);
        try {
          if (v) el.style.setProperty(p, v, prio);
          else el.style.removeProperty(p);
        } catch (e) {}
      }
      // Re-snapshot post-revert so our own write diffs as a no-op next round.
      styleSnaps.set(el, snapshotStyle(el));
      return;
    }

    const t = performance.now();
    let run = styleRuns.get(el);
    if (!run) { run = { frames: 0, lastWrite: 0 }; styleRuns.set(el, run); }
    if (run.lastWrite && t - run.lastWrite > STYLE_RUN_RESET_MS) run.frames = 0;
    if (!run.lastWrite || t - run.lastWrite > STYLE_FRAME_GAP_MS) run.frames++;
    run.lastWrite = t;
    if (run.frames >= STYLE_PIN_THRESHOLD) {
      const pinned = new Map();
      for (const [p] of cur) {
        if (p.startsWith('--')) {
          pinned.set(p, [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
        }
      }
      stylePins.set(el, pinned);
      styleRuns.delete(el);
      // Marker is cosmetic + how unpinAllStyles finds pinned elements (no
      // strong element Set — the canvas patch's SPA-leak lesson).
      try { el.setAttribute('data-still-style', 'pinned'); } catch (e) {}
    }
  }

  function unpinAllStyles() {
    try {
      document.querySelectorAll('[data-still-style="pinned"]').forEach((el) => {
        stylePins.delete(el);
        el.removeAttribute('data-still-style');
      });
    } catch (e) {}
  }

  function observeStyleMutations() {
    // Separate observer from observeMutations: `style` fires on every inline
    // write site-wide (rAF animation libraries write per element per frame),
    // so this path is built to early-out cheaply — the shared observer's
    // attribute handler does tag-specific work we'd have to skip around.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const el = m.target;
        if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.style) continue;
        // Fast path: neither old nor new value mentions a custom property —
        // skip the snapshot/diff entirely (this is the per-frame transform-
        // writer case: GSAP, parallax libs, drag handlers).
        const oldV = m.oldValue || '';
        let newV = '';
        try { newV = el.getAttribute('style') || ''; } catch (e) {}
        if (oldV.indexOf('--') === -1 && newV.indexOf('--') === -1) continue;
        handleStyleMutation(el);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
      attributeOldValue: true,
    });
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
                handleVideo(node);
              } else if (node.querySelectorAll) {
                node.querySelectorAll('img').forEach(processImage);
                node.querySelectorAll('video').forEach(handleVideo);
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
          // data-still-off (on <html>) is our disable/allowlist signal to the
          // main-world canvas patch — but it lives in the page-visible DOM, so
          // a page script could set it to switch canvas freezing off (or clear
          // it to fight an allowlist). Re-assert the truth from extension
          // state on any foreign write: the isolated world has equal DOM
          // authority, so the page cannot win this exchange.
          if (target === document.documentElement &&
              mutation.attributeName === 'data-still-off') {
            const wantOff = !enabled || siteAllowed;
            if (wantOff !== target.hasAttribute('data-still-off')) {
              try {
                if (wantOff) target.setAttribute('data-still-off', '');
                else target.removeAttribute('data-still-off');
              } catch (e) {}
            }
            continue;
          }
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
          // Late-bound video src — Google sometimes inserts <video> first then
          // assigns src as the carousel scrolls into view. Re-check on src
          // change so we still catch the AR-shopping pattern.
          if (target.tagName === 'VIDEO' && target.dataset.stillVideo !== 'blocked') {
            if (isVideoPreviewToBlock(target)) blockVideoPreview(target);
          }
          if (target.tagName === 'SOURCE' && target.parentElement?.tagName === 'VIDEO') {
            const v = target.parentElement;
            if (v.dataset.stillVideo !== 'blocked' && isVideoPreviewToBlock(v)) blockVideoPreview(v);
          }
          // A <canvas> the main-world patch has frozen (an animated WebGL/2D or
          // worker/offscreen canvas). Count it on the badge once — the main
          // world can't reach the extension APIs, so the tally happens here.
          if (target.tagName === 'CANVAS' && !target.__stillCounted) {
            const state = target.dataset.stillCanvas;
            if (state === 'frozen' || state === 'frozen-worker') {
              target.__stillCounted = true;
              sendMsg({ type: 'imageFrozen' });
            }
          }
        }
      }
      if (needsScan) scheduleScan();
    });

    // NOTE: 'd' is intentionally NOT in the filter — the handler has no
    // branch for SVG geometry (main-world-patch.js owns that), and a D3
    // chart animating `d` per rAF tick would fire this callback every frame
    // for nothing.
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-still-canvas', 'data-still-off']
    });

  }

  // NOTE: the SVG geometry-attribute prototype patch that defuses D3-style
  // chart reveals (Fidelity pie chart pattern) lives in main-world-patch.js
  // and runs at document_start via a separate manifest.json content_scripts
  // entry with "world": "MAIN". This is mandatory: content scripts run in
  // an isolated world by default, and prototype patches there only affect
  // the isolated world's Element.prototype — not the page's. We still ship
  // the CSS rule `svg [data-still-svg-settling] { visibility: hidden !important }`
  // in the <style> block above (injected from this isolated-world script),
  // which works cross-world because CSS applies to rendered DOM regardless
  // of which world the rule was added from.

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
        neutralizeAnimation(a);
      }
    } catch (e) {}
  }

  function neutralizeAnimation(a) {
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

  // Late-starting CSS animations. cancelAnimations() runs at load plus a few
  // timed passes (last at 10s) — an animation whose active period begins
  // AFTER that (hover-triggered keyframes, scroll-triggered reveals, lazy
  // widgets on long-lived pages) used to run untouched. `animationstart`
  // bubbles and fires for every CSS animation the moment it begins, so this
  // closes the hole for good. The handler runs in the same task, before the
  // next paint — at most one frame of the animation is ever visible.
  // (WAAPI element.animate() calls fire no such event; those remain covered
  // only by the timed passes — no reported site needs more yet.)
  function installAnimationStartCanceller() {
    try {
      document.addEventListener('animationstart', (e) => {
        if (!enabled || siteAllowed) return;
        const t = e.target;
        if (!t || typeof t.getAnimations !== 'function') return;
        try {
          for (const a of t.getAnimations()) neutralizeAnimation(a);
        } catch (err) {}
      }, { capture: true, passive: true });
    } catch (e) {}
  }

  // --- Init ---

  let initialized = false;

  function init() {
    if (initialized) return;
    initialized = true;

    scanAll();
    observeMutations();
    observeStyleMutations();
    installAnimationStartCanceller();

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
      scanAll, scanBackgroundImages, killSVGAnimations, flaggedAnimatedURLs,
      cancelAnimations, neutralizeAnimation, handleStyleMutation, unpinAllStyles,
      isStylePinned: (el) => stylePins.has(el),
      isVideoPreviewToBlock, blockVideoPreview, pauseVideos, handleVideo,
      isAnimatedAVIFBuffer, isAnimatedWebPBuffer, isAnimatedPNGBuffer,
      checkOpenProbe, matchesHide, probeCache,
    };
  }

  checkState();
})();
