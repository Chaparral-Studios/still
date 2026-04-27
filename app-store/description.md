Still blocks animated images and motion effects in Safari, giving you a calm, static browsing experience.

What it blocks:
• Animated GIFs — replaced with a static placeholder. Includes GIFs served via image-proxy URLs (Next.js, Cloudinary) and cross-origin CDNs that often slip past simpler blockers
• Animated WebP and APNG — detected by inspecting file headers; static images display normally
• CSS transitions that create subliminal smooth motion (carousel crossfades, opacity pulses, sliding banners)
• CSS background-image animations
• SVG animations
• JavaScript-driven page-load flourishes — jQuery `.animate` sweep effects, "curtain bar" reveals, and similar attention-grabbing intros
• Per-site rule pack — sites with known animation patterns (e.g. president.mit.edu's hero curtain) get tailored protection without breaking the rest of the page

What it doesn't break:
• Static images (JPEG, PNG, SVG, WebP) display normally
• Page layout and functionality are preserved
• Per-site allowlist lets you enable animations on sites you trust
• Global on/off toggle in the extension popup

Built for people with vestibular sensitivities, migraine triggers, or anyone who just wants the web to hold still.

Still runs entirely on-device. No data is collected, transmitted, or stored.
