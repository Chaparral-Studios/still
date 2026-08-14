# Chrome Web Store listing — Still

Copy-paste source for the Developer Console fields. Keep this file in sync
with what is actually published; it is the record of what was submitted.

---

## Item name (max 75)

```
Still — stop animated GIFs and web motion
```

## Short description (max 132)

```
Stops animated GIFs, autoplay video, and CSS/canvas animation. Built for migraine, vestibular, and photosensitivity triggers.
```

## Category

Accessibility

## Language

English (United States)

---

## Detailed description (max 16,000)

```
Still stops motion on the web before it reaches you.

Animated images, autoplaying video previews, looping background canvases, and
scroll-linked decoration are not things you opted into — but for people with
migraine, vestibular disorders, or photosensitivity, they are symptom triggers,
not decoration. Still removes them and leaves the page readable.

WHAT IT STOPS

• Animated GIF, WebP, and APNG — replaced with a neutral still placeholder.
  Images are hidden before the first frame paints, not after you have already
  seen the animation start.
• Autoplaying video — paused unless you started playback yourself. Videos you
  click play on keep working normally.
• CSS transitions and keyframe animations — snapped instantly to their end
  state, so hover effects and reveals still change but never glide.
• Animated <canvas> and SVG charts — frozen once a sustained repaint is
  detected. Static charts, maps, and canvases you interact with are left alone.
• Scroll-linked motion — reading-progress sweeps and similar scroll-driven
  decoration are pinned in place.

HOW IT DECIDES

Still checks the actual bytes of an image rather than trusting the file
extension, so an animated WebP served as ".jpg" is still caught, and a static
PNG is left visible. Canvas animation is judged by sustained repainting, not by
the presence of a canvas — a game or map you click into is exempted
automatically.

CONTROL

The toolbar popup has two switches: turn Still off everywhere, or allow the
site you are currently on. The badge shows how much was stopped on the page.

PRIVACY

Still collects nothing. No analytics, no accounts, no telemetry, no external
servers. Your settings (on/off, and your list of allowed sites) are stored
locally in the browser. See the privacy policy for details.

OPEN SOURCE

Source code: https://github.com/Chaparral-Studios/still

KNOWN LIMITS

Still is deliberately aggressive about motion. On some sites, an animation used
as a loading indicator will appear frozen, and a slideshow may jump between
slides instead of sliding. Use the per-site toggle when you want a site to move
normally again.
```

---

## Permission justifications

The console asks for one justification per permission. These are the strings to
paste; each states the single feature the permission exists for.

**`host_permissions` / broad site access (`<all_urls>`)**

```
Still's purpose is to stop animations on whatever page the user is reading, and
motion triggers are not confined to a known list of sites. The content script
must run on every site the user visits to detect and replace animated images
before their first frame paints. No page content is collected, transmitted, or
stored — the script only inspects and modifies the page it runs in.
```

**`storage`**

```
Stores the user's own settings locally: whether Still is enabled, and the list
of sites the user has chosen to allow animations on. Nothing is synced or sent
anywhere.
```

**`activeTab`**

```
Used by the toolbar popup to read the current tab's hostname so it can offer a
per-site "allow this site" toggle and display how many animations were stopped
on that page.
```

**`declarativeNetRequest`**

```
Blocks one known class of auto-spinning inline product-preview videos at the
network layer (a static ruleset shipped with the extension). The rules are
declarative and static; the extension does not read request data.
```

**`webRequest`**

```
Observes response Content-Type headers for image sub-resources only, to
identify animated GIFs served from URLs with no file extension — these cannot
be classified from the URL alone. This is observation only: no request is
blocked or redirected through this API on Chrome, and no request data is
stored or transmitted.
```

**Remote code**

```
No. All code is contained in the extension package. Nothing is fetched or
evaluated at runtime.
```

---

## Data-use disclosures (Privacy practices tab)

Answer **No** to every data-collection category:

| Category | Answer |
| --- | --- |
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| Web history | No |
| User activity | No |
| Website content | No |

Then check all three certification boxes — they are all true for Still:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Single purpose** (required field):

```
Still has one purpose: to stop visual motion on web pages — animated images,
autoplaying video, and CSS/canvas/SVG animation — for users who experience
migraine, nausea, or seizures from that motion.
```

**Privacy policy URL**: the hosted copy of `privacy-policy.html` (see README).

---

## Assets

| Asset | Requirement | File |
| --- | --- | --- |
| Store icon | 128×128 PNG | `web-extension/icons/icon-128.png` |
| Screenshots | 1280×800 PNG, 1–5 | `screenshots/01-before-after.png`, `02-popup.png`, `03-what-it-stops.png` |
| Small promo tile | 440×280 PNG (optional) | not made — optional, skip for first submission |

Screenshots are regenerated with `npm run store:screenshots`.
