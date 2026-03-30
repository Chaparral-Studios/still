const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  
  // Intercept and log animation-related network requests
  const animatedResources = [];
  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (url.match(/\.(gif|webp|apng|mp4|webm)/i) || ct.includes('image/gif') || ct.includes('image/webp') || ct.includes('video/')) {
      animatedResources.push({ url: url.substring(0, 150), contentType: ct, status: response.status() });
    }
  });

  await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000); // Let animations start

  console.log('\n=== ANIMATED NETWORK RESOURCES ===');
  console.log(`Count: ${animatedResources.length}`);
  animatedResources.forEach(r => console.log(`  ${r.contentType} | ${r.url}`));

  // Check for the hero carousel auto-rotation
  const carouselInfo = await page.evaluate(() => {
    // Look for auto-rotating carousel timers
    const heroCarousel = document.querySelector('.a-carousel-container');
    const results = {};
    
    // Check for video.js players
    const vjsPlayers = document.querySelectorAll('.video-js, [class*="vjs-"]');
    results.videoJsElements = vjsPlayers.length;
    
    // Check for actual video elements now (after JS loaded)
    const vids = document.querySelectorAll('video');
    results.videos = Array.from(vids).map(v => ({
      src: (v.src || v.currentSrc || v.querySelector('source')?.src || '').substring(0, 150),
      autoplay: v.autoplay,
      loop: v.loop,
      muted: v.muted,
      paused: v.paused,
      readyState: v.readyState,
      classes: v.className.substring(0, 100),
      parentClasses: v.parentElement?.className?.substring(0, 100) || '',
      dimensions: `${v.videoWidth}x${v.videoHeight}`
    }));

    // Check all images for WebP (Amazon uses a lot of webp)
    const allImgs = document.querySelectorAll('img');
    const webpImgs = Array.from(allImgs).filter(i => i.src.includes('.webp') || i.src.includes('webp'));
    results.webpImageCount = webpImgs.length;
    results.totalImageCount = allImgs.length;
    results.gifImages = Array.from(allImgs).filter(i => i.src.includes('.gif')).map(i => ({
      src: i.src.substring(0, 150),
      dimensions: `${i.naturalWidth}x${i.naturalHeight}`
    }));

    // Check for canvas elements (could be animation targets)
    results.canvasElements = document.querySelectorAll('canvas').length;

    // Check running animations after page has been live
    results.runningAnimations = document.getAnimations().length;
    
    // Look for elements being transformed/animated via JS (check for will-change, transform)  
    const animHints = [];
    document.querySelectorAll('*').forEach(el => {
      const s = getComputedStyle(el);
      if (s.willChange !== 'auto' || s.transform !== 'none') {
        animHints.push({
          tag: el.tagName,
          id: el.id?.substring(0, 40),
          classes: el.className?.toString().substring(0, 80),
          willChange: s.willChange,
          transform: s.transform !== 'none' ? s.transform.substring(0, 60) : null
        });
      }
    });
    results.transformedElements = animHints.slice(0, 20);
    results.transformedCount = animHints.length;

    return results;
  });
  
  console.log('\n=== DEEP PAGE ANALYSIS (after 5s) ===');
  console.log(JSON.stringify(carouselInfo, null, 2));

  // Now monitor for carousel slide transitions over 10 seconds
  console.log('\n=== MONITORING CAROUSEL MOVEMENT (10s) ===');
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(2000);
    const slideState = await page.evaluate(() => {
      const carousel = document.querySelector('.a-carousel');
      const viewport = document.querySelector('.a-carousel-viewport');
      return {
        transform: carousel?.style.transform || carousel?.style.webkitTransform || 'none',
        firstVisible: document.querySelector('.a-carousel-firstvisibleitem')?.value,
        animCount: document.getAnimations().length
      };
    });
    console.log(`  t=${(i+1)*2}s: transform=${slideState.transform}, firstVisible=${slideState.firstVisible}, anims=${slideState.animCount}`);
  }

  await page.screenshot({ path: '/Users/jon/Documents/2026/web_extensions/no-gifs/amazon-screenshot-2.png', fullPage: false });
  console.log('\n=== Screenshot 2 saved ===');
  
  await browser.close();
})();
