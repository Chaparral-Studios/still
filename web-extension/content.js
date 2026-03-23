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

  // --- CSS: hide potentially-animated images while checking; stabilize replaced images ---
  const style = document.createElement('style');
  style.id = '__still-hide';
  style.textContent = [
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
    // Look for ANMF chunk which indicates animation
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

  // --- Process each image ---

  function processImage(img) {
    if (!enabled || siteAllowed) return;
    if (img.dataset.still === 'replaced' || img.dataset.still === 'replacing') return;

    const src = img.currentSrc || img.src;

    // --- Path A: .gif or data:image/gif — replace immediately (always animated) ---
    if (isDefinitelyAnimated(src)) {
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

  // --- Scanning ---

  function scanAll() {
    document.querySelectorAll('img').forEach(processImage);
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
              } else if (node.querySelectorAll) {
                node.querySelectorAll('img').forEach(processImage);
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
          if (target.tagName === 'IMG' && target.dataset.still !== 'probing' && target.dataset.still !== 'static') {
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
    try {
      for (const a of document.getAnimations({ subtree: true })) {
        a.cancel();
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
  }

  // Expose for testing
  if (typeof window !== 'undefined') {
    window.__still = {
      processImage, replaceWithPlaceholder, replacedURLs,
      isDefinitelyAnimated, isMaybeAnimated, hasStaticExtension, isExtensionless,
      scanAll, flaggedAnimatedURLs
    };
  }

  checkState();
})();
