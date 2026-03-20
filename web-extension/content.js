/* Still — content script
   Hybrid approach:
   1. declarativeNetRequest blocks .gif URLs at network level (prevents cache re-trigger)
   2. Content script freezes ALL animated images (including extensionless CDN URLs)
      by capturing first frame to canvas and replacing src with static PNG
   3. lockImage() overrides img.src setter to prevent page JS from swapping back
   4. Pauses autoplay <video> elements
   5. Cancels CSS animations */

(function () {
  'use strict';

  const ANIMATED_EXT_RE = /\.(gif|webp|apng)(\?|$)/i;
  const DATA_GIF_RE = /^data:image\/gif[;,]/i;
  const STATIC_EXT_RE = /\.(jpe?g|png|svg|bmp|ico|avif)(\?|$)/i;
  let enabled = true;
  let siteAllowed = false;

  const frozenCache = new Map();
  const flaggedAnimatedURLs = new Set();

  // --- Early CSS: hide animated and extensionless images until processed ---
  const style = document.createElement('style');
  style.id = '__still-hide';
  style.textContent = [
    'img[src$=".gif"], img[src*=".gif?"],',
    'img[src$=".webp"], img[src*=".webp?"],',
    'img[src$=".apng"], img[src*=".apng?"]',
    '{ visibility: hidden !important; }',
    'img[data-still="probing"] { visibility: hidden !important; }',
    'img[data-still="freezing"] { visibility: hidden !important; }'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  const api = typeof browser !== 'undefined' ? browser : chrome;

  // --- State ---

  function checkState() {
    api.storage.local.get(['enabled', 'allowlist'], (result) => {
      enabled = result.enabled !== false;
      const allowlist = result.allowlist || [];
      siteAllowed = allowlist.includes(location.hostname);

      if (!enabled || siteAllowed) {
        style.remove();
        document.querySelectorAll('img[data-still="probing"], img[data-still="freezing"]').forEach((img) => {
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
        if (src === msg.url && img.dataset.still !== 'frozen') {
          freezeViaFetch(img, msg.url);
        }
      });
    }
  });

  // --- URL helpers ---

  function hasAnimatedExtension(src) {
    if (!src) return false;
    if (DATA_GIF_RE.test(src)) return true;
    return ANIMATED_EXT_RE.test(src);
  }

  function hasStaticExtension(src) {
    if (!src) return false;
    return STATIC_EXT_RE.test(src);
  }

  function isExtensionless(src) {
    if (!src) return false;
    if (src.startsWith('data:')) return false;
    return !ANIMATED_EXT_RE.test(src) && !STATIC_EXT_RE.test(src);
  }

  // --- Freeze: canvas approach (same-origin) ---

  function freezeViaCanvas(img) {
    const originalSrc = img.currentSrc || img.src;

    const cached = frozenCache.get(originalSrc);
    if (cached) {
      applyFrozenSrc(img, cached);
      return true;
    }

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return false;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    try {
      ctx.drawImage(img, 0, 0);
      canvas.toDataURL(); // taint check
    } catch (e) {
      // Cross-origin — fall back to fetch
      freezeViaFetch(img, originalSrc);
      return false;
    }

    const dataURL = canvas.toDataURL('image/png');
    frozenCache.set(originalSrc, dataURL);
    applyFrozenSrc(img, dataURL);
    return true;
  }

  // --- Freeze: fetch approach (cross-origin + extensionless) ---

  function freezeViaFetch(img, url) {
    if (!url || img.dataset.still === 'frozen') return;

    const cached = frozenCache.get(url);
    if (cached) {
      applyFrozenSrc(img, cached);
      return;
    }

    img.dataset.still = 'freezing';

    fetch(url, { credentials: 'omit' })
      .then((res) => res.blob())
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);

        const dataURL = canvas.toDataURL('image/png');
        frozenCache.set(url, dataURL);
        applyFrozenSrc(img, dataURL);
      })
      .catch(() => {
        img.dataset.still = 'skipped';
        img.style.visibility = '';
      });
  }

  // --- Apply frozen src + lock ---

  function applyFrozenSrc(img, dataURL) {
    clearPictureSources(img);
    if (img.srcset) img.srcset = '';
    img.src = dataURL;
    img.dataset.still = 'frozen';
    img.style.visibility = '';
    lockImage(img);
    api.runtime.sendMessage({ type: 'imageFrozen' }).catch(() => {});
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
        // Page JS trying to set a URL we've already frozen — substitute cached PNG
        if (val && !val.startsWith('data:') && frozenCache.has(val)) {
          descriptor.set.call(this, frozenCache.get(val));
          return;
        }
        // New animated URL we haven't seen — allow load, then re-freeze
        if (val && !val.startsWith('data:') && (hasAnimatedExtension(val) || isExtensionless(val))) {
          this.dataset.still = '';
          this.__stillLocked = false;
          descriptor.set.call(this, val);
          this.addEventListener('load', () => processImage(this), { once: true });
          return;
        }
        descriptor.set.call(this, val);
      },
      configurable: true
    });
  }

  // --- Header sniffing for extensionless URLs ---

  function detectAnimationByHeader(url) {
    return fetch(url, { method: 'GET', credentials: 'omit' })
      .then((res) => {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('image/gif')) {
          return res.arrayBuffer().then((buf) => isAnimatedGifBuffer(new Uint8Array(buf)));
        }
        if (ct.includes('image/webp') || ct.includes('image/apng') || ct.includes('image/png')) {
          return res.arrayBuffer().then((buf) => {
            const bytes = new Uint8Array(buf);
            if (ct.includes('image/webp')) return isAnimatedWebPBuffer(bytes);
            return isAnimatedPNGBuffer(bytes);
          });
        }
        return false;
      })
      .catch(() => false);
  }

  function isAnimatedGifBuffer(bytes) {
    let blocks = 0;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0x2C) { blocks++; if (blocks > 1) return true; }
    }
    return false;
  }

  function isAnimatedWebPBuffer(bytes) {
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x41 && bytes[i+1] === 0x4E && bytes[i+2] === 0x4D && bytes[i+3] === 0x46) return true;
    }
    return false;
  }

  function isAnimatedPNGBuffer(bytes) {
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x61 && bytes[i+1] === 0x63 && bytes[i+2] === 0x54 && bytes[i+3] === 0x4C) return true;
    }
    return false;
  }

  // --- Process each image ---

  function processImage(img) {
    if (!enabled || siteAllowed) return;
    if (img.dataset.still === 'frozen' || img.dataset.still === 'freezing') return;

    const src = img.currentSrc || img.src;

    // --- Path A: known animated extension — freeze via canvas ---
    if (hasAnimatedExtension(src)) {
      img.dataset.still = 'freezing';
      if (img.complete && img.naturalWidth) {
        freezeViaCanvas(img);
      } else {
        img.addEventListener('load', () => freezeViaCanvas(img), { once: true });
        img.addEventListener('error', () => {
          img.dataset.still = 'error';
          img.style.visibility = '';
        }, { once: true });
      }
      return;
    }

    // --- Path B: known static extension — skip ---
    if (hasStaticExtension(src)) return;

    // --- Path C: flagged by webRequest header inspection ---
    if (flaggedAnimatedURLs.has(src)) {
      img.dataset.still = 'freezing';
      freezeViaFetch(img, src);
      return;
    }

    // --- Path D: extensionless URL — hide, probe, freeze if animated ---
    if (isExtensionless(src)) {
      if (img.dataset.still === 'probing') return;
      img.dataset.still = 'probing';

      function probe() {
        // Try canvas frame comparison first (fast, same-origin)
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) { unhide(img); return; }

        const scale = Math.min(1, 100 / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');

        try {
          ctx.drawImage(img, 0, 0, cw, ch);
          const frame1 = ctx.getImageData(0, 0, cw, ch).data;

          setTimeout(() => {
            try {
              ctx.clearRect(0, 0, cw, ch);
              ctx.drawImage(img, 0, 0, cw, ch);
              const frame2 = ctx.getImageData(0, 0, cw, ch).data;

              let differs = false;
              for (let i = 0; i < frame1.length; i++) {
                if (frame1[i] !== frame2[i]) { differs = true; break; }
              }

              if (differs) {
                freezeViaCanvas(img);
              } else {
                unhide(img);
              }
            } catch (e) {
              // Tainted — fall back to header sniff
              headerProbe();
            }
          }, 120);
        } catch (e) {
          // Tainted — fall back to header sniff
          headerProbe();
        }

        function headerProbe() {
          detectAnimationByHeader(src).then((animated) => {
            if (animated) {
              freezeViaFetch(img, src);
            } else {
              unhide(img);
            }
          });
        }
      }

      if (img.complete && img.naturalWidth) {
        probe();
      } else {
        img.addEventListener('load', probe, { once: true });
        img.addEventListener('error', () => {
          img.dataset.still = 'error';
          img.style.visibility = '';
        }, { once: true });
      }
    }
  }

  function unhide(img) {
    img.dataset.still = 'static';
    img.style.visibility = '';
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
          if (target.tagName === 'IMG' && target.dataset.still !== 'frozen') {
            target.dataset.still = '';
            processImage(target);
          }
          // Re-clear <source> if page JS restores it on a frozen <picture>
          if (target.tagName === 'SOURCE' && target.parentElement?.tagName === 'PICTURE') {
            const frozenImg = target.parentElement.querySelector('img[data-still="frozen"]');
            if (frozenImg) {
              target.removeAttribute('srcset');
              target.removeAttribute('src');
            }
          }
          // Catch page JS swapping a frozen img back to animated URL
          if (target.tagName === 'IMG' && target.dataset.still === 'frozen') {
            const src = target.currentSrc || target.src;
            if (!src.startsWith('data:')) {
              target.dataset.still = '';
              processImage(target);
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

  // --- Video autoplay suppression ---

  const pausedVideos = new WeakSet();

  function suppressVideoAutoplay() {
    document.addEventListener('play', (e) => {
      if (!enabled || siteAllowed) return;
      if (e.target.tagName === 'VIDEO' && !e.target.paused) {
        if (!pausedVideos.has(e.target)) {
          pausedVideos.add(e.target);
          e.target.pause();
        }
      }
    }, true);
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
    suppressVideoAutoplay();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { scanAll(); cancelAnimations(); });
    } else {
      cancelAnimations();
    }

    window.addEventListener('load', scanAll);
    setTimeout(() => style.remove(), 500);
  }

  // Expose for testing
  if (typeof window !== 'undefined') {
    window.__still = {
      processImage, freezeViaCanvas, freezeViaFetch, frozenCache,
      hasAnimatedExtension, hasStaticExtension, isExtensionless,
      scanAll, flaggedAnimatedURLs
    };
  }

  checkState();
})();
