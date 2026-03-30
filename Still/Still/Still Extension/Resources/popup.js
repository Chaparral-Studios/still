/* Still — popup script */

const api = typeof browser !== 'undefined' ? browser : chrome;

const globalToggle = document.getElementById('globalToggle');
const siteToggle = document.getElementById('siteToggle');
const siteLabel = document.getElementById('siteLabel');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');

let currentTab = null;
let currentHost = '';

function safeSendMessage(msg) {
  return new Promise((resolve) => {
    try {
      const result = api.runtime.sendMessage(msg, (r) => resolve(r));
      if (result && typeof result.then === 'function') {
        result.then(resolve);
      }
    } catch (e) {
      resolve(null);
    }
  });
}

async function init() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0];

  if (currentTab?.url) {
    try {
      currentHost = new URL(currentTab.url).hostname;
    } catch (e) {
      currentHost = '';
    }
  }

  siteLabel.textContent = currentHost
    ? `Allow on ${currentHost}`
    : 'Allow this site';

  const state = await safeSendMessage(
    { type: 'getState', host: currentHost, tabId: currentTab?.id }
  );
  if (!state) return;

  globalToggle.checked = state.enabled;
  siteToggle.checked = state.siteAllowed;

  if (!state.enabled) {
    statusEl.textContent = 'Disabled globally';
  } else if (state.siteAllowed) {
    statusEl.textContent = 'Animations allowed on this site';
  } else {
    statusEl.textContent = 'Blocking animated images';
  }

  if (state.frozenCount > 0) {
    countEl.textContent = `${state.frozenCount} image${state.frozenCount === 1 ? '' : 's'} blocked on this page`;
  }
}

globalToggle.addEventListener('change', async () => {
  await safeSendMessage({ type: 'toggleEnabled', tabId: currentTab?.id });
  init();
});

siteToggle.addEventListener('change', async () => {
  await safeSendMessage({ type: 'toggleSite', host: currentHost, tabId: currentTab?.id });
  init();
});

init();
