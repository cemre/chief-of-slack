// content.js — thin bridge between inject.js (page context) and side panel (via background.js)
console.log('[fslack] content.js bridge loaded', new Date().toISOString());

const FSLACK = 'fslack';

// Suppress "Could not establish connection" errors from orphaned content scripts
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.message?.includes('Could not establish connection')) {
    e.preventDefault();
  }
});

// ── Inject page-context script ──
try {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
} catch {
  throw new Error('FSlack: extension context invalidated, skipping.');
}

// ── Track inject.js ready state ──
let injectReady = false;
let teamDomain = null;

// ── Hide Slack nav (persistent preference, default on) ──
const _navHideStyle = document.createElement('style');
_navHideStyle.textContent = `
  .p-tab_rail { display: none !important; }
  .p-client_workspace__tabpanel > .enabled-managed-focus-container:first-child {
    visibility: hidden !important;
    width: 0 !important;
    min-width: 0 !important;
    overflow: hidden !important;
  }
  .p-client_workspace__tabpanel { grid-template-columns: 0px auto !important; }
  /* Pull the compose button out of the hidden sidebar */
  button[data-qa="composer_button"] {
    visibility: visible !important;
    position: fixed !important;
    top: 2px !important;
    left: 100px !important;
    z-index: 999 !important;
  }
`;
function hideSlackNav() { if (!_navHideStyle.parentNode) document.head.appendChild(_navHideStyle); }
function showSlackNav() { _navHideStyle.remove(); }

// Apply on load based on stored preference (default: true)
chrome.storage.local.get('fslackHideNav', (r) => {
  if (r.fslackHideNav !== false) hideSlackNav();
});
// Listen for live toggle changes from the side panel
chrome.storage.onChanged.addListener((changes) => {
  if ('fslackHideNav' in changes) {
    changes.fslackHideNav.newValue === false ? showSlackNav() : hideSlackNav();
  }
});

// ── Injected buttons in Slack's top nav ──
function injectNavButtons() {
  if (document.getElementById('fslack-open-btn')) return;

  // Nav toggle button — top left corner (inside the native UI spacer)
  const spacer = document.querySelector('.p-ia4_top_nav__native_ui_spacer');
  if (spacer && !document.getElementById('fslack-nav-toggle')) {
    const toggle = document.createElement('button');
    toggle.id = 'fslack-nav-toggle';
    toggle.title = 'Toggle Slack sidebar';
    function updateToggleLabel(hidden) {
      toggle.textContent = hidden ? '☰ Show Nav' : '☰ Hide Nav';
      toggle.classList.toggle('nav-hidden', hidden);
    }
    chrome.storage.local.get('fslackHideNav', (r) => {
      updateToggleLabel(r.fslackHideNav !== false);
    });
    toggle.addEventListener('click', () => {
      chrome.storage.local.get('fslackHideNav', (r) => {
        const newVal = r.fslackHideNav === false;
        chrome.storage.local.set({ fslackHideNav: newVal });
        updateToggleLabel(newVal);
      });
    });
    spacer.style.display = 'flex';
    spacer.style.alignItems = 'center';
    spacer.style.paddingLeft = '8px';
    spacer.style.boxSizing = 'border-box';
    spacer.appendChild(toggle);
  }

}

// Inject buttons once Slack DOM is ready
const _btnObserver = new MutationObserver(() => {
  if (document.querySelector('.p-ia4_top_nav')) {
    injectNavButtons();
    _btnObserver.disconnect();
  }
});
_btnObserver.observe(document.body, { childList: true, subtree: true });
injectNavButtons();

// Styles for injected buttons
const _flackBtnStyle = document.createElement('style');
_flackBtnStyle.textContent = `
  #fslack-nav-toggle {
    height: 26px;
    padding: 0 8px;
    border: 1.5px solid rgba(0,0,0,0.4);
    border-radius: 6px;
    background: transparent;
    color: rgba(0,0,0,0.6);
    font-size: 12px;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  #fslack-nav-toggle:hover { background: rgba(0,0,0,0.06); }
`;
document.head.appendChild(_flackBtnStyle);


// ── Relay: background.js / side panel → inject.js (page context) ──
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type?.startsWith(`${FSLACK}:`)) return;
  console.log(`[fslack content] received: ${msg.type}`);

  // sidepanelConnected ping: re-emit fslack:ready if inject.js already loaded
  if (msg.type === `${FSLACK}:sidepanelConnected`) {
    if (injectReady) {
      chrome.runtime.sendMessage({ type: `${FSLACK}:ready`, teamDomain }).catch(() => {});
    }
    return;
  }

  // Forward all other fslack:* messages to inject.js via postMessage
  window.postMessage(msg, '*');
});

// ── Relay: inject.js (page context) → background.js → side panel ──
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg?.type?.startsWith(`${FSLACK}:`)) return;

  // Track inject.js ready state
  if (msg.type === `${FSLACK}:ready`) {
    console.log('[fslack content] inject.js ready, teamDomain:', msg.teamDomain);
    injectReady = true;
    if (msg.teamDomain) teamDomain = msg.teamDomain;
  }

  // Forward to background.js (which relays to side panel)
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {}
});
