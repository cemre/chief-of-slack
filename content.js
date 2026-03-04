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
  .p-client_workspace__tabpanel > .enabled-managed-focus-container:first-child { display: none !important; }
  .p-client_workspace__tabpanel { grid-template-columns: 0px auto !important; }
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

// ── "Open Flack" button in Slack's top nav ──
function injectFlackButton() {
  if (document.getElementById('fslack-open-btn')) return;
  // Slack's top-right nav area
  const topNav = document.querySelector('.p-ia4_top_nav__right_container')
    || document.querySelector('.p-ia4_top_nav');
  if (!topNav) return;
  const btn = document.createElement('button');
  btn.id = 'fslack-open-btn';
  btn.textContent = 'Flack';
  btn.title = 'Open Flack (⌘⇧F)';
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: `${FSLACK}:openPanel` }).catch(() => {});
  });
  // Insert before first child to put it on the left side of the right container
  if (topNav.classList.contains('p-ia4_top_nav__right_container')) {
    topNav.insertBefore(btn, topNav.firstChild);
  } else {
    topNav.appendChild(btn);
  }
}

// Inject button once Slack DOM is ready
const _btnObserver = new MutationObserver(() => {
  if (document.querySelector('.p-ia4_top_nav')) {
    injectFlackButton();
    _btnObserver.disconnect();
  }
});
_btnObserver.observe(document.body, { childList: true, subtree: true });
// Also try immediately in case DOM is already ready
injectFlackButton();

// Style for the button
const _flackBtnStyle = document.createElement('style');
_flackBtnStyle.textContent = `
  #fslack-open-btn {
    height: 26px;
    padding: 0 8px;
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: 6px;
    background: rgba(255,255,255,0.1);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    cursor: pointer;
    margin-right: 4px;
  }
  #fslack-open-btn:hover { background: rgba(255,255,255,0.2); }
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
