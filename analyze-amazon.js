const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Collect animation data before and during load
  await page.goto('https://www.amazon.com', { waitUntil: 'networkidle', timeout: 30000 });
  
  // 1. Find all animated images (GIF, WebP, APNG)
  const animatedImages = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs
      .filter(img => img.src && (img.src.match(/\.(gif|webp|apng)/i) || img.src.includes('gif') || img.src.includes('webp')))
      .map(img => ({
        src: img.src.substring(0, 150),
        width: img.naturalWidth,
        height: img.naturalHeight,
        alt: (img.alt || '').substring(0, 80),
        classes: img.className.substring(0, 80),
        parent: img.parentElement?.tagName + '.' + (img.parentElement?.className || '').substring(0, 50)
      }));
  });
  console.log('\n=== ANIMATED IMAGES (GIF/WebP/APNG) ===');
  console.log(JSON.stringify(animatedImages, null, 2));

  // 2. Find all CSS animations currently running
  const cssAnimations = await page.evaluate(() => {
    const anims = document.getAnimations();
    return anims.map(a => ({
      name: a.animationName || a.id || 'unnamed',
      duration: a.effect?.getTiming?.()?.duration,
      iterations: a.effect?.getTiming?.()?.iterations,
      playState: a.playState,
      target: a.effect?.target?.tagName + '#' + (a.effect?.target?.id || '') + '.' + (a.effect?.target?.className || '').substring(0, 60)
    }));
  });
  console.log('\n=== CSS ANIMATIONS RUNNING ===');
  console.log(`Count: ${cssAnimations.length}`);
  console.log(JSON.stringify(cssAnimations.slice(0, 30), null, 2));

  // 3. Find elements with CSS animation/transition properties
  const animatedElements = await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
      const style = getComputedStyle(el);
      if (style.animationName !== 'none' || 
          (style.transitionProperty !== 'all' && style.transitionProperty !== '' && style.transitionDuration !== '0s')) {
        results.push({
          tag: el.tagName + '#' + (el.id || '') + '.' + (el.className || '').toString().substring(0, 60),
          animation: style.animationName !== 'none' ? style.animationName : null,
          animDuration: style.animationDuration,
          animIterations: style.animationIterationCount,
          transition: style.transitionProperty !== 'all' ? style.transitionProperty : null,
          transDuration: style.transitionDuration
        });
      }
    }
    return results;
  });
  console.log('\n=== ELEMENTS WITH CSS ANIMATION/TRANSITION ===');
  console.log(`Count: ${animatedElements.length}`);
  console.log(JSON.stringify(animatedElements.slice(0, 30), null, 2));

  // 4. Find video elements
  const videos = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('video')).map(v => ({
      src: (v.src || v.querySelector('source')?.src || '').substring(0, 150),
      autoplay: v.autoplay,
      muted: v.muted,
      loop: v.loop,
      width: v.videoWidth,
      height: v.videoHeight,
      paused: v.paused,
      classes: v.className.substring(0, 80)
    }));
  });
  console.log('\n=== VIDEO ELEMENTS ===');
  console.log(JSON.stringify(videos, null, 2));

  // 5. Find carousels / sliders / auto-rotating content
  const carousels = await page.evaluate(() => {
    const selectors = [
      '[class*="carousel"]', '[class*="slider"]', '[class*="swipe"]',
      '[class*="scroll"]', '[class*="rotate"]', '[class*="slide"]',
      '[class*="hero"]', '[class*="banner"]', '[class*="marquee"]',
      '[data-carousel]', '[data-slider]', '[role="marquee"]'
    ];
    return selectors.flatMap(sel => {
      return Array.from(document.querySelectorAll(sel)).map(el => ({
        selector: sel,
        tag: el.tagName,
        id: el.id,
        classes: el.className.toString().substring(0, 100),
        childCount: el.children.length,
        hasOverflowHidden: getComputedStyle(el).overflow === 'hidden'
      }));
    });
  });
  console.log('\n=== CAROUSELS / SLIDERS / AUTO-ROTATING ===');
  console.log(`Count: ${carousels.length}`);
  console.log(JSON.stringify(carousels.slice(0, 30), null, 2));

  // 6. Check for requestAnimationFrame usage in inline scripts
  const inlineScriptHints = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
    return scripts
      .filter(s => s.textContent.includes('requestAnimationFrame') || 
                   s.textContent.includes('setInterval') ||
                   s.textContent.includes('.animate('))
      .map(s => s.textContent.substring(0, 200));
  });
  console.log('\n=== INLINE SCRIPTS WITH ANIMATION CALLS ===');
  console.log(`Count: ${inlineScriptHints.length}`);
  inlineScriptHints.slice(0, 10).forEach((s, i) => console.log(`Script ${i}: ${s}...`));

  // 7. Take a screenshot
  await page.screenshot({ path: '/Users/jon/Documents/2026/web_extensions/no-gifs/amazon-screenshot.png', fullPage: false });
  console.log('\n=== Screenshot saved to amazon-screenshot.png ===');

  await browser.close();
})();
