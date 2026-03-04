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

// ── Relay: background.js / side panel → inject.js (page context) ──
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type?.startsWith(`${FSLACK}:`)) return;

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
    injectReady = true;
    if (msg.teamDomain) teamDomain = msg.teamDomain;
  }

  // Forward to background.js (which relays to side panel)
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {}
});
