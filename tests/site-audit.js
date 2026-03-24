// Site audit script — inject into a page to analyze what Still would do
// Returns a summary of all images and their classifications

(() => {
  const GIF_EXT_RE = /\.gif(\?|$)/i;
  const MAYBE_ANIMATED_EXT_RE = /\.(webp|apng)(\?|$)/i;
  const DATA_GIF_RE = /^data:image\/gif[;,]/i;
  const STATIC_EXT_RE = /\.(jpe?g|png|svg|bmp|ico|avif)(\?|$)/i;

  function isSpacer(img) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (nw <= 1 && nh <= 1) return true;
    const aw = parseInt(img.getAttribute('width'), 10);
    const ah = parseInt(img.getAttribute('height'), 10);
    if (aw <= 1 && ah <= 1 && aw > 0 && ah > 0) return true;
    if (img.offsetWidth === 0 && img.offsetHeight === 0) return true;
    return false;
  }

  function isAnimatedDataGif(src) {
    try {
      const b64 = src.split(/[;,]/)[2];
      if (!b64) return true;
      const bin = atob(b64);
      for (let i = 0; i < bin.length - 3; i++) {
        if (bin.charCodeAt(i) === 0x21 && bin.charCodeAt(i + 1) === 0xFF) return true;
      }
      return false;
    } catch (e) { return true; }
  }

  function classify(img) {
    const src = img.currentSrc || img.src || '';
    if (!src) return { action: 'skip', reason: 'no-src' };

    // Path A
    if (DATA_GIF_RE.test(src)) {
      if (isSpacer(img)) return { action: 'skip', reason: 'spacer-data-gif' };
      if (!isAnimatedDataGif(src)) return { action: 'skip', reason: 'static-data-gif' };
      return { action: 'REPLACE', reason: 'animated-data-gif' };
    }
    if (GIF_EXT_RE.test(src)) {
      if (isSpacer(img)) return { action: 'skip', reason: 'spacer-url-gif' };
      return { action: 'REPLACE', reason: 'gif-url' };
    }

    // Path B
    if (STATIC_EXT_RE.test(src)) return { action: 'skip', reason: 'static-ext' };

    // Path D
    if (MAYBE_ANIMATED_EXT_RE.test(src)) return { action: 'PROBE', reason: 'webp-or-apng' };

    // Path E
    if (!src.startsWith('data:')) return { action: 'PROBE', reason: 'extensionless' };

    return { action: 'skip', reason: 'other-data-uri' };
  }

  const imgs = document.querySelectorAll('img');
  const results = [];
  const summary = { total: 0, replace: 0, probe: 0, skip: 0, byReason: {} };

  for (const img of imgs) {
    const src = img.currentSrc || img.src || '';
    const c = classify(img);
    summary.total++;
    if (c.action === 'REPLACE') summary.replace++;
    else if (c.action === 'PROBE') summary.probe++;
    else summary.skip++;
    summary.byReason[c.reason] = (summary.byReason[c.reason] || 0) + 1;

    if (c.action !== 'skip') {
      results.push({
        src: src.substring(0, 100),
        action: c.action,
        reason: c.reason,
        w: img.naturalWidth,
        h: img.naturalHeight,
      });
    }
  }

  // Also check background images
  const bgGifs = [];
  const candidates = document.querySelectorAll('div, span, a, section, aside, figure, li, td, button, header, footer');
  for (const el of candidates) {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none' && /url\(["']?[^"')]*\.gif(\?[^"')]*)?["']?\)/i.test(bg)) {
      bgGifs.push(bg.substring(0, 100));
    }
  }

  // Check SVG animations
  const smilCount = document.querySelectorAll('animate, animateTransform, animateMotion, set').length;
  const svgCount = document.querySelectorAll('svg').length;

  // Check CSS animations
  let cssAnimCount = 0;
  try { cssAnimCount = document.getAnimations({ subtree: true }).length; } catch(e) {}

  return {
    summary,
    actionItems: results.slice(0, 30),
    bgGifs,
    smilAnimations: smilCount,
    svgElements: svgCount,
    cssAnimations: cssAnimCount,
  };
})();
