/* Still — popup script */

const api = typeof browser !== 'undefined' ? browser : chrome;

const globalToggle = document.getElementById('globalToggle');
const siteToggle = document.getElementById('siteToggle');
const siteLabel = document.getElementById('siteLabel');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');

let currentTab = null;
let currentHost = '';

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

  api.runtime.sendMessage(
    { type: 'getState', host: currentHost, tabId: currentTab?.id },
    (state) => {
      if (!state) return;

      globalToggle.checked = state.enabled;
      siteToggle.checked = state.siteAllowed;

      if (!state.enabled) {
        statusEl.textContent = 'Disabled globally';
      } else if (state.siteAllowed) {
        statusEl.textContent = 'Animations allowed on this site';
      } else {
        statusEl.textContent = 'Freezing animated images';
      }

      if (state.frozenCount > 0) {
        countEl.textContent = `${state.frozenCount} image${state.frozenCount === 1 ? '' : 's'} frozen on this page`;
      }
    }
  );
}

globalToggle.addEventListener('change', () => {
  api.runtime.sendMessage(
    { type: 'toggleEnabled', tabId: currentTab?.id },
    () => init()
  );
});

siteToggle.addEventListener('change', () => {
  api.runtime.sendMessage(
    { type: 'toggleSite', host: currentHost, tabId: currentTab?.id },
    () => init()
  );
});

init();
