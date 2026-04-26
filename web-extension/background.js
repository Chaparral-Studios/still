/* Still — background service worker

   Two responsibilities:
   1. State management (toggle, allowlist, badge)
   2. webRequest header interception (Chrome/Firefox only) —
      detect image/gif Content-Type on extensionless URLs and
      redirect to a 1x1 transparent PNG before the animated
      bytes reach the renderer. Also notifies the content script
      so it knows the URL was animated. */

const api = typeof browser !== 'undefined' ? browser : chrome;

// Track frozen image counts per tab
const frozenCounts = new Map();

// 1x1 transparent PNG as a data URI — used as redirect target
const TRANSPARENT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==';

// --- Helpers: handle both Promise (Safari) and callback (Chrome) APIs ---

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

function storageSet(data) {
  return new Promise((resolve) => {
    try {
      const result = api.storage.local.set(data, () => resolve());
      if (result && typeof result.then === 'function') {
        result.then(resolve);
      }
    } catch (e) {
      resolve();
    }
  });
}

function safeSendMessage(tabId, msg) {
  try {
    const result = api.tabs.sendMessage(tabId, msg);
    if (result && typeof result.then === 'function') {
      result.catch(() => {});
    }
  } catch (e) {}
}

// --- Initialize default state ---
api.runtime.onInstalled.addListener(() => {
  storageGet(['enabled', 'allowlist']).then((result) => {
    if (result.enabled === undefined) {
      storageSet({ enabled: true });
    }
    if (!result.allowlist) {
      storageSet({ allowlist: [] });
    }
  });
});

// --- webRequest: intercept Content-Type headers (Chrome/Firefox) ---
// Safari MV3 does not support webRequest, so this is a progressive
// enhancement. The content script's HEAD-request probing is the
// fallback for Safari.

function setupWebRequestInterceptor() {
  // Check if webRequest API is available (not on Safari)
  if (!api.webRequest || !api.webRequest.onHeadersReceived) return;

  const handler = (details) => {
    // Only intercept image sub-resource requests
    if (details.type !== 'image') return;

    // Check if the response has an animated image Content-Type
    const contentType = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === 'content-type'
    );
    if (!contentType) return;

    const ct = contentType.value.toLowerCase();
    const isAnimated = ct.includes('image/gif') ||
                       ct.includes('image/webp') ||
                       ct.includes('image/apng');
    if (!isAnimated) return;

    // Skip if URL already has a known animated extension (content script handles those)
    const ANIMATED_EXT_RE = /\.(gif|webp|apng)(\?|$)/i;
    if (ANIMATED_EXT_RE.test(details.url)) return;

    const tabId = details.tabId;

    // Notify the content script about this animated URL so it can
    // replace immediately instead of waiting for the HEAD-request probe
    if (tabId > 0) {
      safeSendMessage(tabId, { type: 'animatedURL', url: details.url });
    }

    // On Firefox (MV3 supports blocking webRequest), redirect to
    // transparent PNG to prevent animated bytes from rendering.
    // On Chrome MV3 this return value is silently ignored — the
    // content script's preemptive-hide + replace handles it instead.
    return { redirectUrl: TRANSPARENT_PNG };
  };

  const filter = { urls: ['<all_urls>'], types: ['image'] };

  // Chrome MV3 requires 'extraHeaders' opt-in to read response headers.
  // Firefox/Safari don't recognize it. Try with extraHeaders first, fall back without.
  try {
    api.webRequest.onHeadersReceived.addListener(
      handler, filter, ['responseHeaders', 'extraHeaders']
    );
  } catch (e) {
    api.webRequest.onHeadersReceived.addListener(
      handler, filter, ['responseHeaders']
    );
  }
}

// Only set up if the API exists
setupWebRequestInterceptor();

// --- Message handling ---
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'imageFrozen') {
    const tabId = sender.tab?.id;
    if (tabId) {
      const count = (frozenCounts.get(tabId) || 0) + 1;
      frozenCounts.set(tabId, count);
      updateBadge(tabId, count);
    }
    return;
  }

  if (msg.type === 'headProbe') {
    // Cross-origin HEAD probe on behalf of a content script.
    // Content-script `fetch` is bound by page CORS, so HEAD requests against
    // CDN-hosted images (e.g. media.newyorker.com/.../undefined animated GIFs
    // delivered without Access-Control-Allow-Origin) reject with TypeError —
    // and Path E ends up marking the image static, leaking the animation.
    // The service worker fetches in the extension's own origin context with
    // the manifest's host_permissions, so it can read response headers for
    // any URL we're authorized for.
    //
    // Defense-in-depth: only allow http(s). A malicious page setting
    // `<img src="javascript:...">` or `<img src="file://...">` would
    // otherwise hand us a privileged fetch we have no business making.
    if (typeof msg.url !== 'string' || !/^https?:\/\//i.test(msg.url)) {
      sendResponse({ ok: false, error: 'invalid url' });
      return true;
    }
    fetch(msg.url, { method: 'HEAD', credentials: 'omit' })
      .then((res) => sendResponse({
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
      }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }

  if (msg.type === 'getState') {
    storageGet(['enabled', 'allowlist']).then((result) => {
      const host = msg.host || '';
      const allowlist = result.allowlist || [];
      sendResponse({
        enabled: result.enabled !== false,
        siteAllowed: allowlist.includes(host),
        frozenCount: frozenCounts.get(msg.tabId) || 0
      });
    });
    return true;
  }

  if (msg.type === 'toggleSite') {
    storageGet(['allowlist']).then((result) => {
      const allowlist = result.allowlist || [];
      const host = msg.host;
      const idx = allowlist.indexOf(host);
      if (idx === -1) {
        allowlist.push(host);
      } else {
        allowlist.splice(idx, 1);
      }
      storageSet({ allowlist }).then(() => {
        notifyContentScript(msg.tabId);
        sendResponse({ allowlist });
      });
    });
    return true;
  }

  if (msg.type === 'toggleEnabled') {
    storageGet(['enabled']).then((result) => {
      const newState = !(result.enabled !== false);
      storageSet({ enabled: newState }).then(() => {
        notifyContentScript(msg.tabId);
        sendResponse({ enabled: newState });
      });
    });
    return true;
  }
});

function notifyContentScript(tabId) {
  if (tabId) {
    safeSendMessage(tabId, { type: 'stateChanged' });
  }
}

function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  if (api.action) {
    try {
      api.action.setBadgeText({ text, tabId });
      api.action.setBadgeBackgroundColor({ color: '#4A90D9', tabId });
    } catch (e) {}
  }
}

// Reset count on navigation
api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    frozenCounts.delete(tabId);
    updateBadge(tabId, 0);
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  frozenCounts.delete(tabId);
});
