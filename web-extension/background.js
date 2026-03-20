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

// --- Initialize default state ---
api.runtime.onInstalled.addListener(() => {
  api.storage.local.get(['enabled', 'allowlist'], (result) => {
    if (result.enabled === undefined) {
      api.storage.local.set({ enabled: true });
    }
    if (!result.allowlist) {
      api.storage.local.set({ allowlist: [] });
    }
  });
});

// --- webRequest: intercept Content-Type headers (Chrome/Firefox) ---
// Safari MV3 does not support webRequest, so this is a progressive
// enhancement. The content script's frame-comparison probing is the
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
    // freeze immediately instead of waiting for the frame-comparison probe
    if (tabId > 0) {
      api.tabs.sendMessage(tabId, {
        type: 'animatedURL',
        url: details.url
      }).catch(() => {});
    }

    // On Firefox (MV3 supports blocking webRequest), redirect to
    // transparent PNG to prevent animated bytes from rendering.
    // On Chrome MV3 this return value is silently ignored — the
    // content script's preemptive-hide + freeze handles it instead.
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

  if (msg.type === 'getState') {
    api.storage.local.get(['enabled', 'allowlist'], (result) => {
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
    api.storage.local.get(['allowlist'], (result) => {
      const allowlist = result.allowlist || [];
      const host = msg.host;
      const idx = allowlist.indexOf(host);
      if (idx === -1) {
        allowlist.push(host);
      } else {
        allowlist.splice(idx, 1);
      }
      api.storage.local.set({ allowlist }, () => {
        notifyContentScript(msg.tabId);
        sendResponse({ allowlist });
      });
    });
    return true;
  }

  if (msg.type === 'toggleEnabled') {
    api.storage.local.get(['enabled'], (result) => {
      const newState = !(result.enabled !== false);
      api.storage.local.set({ enabled: newState }, () => {
        notifyContentScript(msg.tabId);
        sendResponse({ enabled: newState });
      });
    });
    return true;
  }
});

function notifyContentScript(tabId) {
  if (tabId) {
    api.tabs.sendMessage(tabId, { type: 'stateChanged' }).catch(() => {});
  }
}

function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  if (api.action) {
    api.action.setBadgeText({ text, tabId });
    api.action.setBadgeBackgroundColor({ color: '#4A90D9', tabId });
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
