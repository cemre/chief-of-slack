// content.js — overlay UI on top of Slack + bridge to inject.js + LLM prioritization
console.log('[fslack] content.js loaded', new Date().toISOString());

const FSLACK = 'fslack';
const VIPS = ['josh', 'tara', 'dustin', 'brahm', 'rosey', 'samir', 'jane'];
const SEEN_REPLIES_CHUNK = 10;
const RESERVED_MENTIONS = new Set(['here', 'channel', 'everyone']);


// Suppress "Could not establish connection" errors from orphaned content scripts
// after extension reload. These are unhandled promise rejections from Chrome internals.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.message?.includes('Could not establish connection')) {
    e.preventDefault();
  }
});

// Clean up any previous FSlack overlay (e.g. after extension reload)
document.getElementById('fslack-host')?.remove();

// ── Inject page-context script ──
try {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
} catch {
  // Extension context invalidated — bail silently
  throw new Error('FSlack: extension context invalidated, skipping.');
}

// ── Create overlay with shadow DOM ──
const host = document.createElement('div');
host.id = 'fslack-host';
document.body.appendChild(host);
const shadow = host.attachShadow({ mode: 'closed' });

shadow.innerHTML = `
<style id="fslack-style"></style>
<div id="overlay">
  <div id="resize-handle"></div>
  <header>
    <button id="close-btn">Close Flack</button>
    <span class="last-updated-wrap">
      <span id="last-updated" class="last-updated"></span>
      <span id="refresh-link" class="refresh-link">refresh</span>
    </span>
  </header>
  <div id="body">
    <div id="status">Starting fetch...</div>
  </div>
</div>
<div id="lightbox">
  <div class="lb-backdrop"></div>
  <button class="lb-close">&times;</button>
  <div class="lb-counter"></div>
  <button class="lb-arrow prev">&#8249;</button>
  <button class="lb-arrow next">&#8250;</button>
  <div class="lb-media"></div>
</div>
`;

// Load CSS into shadow DOM
fetch(chrome.runtime.getURL('content.css'))
  .then(r => r.text())
  .then(css => { shadow.getElementById('fslack-style').textContent = css; })
  .catch(e => console.warn('[fslack] failed to load CSS:', e));

const overlay = shadow.getElementById('overlay');
const bodyEl = shadow.getElementById('body');
const fetchBtn = { disabled: false, textContent: '', addEventListener() {} };
const lastUpdatedEl = shadow.getElementById('last-updated');
let lastFetchTime = null;
let lastUpdatedTimer = null;

function updateLastUpdated() {
  if (!lastFetchTime) return;
  const secs = Math.floor((Date.now() - lastFetchTime) / 1000);
  if (secs < 60) lastUpdatedEl.textContent = `${secs}s ago`;
  else lastUpdatedEl.textContent = `${Math.floor(secs / 60)}m ago`;
  lastUpdatedEl.classList.toggle('stale', secs >= 300);
}

// ── Lightbox ──
const lightbox = shadow.getElementById('lightbox');
const lbMedia = lightbox.querySelector('.lb-media');
const lbCounter = lightbox.querySelector('.lb-counter');
let lbItems = []; // [{ url, type:'image'|'video' }]
let lbIndex = 0;

function lbShow(items, index) {
  lbItems = items;
  lbIndex = index;
  lbRender();
  lightbox.classList.add('open');
  document.addEventListener('keydown', lbKeyHandler, true);
}

function lbClose() {
  lightbox.classList.remove('open');
  const vid = lbMedia.querySelector('video');
  if (vid) vid.pause();
  lbMedia.innerHTML = '';
  lbItems = [];
  document.removeEventListener('keydown', lbKeyHandler, true);
}

function lbRender() {
  const vid = lbMedia.querySelector('video');
  if (vid) vid.pause();
  const item = lbItems[lbIndex];
  if (!item) return;
  if (item.type === 'video') {
    lbMedia.innerHTML = `<video src="${escapeHtml(item.url)}" controls autoplay playsinline></video>`;
  } else {
    lbMedia.innerHTML = `<img src="${escapeHtml(item.url)}">`;
  }
  lbCounter.textContent = lbItems.length > 1 ? `${lbIndex + 1} / ${lbItems.length}` : '';
  lightbox.querySelector('.lb-arrow.prev').style.display = lbItems.length > 1 ? '' : 'none';
  lightbox.querySelector('.lb-arrow.next').style.display = lbItems.length > 1 ? '' : 'none';
}

function lbNav(dir) {
  if (lbItems.length < 2) return;
  lbIndex = (lbIndex + dir + lbItems.length) % lbItems.length;
  lbRender();
}

function lbKeyHandler(e) {
  if (e.key === 'Escape') { e.stopPropagation(); lbClose(); }
  else if (e.key === 'ArrowLeft') { e.stopPropagation(); lbNav(-1); }
  else if (e.key === 'ArrowRight') { e.stopPropagation(); lbNav(1); }
  else if (e.key === ' ') {
    const vid = lbMedia.querySelector('video');
    if (vid) { e.preventDefault(); e.stopPropagation(); vid.paused ? vid.play() : vid.pause(); }
  }
}

lightbox.querySelector('.lb-backdrop').addEventListener('click', lbClose);
lightbox.querySelector('.lb-close').addEventListener('click', lbClose);
lightbox.querySelector('.lb-arrow.prev').addEventListener('click', () => lbNav(-1));
lightbox.querySelector('.lb-arrow.next').addEventListener('click', () => lbNav(1));

const closeBtn = shadow.getElementById('close-btn');
shadow.getElementById('refresh-link').addEventListener('click', startFetch);

// ── Resize handle ──
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 800;
const DEFAULT_SIDEBAR_WIDTH = 480;
const resizeHandle = shadow.getElementById('resize-handle');

chrome.storage.local.get('fslackSidebarWidth', (result) => {
  const w = result.fslackSidebarWidth || DEFAULT_SIDEBAR_WIDTH;
  overlay.style.width = w + 'px';
});

resizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = overlay.getBoundingClientRect().width;
  resizeHandle.classList.add('dragging');

  function onMove(ev) {
    const delta = ev.clientX - startX;
    const newW = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startW + delta));
    overlay.style.width = newW + 'px';
    syncSlackSidebar();
  }
  function onUp() {
    resizeHandle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const finalW = Math.round(overlay.getBoundingClientRect().width);
    chrome.storage.local.set({ fslackSidebarWidth: finalW });
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ── Inject page-level style for shifting Slack overlays (search typeahead etc.) ──
const _fslackPageStyle = document.createElement('style');
_fslackPageStyle.id = 'fslack-page-overrides';
_fslackPageStyle.textContent = `
  html.fslack-open .p-ia4_top_nav {
    padding-left: var(--fslack-w, 0px);
  }
  html.fslack-open .c-search_modal {
    padding-left: var(--fslack-w, 0px);
  }
  #fslack-open-btn {
    position: fixed;
    top: 8px;
    left: 8px;
    z-index: 999998;
    height: 26px;
    padding: 0 8px;
    border: 1px solid rgba(0,0,0,0.15);
    border-radius: 5px;
    background: rgba(0,0,0,0.06);
    color: #1d1c1d;
    font-size: 12px;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    cursor: pointer;
    display: none;
    align-items: center;
  }
  #fslack-open-btn:hover { background: rgba(0,0,0,0.12); }
  #fslack-open-btn.visible { display: inline-flex; }
`;
document.head.appendChild(_fslackPageStyle);

// ── "Open Flack" button in real DOM ──
document.getElementById('fslack-open-btn')?.remove();
const openBtn = document.createElement('button');
openBtn.id = 'fslack-open-btn';
openBtn.textContent = 'Open Flack';
document.body.appendChild(openBtn);
openBtn.addEventListener('click', () => show());

// ── Sync Slack's sidebar width to match Flack ──
let _origTabpanelGrid = null;
let _tabpanelObserver = null;

function syncSlackSidebar() {
  // Always set the CSS class/variable for page-level overrides (search typeahead etc.)
  // even if Slack's DOM isn't ready yet (e.g. initial page load with ?fslack)
  const flackW = overlay.getBoundingClientRect().width;
  document.documentElement.classList.add('fslack-open');
  document.documentElement.style.setProperty('--fslack-w', flackW + 'px');

  const tabpanel = document.querySelector('.p-client_workspace__tabpanel');
  if (!tabpanel) {
    // Slack DOM not ready yet — watch for it to appear, then re-sync
    if (!_tabpanelObserver) {
      _tabpanelObserver = new MutationObserver(() => {
        if (document.querySelector('.p-client_workspace__tabpanel')) {
          _tabpanelObserver.disconnect();
          _tabpanelObserver = null;
          if (visible) syncSlackSidebar();
        }
      });
      _tabpanelObserver.observe(document.body, { childList: true, subtree: true });
    }
    return;
  }
  // Save original grid so we can restore on hide
  if (!_origTabpanelGrid) _origTabpanelGrid = tabpanel.style.gridTemplateColumns || '';
  const tabRail = document.querySelector('.p-tab_rail');
  const railW = tabRail ? tabRail.getBoundingClientRect().width : 70;
  const sidebarW = Math.max(0, flackW - railW);
  tabpanel.style.gridTemplateColumns = `${sidebarW}px minmax(0, 1fr)`;
}

function restoreSlackSidebar() {
  if (_tabpanelObserver) { _tabpanelObserver.disconnect(); _tabpanelObserver = null; }
  document.documentElement.classList.remove('fslack-open');
  const tabpanel = document.querySelector('.p-client_workspace__tabpanel');
  if (!tabpanel) return;
  tabpanel.style.gridTemplateColumns = _origTabpanelGrid || '';
  _origTabpanelGrid = null;
}

// ── In-place Slack navigation ──
function navigateSlack(channel, ts) {
  window.postMessage({ type: `${FSLACK}:navigate`, channel, ts }, '*');
}

// ── Toggle overlay ──
let visible = false;
let injectReady = false;
let cachedView = null; // { data, popular, prioritized, ts }
let persistedFetchTs = 0; // lightweight timestamp that always persists to storage
let noiseChannels = {};      // { [channelId]: channelName } — always force to noise
let neverNoiseChannels = {}; // { [channelId]: channelName } — always force to whenFree
let digestChannels = {};     // { [channelId]: channelName } — always force to digest section
let savedMsgKeys = new Set(); // Set of "channel:ts" strings for saved messages
let myReactionsMap = {};     // { "channel:ts": ["+1", "yellow_heart", ...] }
let vipSeenTimestamps = {};   // { [vipName]: latestSeenTs } — messages at or before this ts are hidden
let customEmojiMap = null;
let standardEmojiMap = null;
let channelNameMap = {};
let cachedUserMap = {};
let cachedUserMentionHints = {};
let reactionRequestCounter = 0;
const pendingReactButtons = {};
const pendingUnreactButtons = {};
let focusedItemIndex = -1;  // keyboard nav: index into visible items, -1 = none
let dmWatchTimer = null;         // interval ID for new-DM polling
let knownDmChannelIds = new Set(); // DM channels already in the current render
let mutedThreadKeys = new Set();   // Set of "channel:threadTs" strings for muted threads

// Preload custom emoji + channel names from cache for instant render on showFromCache()
chrome.storage.local.get(['fslackEmoji', 'fslackEmojiTs', 'fslackChannels', 'fslackUsers', 'fslackUserMentionHints'], (cached) => {
  const EMOJI_TTL_MS = 24 * 60 * 60 * 1000;
  if (cached.fslackEmoji && cached.fslackEmojiTs && Date.now() - cached.fslackEmojiTs < EMOJI_TTL_MS) {
    customEmojiMap = cached.fslackEmoji;
  }
  if (cached.fslackChannels) channelNameMap = cached.fslackChannels;
  if (cached.fslackUsers) mergeCachedUsers(cached.fslackUsers);
  if (cached.fslackUserMentionHints) mergeCachedMentionHints(cached.fslackUserMentionHints, { replace: true });
});

// Load standard emoji map (bundled JSON) async
fetch(chrome.runtime.getURL('standard-emoji.json'))
  .then(r => r.json())
  .then(map => { standardEmojiMap = map; })
  .catch(e => console.warn('[fslack] failed to load standard emoji:', e));

function saveViewCache(data, popular, prioritized, savedItems = []) {
  cachedView = { data, popular, prioritized, saved: savedItems, ts: Date.now() };
  chrome.storage.local.set({ fslackLastFetchTs: cachedView.ts, fslackViewCache: cachedView }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[fslack] cache persist failed:', chrome.runtime.lastError.message);
      chrome.storage.local.set({ fslackLastFetchTs: cachedView.ts });
    }
  });
  startDmWatcher(data);
}

function removeCachedItem(channel, threadTs) {
  if (!cachedView) return;
  const keep = threadTs
    ? (item) => !(item.channel_id === channel && item.ts === threadTs)
    : (item) => item.channel_id !== channel;
  const p = cachedView.prioritized;
  cachedView.prioritized = {
    actNow: p.actNow.filter(keep),
    priority: p.priority.filter(keep),
    whenFree: p.whenFree.filter(keep),
    noise: p.noise.filter(keep),
    digests: (p.digests || []).filter(keep),
  };
  chrome.storage.local.set({ fslackViewCache: cachedView });
}

function threadKey(channel, threadTs) {
  return channel && threadTs ? `${channel}:${threadTs}` : null;
}

function persistMutedThreads() {
  chrome.storage.local.set({ fslackMutedThreads: Array.from(mutedThreadKeys) });
}

function muteThreadLocally(channel, threadTs) {
  const key = threadKey(channel, threadTs);
  if (!key) return;
  if (!mutedThreadKeys.has(key)) {
    mutedThreadKeys.add(key);
    persistMutedThreads();
  }
  removeCachedItem(channel, threadTs);
}

function startFetch() {
  if (fetchBtn.disabled) return;
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Fetching...';
  bodyEl.innerHTML = '<div id="status">Starting fetch...</div>';
  resetFetchState();
  // Load cached names and pass to inject.js
  chrome.storage.local.get(['fslackUsers', 'fslackUserMentionHints', 'fslackChannels', 'fslackChannelMeta', 'fslackNoiseChannels', 'fslackNeverNoiseChannels', 'fslackDigestChannels', 'fslackSavedMsgs', 'fslackEmoji', 'fslackEmojiTs', 'fslackVipSeen', 'fslackMutedThreads'], (cached) => {
    noiseChannels = cached.fslackNoiseChannels || {};
    neverNoiseChannels = cached.fslackNeverNoiseChannels || {};
    digestChannels = cached.fslackDigestChannels || {};
    savedMsgKeys = new Set(cached.fslackSavedMsgs || []);
    vipSeenTimestamps = cached.fslackVipSeen || {};
    mutedThreadKeys = new Set(cached.fslackMutedThreads || []);
    mergeCachedUsers(cached.fslackUsers || {});
    mergeCachedMentionHints(cached.fslackUserMentionHints || {}, { replace: true });
    const EMOJI_TTL_MS = 24 * 60 * 60 * 1000;
    const cachedEmoji = (cached.fslackEmojiTs && Date.now() - cached.fslackEmojiTs < EMOJI_TTL_MS)
      ? (cached.fslackEmoji || {}) : null;
    window.postMessage({
      type: `${FSLACK}:fetch`,
      cachedUsers: cached.fslackUsers || {},
      cachedUserMentionHints: cached.fslackUserMentionHints || {},
      cachedChannels: cached.fslackChannels || {},
      cachedChannelMeta: cached.fslackChannelMeta || {},
      cachedEmoji,
    }, '*');
  });
  window.postMessage({ type: `${FSLACK}:fetchPopular` }, '*');
  window.postMessage({ type: `${FSLACK}:fetchSaved`, requestId: `saved_${Date.now()}` }, '*');
}

function showFromCache() {
  // Full cache available and fresh — render it
  if (cachedView && Date.now() - cachedView.ts < 300000) {
    lastFetchTime = cachedView.ts;
    updateLastUpdated();
    if (lastUpdatedTimer) clearInterval(lastUpdatedTimer);
    lastUpdatedTimer = setInterval(updateLastUpdated, 1000);
    renderPrioritized(cachedView.prioritized, cachedView.data, cachedView.popular, false, false, cachedView.saved || []);
    runBotThreadSummarization(cachedView.prioritized.whenFree || [], cachedView.data);
    const allElevatedCache = [...(cachedView.prioritized.actNow || []), ...(cachedView.prioritized.priority || []), ...(cachedView.prioritized.whenFree || [])];
    runThreadReplySummarization(allElevatedCache, cachedView.data);
    runChannelThreadSummarization(allElevatedCache, cachedView.data);
    startDmWatcher(cachedView.data);
    return true;
  }
  // No full cache, but we fetched recently — skip auto-fetch
  if (persistedFetchTs && Date.now() - persistedFetchTs < 300000) {
    lastFetchTime = persistedFetchTs;
    updateLastUpdated();
    if (lastUpdatedTimer) clearInterval(lastUpdatedTimer);
    lastUpdatedTimer = setInterval(updateLastUpdated, 1000);
    const ago = Math.floor((Date.now() - persistedFetchTs) / 60000);
    bodyEl.innerHTML = `<div id="status">Last fetched ${ago < 1 ? 'just now' : ago + 'm ago'}. Click Fetch to refresh.</div>`;
    return true;
  }
  return false;
}

function show() {
  visible = true;
  overlay.classList.add('visible');
  openBtn.classList.remove('visible');
  syncSlackSidebar();
  if (showFromCache()) return;
  if (injectReady) startFetch();
}
function hide() {
  visible = false;
  overlay.classList.remove('visible');
  openBtn.classList.add('visible');
  restoreSlackSidebar();
  stopDmWatcher();
}
function toggle() { visible ? hide() : show(); }

// Expose toggle on the host element so background.js executeScript can call it
host.__fslackToggle = toggle;

closeBtn.addEventListener('click', hide);

// Toggle with keyboard: Ctrl+Shift+F / Cmd+Shift+F
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
    e.preventDefault();
    e.stopPropagation();
    visible ? hide() : show();
  }
  // Toggle with Cmd+Escape: dismiss fslack, or reopen from normal Slack
  if (e.key === 'Escape' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (!visible) {
      e.preventDefault();
      e.stopPropagation();
      show();
    } else if (document.activeElement !== host && !lightbox.classList.contains('open') && focusedItemIndex < 0) {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  }
}, true);

// ── Keyboard navigation ──
// Navigate message-by-message (msg-row). Items without visible msg-rows
// (deep summaries, bot thread summaries) are navigated as whole items.
// Section toggles (collapsed headers) are also navigable so you can
// arrow into them and press Enter to expand.
function getNavigableElements() {
  const result = [];
  // Collect .item and .section-toggle elements in DOM order
  const nodes = [...bodyEl.querySelectorAll('.item, .section-toggle')].filter(el => el.offsetHeight > 0);
  for (const node of nodes) {
    if (node.classList.contains('section-toggle')) {
      result.push(node);
    } else {
      const rows = [...node.querySelectorAll('.msg-row')].filter(row => row.offsetHeight > 0);
      if (rows.length > 0) {
        result.push(...rows);
      } else {
        result.push(node);
      }
    }
  }
  return result;
}


function isTextExpanded(scopeEl) {
  if (!scopeEl) return false;
  // Check if any truncated text block within scope is in expanded state
  // The short span is hidden when expanded; the full span is shown
  const shortSpan = scopeEl.querySelector('[id$="-short"]');
  return shortSpan ? shortSpan.style.display === 'none' : false;
}

function findThreadContainer(channel, ts, containerId) {
  if (containerId) {
    const el = bodyEl.querySelector(`.thread-replies-container[data-container-id="${containerId}"]`);
    if (el) return el;
  }
  return bodyEl.querySelector(`.thread-replies-container[data-channel="${channel}"][data-ts="${ts}"]`);
}

function updateThreadBadgeLabel(badge, count, expanded) {
  const timeHtml = badge.dataset.time ? `<span class="msg-time">${escapeHtml(badge.dataset.time)}</span>` : '';
  const isNewer = badge.dataset.mode === 'newer';
  if (isNewer) {
    if (count === 0) {
      badge.innerHTML = `${THREAD_BADGE_ICON}No newer replies${timeHtml}`;
      return;
    }
    badge.innerHTML = expanded
      ? `${THREAD_BADGE_ICON}Hide ${count} newer ${count === 1 ? 'reply' : 'replies'}${timeHtml}`
      : `${THREAD_BADGE_ICON}View ${count} newer ${count === 1 ? 'reply' : 'replies'}${timeHtml}`;
    return;
  }
  if (count === 0) {
    badge.innerHTML = `${THREAD_BADGE_ICON}No replies${timeHtml}`;
    return;
  }
  badge.innerHTML = expanded
    ? `${THREAD_BADGE_ICON}Hide ${count} ${count === 1 ? 'reply' : 'replies'}${timeHtml}`
    : `${THREAD_BADGE_ICON}${count} ${count === 1 ? 'reply' : 'replies'}${timeHtml}`;
}

function isThreadExpanded(scopeEl) {
  if (!scopeEl) return false;
  const badge = scopeEl.querySelector('.msg-thread-badge.expanded');
  if (!badge) return false;
  // Badge keeps .expanded after first load, but container display is toggled
  const { channel, ts } = badge.dataset;
  if (!channel || !ts) return false;
  const container = findThreadContainer(channel, ts, badge.dataset.containerId);
  return container ? container.style.display !== 'none' : false;
}

function focusItem(index) {
  const els = getNavigableElements();
  if (els.length === 0) return;
  index = Math.max(0, Math.min(els.length - 1, index));
  const oldFocused = bodyEl.querySelector('.kb-focused');
  if (oldFocused) oldFocused.classList.remove('kb-focused');

  const el = els[index];
  el.classList.add('kb-focused');
  focusedItemIndex = index;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function unfocusItem() {
  const oldFocused = bodyEl.querySelector('.kb-focused');
  if (oldFocused) oldFocused.classList.remove('kb-focused');
  focusedItemIndex = -1;
}

document.addEventListener('keydown', (e) => {
  if (!visible) return;
  if (lightbox.classList.contains('open')) return;
  if (document.activeElement === host) return;  // typing in input inside shadow
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const key = e.key;

  if (key === 'j' || key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    focusItem(focusedItemIndex + 1);
    return;
  }
  if (key === 'k' || key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    focusItem(Math.max(0, focusedItemIndex - 1));
    return;
  }
  if (key === 'Escape') {
    if (focusedItemIndex >= 0) {
      e.preventDefault();
      e.stopPropagation();
      unfocusItem();
    }
    return;
  }

  // Enter: toggle section toggles
  if (key === 'Enter') {
    if (focusedItemIndex < 0) return;
    const focused = bodyEl.querySelector('.kb-focused');
    if (!focused || !focused.classList.contains('section-toggle')) return;
    e.preventDefault(); e.stopPropagation();
    focused.click();
    // Re-focus: find the toggle's new index (may shift after items expand/collapse)
    requestAnimationFrame(() => {
      const els = getNavigableElements();
      const newIdx = els.indexOf(focused);
      if (newIdx >= 0) focusItem(newIdx);
    });
    return;
  }

  // Arrow left/right: collapse/expand (no focus required beyond having a focused item)
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    if (focusedItemIndex < 0) return;
    const focused = bodyEl.querySelector('.kb-focused');
    if (!focused) return;
    // Section toggles: right=expand, left=collapse
    if (focused.classList.contains('section-toggle')) {
      e.preventDefault(); e.stopPropagation();
      const items = focused.nextElementSibling;
      const isVip = focused.id === 'vip-toggle';
      const isExpanded = isVip ? (items && items.style.display !== 'none') : (items && items.classList.contains('expanded'));
      if (key === 'ArrowRight' && !isExpanded) focused.click();
      if (key === 'ArrowLeft' && isExpanded) focused.click();
      return;
    }
    const isRow = focused.classList.contains('msg-row');
    const parentItem = isRow ? focused.closest('.item') : focused;
    const scope = isRow ? focused : focused;
    const showMsgsLink = (isRow ? focused : parentItem)?.querySelector('.show-messages-link[data-target]');
    const showMsgsTarget = showMsgsLink ? shadow.getElementById(showMsgsLink.dataset.target) : null;
    const isExpanded = isThreadExpanded(scope) || isTextExpanded(scope) || (showMsgsTarget && showMsgsTarget.style.display === 'block');
    if (key === 'ArrowRight' && !isExpanded) {
      e.preventDefault(); e.stopPropagation();
      const threadBadge = scope?.querySelector('.msg-thread-badge:not(.loading)');
      if (threadBadge) {
        threadBadge.click();
      } else {
        const seeMore = scope?.querySelector('.see-more:not([style*="display:none"])');
        if (seeMore) seeMore.click();
      }
      if (showMsgsLink && showMsgsTarget && showMsgsTarget.style.display !== 'block') showMsgsLink.click();
    } else if (key === 'ArrowLeft' && isExpanded) {
      e.preventDefault(); e.stopPropagation();
      const seeLess = scope?.querySelector('.see-less');
      if (seeLess) {
        seeLess.click();
      } else {
        const threadBadge = scope?.querySelector('.msg-thread-badge.expanded');
        if (threadBadge) threadBadge.click();
      }
      if (showMsgsTarget && showMsgsTarget.style.display === 'block') showMsgsLink.click();
    } else if (key === 'ArrowLeft' && !isExpanded && isRow) {
      const threadContainer = focused.closest('.thread-replies-container');
      if (threadContainer) {
        e.preventDefault(); e.stopPropagation();
        const { channel, ts } = threadContainer.dataset;
        if (channel && ts) {
          const parentBadge = bodyEl.querySelector(`.msg-thread-badge.expanded[data-channel="${channel}"][data-ts="${ts}"]`);
          if (parentBadge) {
            parentBadge.click();
            requestAnimationFrame(() => {
              const parentRow = parentBadge.closest('.msg-row');
              if (parentRow) {
                const els = getNavigableElements();
                const newIdx = els.indexOf(parentRow);
                if (newIdx >= 0) focusItem(newIdx);
              }
            });
          }
        }
      }
    }
    return;
  }

  // Action keys require a focused element
  if (focusedItemIndex < 0) return;
  const focused = bodyEl.querySelector('.kb-focused');
  if (!focused) return;
  // Section toggles: only 'e' to toggle expand/collapse
  if (focused.classList.contains('section-toggle')) {
    if (key.toLowerCase() === 'e') { e.preventDefault(); e.stopPropagation(); focused.click(); }
    return;
  }

  const k = key.toLowerCase();
  if (k.length !== 1) return;

  const isRow = focused.classList.contains('msg-row');
  const parentItem = isRow ? focused.closest('.item') : focused;

  // Message-level actions (only when a msg-row is focused, not on VIP items)
  const isVip = !!parentItem?.classList.contains('vip-item');
  if (isRow && !isVip && 'lhsr'.includes(k)) {
    e.preventDefault(); e.stopPropagation();
    if (k === 'l') focused.querySelector('.action-react[data-emoji="+1"]')?.click();
    else if (k === 'h') focused.querySelector('.action-react[data-emoji="yellow_heart"]')?.click();
    else if (k === 's') focused.querySelector('.action-save')?.click();
    else if (k === 'r') (focused.querySelector('.action-msg-reply') || parentItem?.querySelector('.action-reply'))?.click();
    return;
  }

  // Expand / Collapse toggle — scope to focused row when applicable
  if (k === 'e') {
    e.preventDefault(); e.stopPropagation();
    const scope = isRow ? focused : parentItem;
    const showMsgsLink = (isRow ? focused : parentItem)?.querySelector('.show-messages-link[data-target]');
    const showMsgsTarget = showMsgsLink ? shadow.getElementById(showMsgsLink.dataset.target) : null;
    const expanded = isThreadExpanded(scope) || isTextExpanded(scope) || (showMsgsTarget && showMsgsTarget.style.display === 'block');
    if (expanded) {
      // Collapse — thread badge, see-less, or show-messages-link
      const threadBadge = scope?.querySelector('.msg-thread-badge.expanded');
      if (threadBadge) {
        threadBadge.click();
      } else {
        const seeLess = scope?.querySelector('.see-less');
        if (seeLess) seeLess.click();
      }
      if (showMsgsTarget && showMsgsTarget.style.display === 'block') showMsgsLink.click();
    } else {
      // Expand — thread badge (not yet loaded, or loaded but collapsed), see-more, or show-messages-link
      const threadBadge = scope?.querySelector('.msg-thread-badge:not(.loading)');
      if (threadBadge) {
        threadBadge.click();
      } else {
        const seeMore = scope?.querySelector('.see-more:not([style*="display:none"])');
        if (seeMore) seeMore.click();
      }
      if (showMsgsLink && showMsgsTarget && showMsgsTarget.style.display !== 'block') showMsgsLink.click();
    }
    return;
  }

  // Item-level actions (work for both msg-rows and summary items)
  if ('mto'.includes(k)) {
    e.preventDefault(); e.stopPropagation();
    if (k === 'm') (parentItem?.querySelector('.mark-all-read') || parentItem?.querySelector('.vip-mark-seen'))?.click();
    else if (k === 't' && !isVip) (parentItem?.querySelector('.action-mute') || parentItem?.querySelector('.action-mute-channel'))?.click();
    else if (k === 'o' && !parentItem?.classList.contains('vip-item')) parentItem?.querySelector('.item-channel[data-channel]')?.click();
    return;
  }
}, true);

// ── Render helpers ──
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(parseFloat(ts) * 1000);
  const diffMs = Date.now() - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

function formatTimeTooltip(ts) {
  if (!ts) return '';
  const d = new Date(parseFloat(ts) * 1000);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  if (diffMs < 7 * 86400000) {
    return `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  }
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeSlackEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

let truncateId = 0;

function cleanSlackText(text, users) {
  if (!text) return '';
  text = decodeSlackEntities(text);
  text = text.replace(/<@(U[A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, displayName) => `@${displayName || users?.[id] || id}`);
  text = text.replace(/<#(C[A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `#${label || channelNameMap?.[id] || id}`);
  text = text.replace(/<([^|>]+)\|([^>]+)>/g, (_, _url, label) => label);
  text = text.replace(/<([^>]+)>/g, (_, url) => url);
  return text;
}

function applyMrkdwn(html) {
  // Bold: *text* (skip inside HTML tags)
  html = html.replace(/(<[^>]*>)|\*([^*\n]+)\*/g, (match, tag, text) => {
    if (tag) return tag;
    return `<strong>${text}</strong>`;
  });
  // Italic: _text_ but not inside snake_case (lookbehind/ahead for word chars)
  html = html.replace(/(<[^>]*>)|(?<![a-zA-Z0-9])_([^_\n]+)_(?![a-zA-Z0-9])/g, (match, tag, text) => {
    if (tag) return tag;
    return `<em>${text}</em>`;
  });
  // Strikethrough: ~text~
  html = html.replace(/(<[^>]*>)|~([^~\n]+)~/g, (match, tag, text) => {
    if (tag) return tag;
    return `<s>${text}</s>`;
  });
  return html;
}

function applyBlockFormatting(html) {
  const lines = html.split('\n');
  const out = [];
  let inUl = false, inOl = false;
  for (const line of lines) {
    // Skip lines inside pre blocks — they preserve whitespace natively
    if (line.includes('<pre>')) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      out.push(line);
      continue;
    }
    // Blockquote: &gt; text
    const quoteMatch = line.match(/^&gt;\s?(.*)/);
    if (quoteMatch) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      out.push(`<blockquote class="slack-quote">${quoteMatch[1]}</blockquote>`);
      continue;
    }
    // Unordered list: • or ◦
    const ulMatch = line.match(/^[•◦]\s+(.*)/);
    if (ulMatch) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul class="slack-list">'); inUl = true; }
      out.push(`<li>${ulMatch[1]}</li>`);
      continue;
    }
    // Ordered list: digit.
    const olMatch = line.match(/^\d+\.\s+(.*)/);
    if (olMatch) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol class="slack-list">'); inOl = true; }
      out.push(`<li>${olMatch[1]}</li>`);
      continue;
    }
    // Close any open lists
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
    out.push(line);
  }
  if (inUl) out.push('</ul>');
  if (inOl) out.push('</ol>');
  return out.join('<br>').replace(/<br>(<\/?(?:ul|ol|li|blockquote)[^>]*>)/g, '$1').replace(/(<\/?(?:ul|ol|li|blockquote)[^>]*>)<br>/g, '$1');
}

function formatSlackHtml(text, users, { collapseNewlines = false } = {}) {
  if (!text) return '';

  // 1. Extract code blocks (```...```) → placeholders
  const placeholders = [];
  function ph(content) {
    const i = placeholders.length;
    placeholders.push(content);
    return `\x00PH${i}\x00`;
  }
  text = text.replace(/```([\s\S]*?)```/g, (_, code) =>
    ph(`<pre><code>${escapeHtml(decodeSlackEntities(code))}</code></pre>`)
  );

  // 2. Extract inline code (`...`) → placeholders
  text = text.replace(/`([^`\n]+)`/g, (_, code) =>
    ph(`<code>${escapeHtml(decodeSlackEntities(code))}</code>`)
  );

  // 2b. Optionally collapse all newlines to spaces (for collapsed/short view)
  if (collapseNewlines) text = text.replace(/\n+/g, ' ');

  // 3. Process <...> references, using decodeSlackEntities on text segments
  let result = '';
  let lastIndex = 0;
  const regex = /<([^>]+)>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    result += escapeHtml(decodeSlackEntities(text.slice(lastIndex, match.index)));
    const inner = match[1];
    if (inner.match(/^@U[A-Z0-9]+(\|.+)?$/)) {
      const pipeIdx = inner.indexOf('|');
      if (pipeIdx !== -1) {
        result += `@${escapeHtml(inner.slice(pipeIdx + 1))}`;
      } else {
        const uid = inner.slice(1);
        result += `@${escapeHtml(users?.[uid] || uid)}`;
      }
    } else if (inner.match(/^#C[A-Z0-9]+(\|.+)?$/)) {
      const pipeIdx = inner.indexOf('|');
      const cid = inner.slice(1, pipeIdx !== -1 ? pipeIdx : undefined);
      const name = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : (channelNameMap?.[cid] || cid);
      result += `<span class="item-channel inline-channel" data-channel="${escapeHtml(cid)}">#${escapeHtml(name)}</span>`;
    } else if (inner.includes('|')) {
      const pipe = inner.indexOf('|');
      const url = inner.slice(0, pipe);
      const label = inner.slice(pipe + 1);
      if (url.match(/^https?:\/\//)) {
        result += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
      } else {
        result += escapeHtml(label);
      }
    } else if (inner.match(/^https?:\/\//)) {
      let shortLabel;
      try { shortLabel = new URL(inner).hostname.replace(/^www\./, ''); } catch { shortLabel = inner; }
      result += `<a href="${escapeHtml(inner)}" target="_blank" rel="noopener">${escapeHtml(shortLabel)} →</a>`;
    } else {
      result += escapeHtml(inner);
    }
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(decodeSlackEntities(text.slice(lastIndex)));

  // 4. Apply inline mrkdwn (bold, italic, strike — skips HTML tags)
  result = applyMrkdwn(result);

  // 5. Restore placeholders → inject <pre><code> and <code> HTML
  result = result.replace(/\x00PH(\d+)\x00/g, (_, i) => placeholders[+i]);

  // 6. Apply block formatting (lists, blockquotes, newlines)
  result = applyBlockFormatting(result);

  // 7. Apply emoji (existing, unchanged)
  return applyEmoji(result, customEmojiMap);
}

function applyEmoji(html, customEmojis) {
  return html.replace(/(<[^>]*>)|(:([a-z0-9_\-+']+):)/gi, (match, tag, _, name) => {
    if (tag) return tag; // skip HTML tags unchanged
    const lname = name.toLowerCase();
    const customUrl = customEmojis?.[lname];
    if (customUrl) {
      if (customUrl.startsWith('alias:')) {
        const aliasUrl = customEmojis?.[customUrl.slice(6)];
        if (aliasUrl && !aliasUrl.startsWith('alias:'))
          return `<img class="slack-emoji" src="${aliasUrl}" alt=":${lname}:" title=":${lname}:">`;
      } else {
        return `<img class="slack-emoji" src="${customUrl}" alt=":${lname}:" title=":${lname}:">`;
      }
    }
    const unicode = standardEmojiMap?.[lname];
    if (unicode) return unicode;
    return match; // not found — leave as-is
  });
}

function extractZendeskSummary(text) {
  if (!text) return null;
  const idx = text.indexOf('Request Summary');
  if (idx === -1) return null;
  let after = text.slice(idx + 'Request Summary'.length).replace(/^[\s:]+/, '');
  const endIdx = after.search(/\n| \*/);
  if (endIdx !== -1) after = after.slice(0, endIdx);
  return after.trim() || null;
}

function truncate(text, max = 400, users) {
  const zendesk = extractZendeskSummary(text);
  if (zendesk) return escapeHtml(zendesk);
  const cleaned = cleanSlackText(text, users);
  if (cleaned.length <= max) return formatSlackHtml(text, users, { collapseNewlines: true });
  const id = `trunc_${++truncateId}`;
  const short = applyEmoji(applyMrkdwn(escapeHtml(cleaned.replace(/\n+/g, ' ').slice(0, max))), customEmojiMap);
  const full = formatSlackHtml(text, users);
  return `<span id="${id}-short">${short}... <span class="see-more" data-trunc-id="${id}">See more</span></span><span id="${id}-full" style="display:none">${full} <span class="see-less" data-trunc-id="${id}">See less</span></span>`;
}

function wrapFilesIfTruncated(prevTruncId, fwdHtml, filesHtml) {
  const extras = fwdHtml + filesHtml;
  if (truncateId > prevTruncId && extras) {
    return `<span id="trunc_${truncateId}-files" style="display:none">${extras}</span>`;
  }
  return extras;
}

function plainTruncate(text, max = 150, users) {
  const cleaned = cleanSlackText(text, users);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + '...';
}

// Combine text + forwarded text for plain-text contexts (LLM summaries)
function textWithFwd(text, fwd) {
  if (!fwd) return text || '';
  const prefix = fwd.author ? `[fwd from ${fwd.author}] ` : '[fwd] ';
  return text ? `${text} ${prefix}${fwd.text}` : `${prefix}${fwd.text}`;
}

function renderFiles(files) {
  if (!files || files.length === 0) return '';
  let html = '<div class="msg-files">';
  for (const f of files) {
    if (f.voice) {
      const dur = f.duration_ms ? ` (${Math.round(f.duration_ms / 1000)}s)` : '';
      const txt = f.transcript ? escapeHtml(f.transcript) : 'No transcript available';
      const playBtn = f.url ? `<button class="voice-play-btn" data-voice-url="${escapeHtml(f.url)}" title="Play">&#9654;</button>` : '';
      html += `<div class="voice-msg">${playBtn}<div class="voice-msg-body"><span class="voice-msg-label">&#127908; Voice message${dur}</span><span class="voice-msg-transcript">${txt}</span></div></div>`;
      continue;
    }
    const isImage = f.mimetype?.startsWith('image/');
    const isVideo = f.mimetype?.startsWith('video/');
    const name = escapeHtml(f.name || 'file');
    if ((isImage || isVideo) && f.thumb) {
      const href = f.url || f.thumb;
      html += `<a class="file-thumb" href="${escapeHtml(href)}" data-lb-url="${escapeHtml(href)}" data-lb-type="${isVideo ? 'video' : 'image'}" target="_blank" rel="noopener">`;
      html += `<img src="${escapeHtml(f.thumb)}" alt="${name}" loading="lazy">`;
      if (isVideo) html += '<span class="file-video-badge">VIDEO</span>';
      html += '</a>';
    } else if (isVideo && f.url) {
      html += `<a class="file-video-placeholder" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">`;
      html += `<span class="play-icon">&#9654;</span>`;
      html += `<span class="file-video-name">${name}</span>`;
      html += `</a>`;
    } else if (f.url) {
      html += `<a class="file-link" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">&#128206; ${name}</a>`;
    }
  }
  html += '</div>';
  return html;
}

function uname(uid, users) {
  if (!uid) return 'bot';
  return users[uid] || uid;
}

function userLink(name, channel, ts) {
  if (!channel || !ts) return `<span class="item-user">${name}:</span>`;
  const href = slackPermalink(channel, ts);
  return `<a class="item-user" data-channel="${channel}" data-ts="${ts}" href="${href}" target="_blank">${name}:</a>`;
}

function channelLink(label, channelId) {
  if (!channelId) return `<span class="item-channel">${label}</span>`;
  return `<span class="item-channel" data-channel="${channelId}">${label}</span>`;
}

const THREAD_BADGE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';

function threadBadge(m, channel, truncId, opts = {}) {
  if (!m.reply_count) return '';
  const n = m.reply_count;
  const seeMore = truncId ? ' · See more' : '';
  const truncAttr = truncId ? ` data-trunc-id="${truncId}"` : '';
  const containerAttr = opts.containerId ? ` data-container-id="${opts.containerId}"` : '';
  const badgeTs = opts.threadTs || m.ts;
  const time = formatTimeTooltip(m.ts);
  const timeHtml = time ? `<span class="msg-time">${time}</span>` : '';
  const timeAttr = time ? ` data-time="${escapeHtml(time)}"` : '';
  return `<span class="msg-thread-badge" data-channel="${channel}" data-ts="${badgeTs}"${truncAttr}${timeAttr}${containerAttr}>${THREAD_BADGE_ICON}${n} ${n === 1 ? 'reply' : 'replies'}${seeMore}${timeHtml}</span>`;
}

function newerRepliesBadge(channel, threadTs, afterTs, count, containerId) {
  const time = formatTimeTooltip(afterTs || threadTs);
  const timeHtml = time ? `<span class="msg-time">${time}</span>` : '';
  const timeAttr = time ? ` data-time="${escapeHtml(time)}"` : '';
  const afterAttr = afterTs ? ` data-after-ts="${afterTs}"` : '';
  const containerAttr = containerId ? ` data-container-id="${containerId}"` : '';
  return `<span class="msg-thread-badge" data-channel="${channel}" data-ts="${threadTs}" data-mode="newer" data-newer-count="${count}"${afterAttr}${timeAttr}${containerAttr}>${THREAD_BADGE_ICON}View ${count} newer ${count === 1 ? 'reply' : 'replies'}${timeHtml}</span>`;
}

function renderFwd(fwd, users) {
  if (!fwd) return '';
  const label = fwd.author ? `fwd from ${escapeHtml(fwd.author)}` : 'fwd';
  const body = formatSlackHtml(fwd.text, users);
  return `<blockquote class="fwd-quote"><span class="fwd-label">${label}</span>${body}</blockquote>`;
}

// Render message text + files + thread badge with merged "See more" / "N replies"
function renderMsgBody(m, channel, users, maxLen = 400, threadUi = null, opts = {}) {
  const prevId = truncateId;
  let textHtml = truncate(m.text, maxLen, users);
  const wasTruncated = truncateId > prevId;
  let truncIdForBadge = null;
  if (wasTruncated && m.reply_count) {
    truncIdForBadge = `trunc_${truncateId}`;
    // Hide standalone "See more" — it's merged into the thread badge
    textHtml = textHtml.replace(
      `<span class="see-more" data-trunc-id="${truncIdForBadge}">See more</span>`,
      `<span class="see-more" data-trunc-id="${truncIdForBadge}" style="display:none">See more</span>`
    );
  }
  let badge = '';
  if (!opts.skipBadge) {
    if (threadUi?.mode === 'newer' && threadUi.newerReplyCount > 0) {
      badge = newerRepliesBadge(channel, threadUi.threadTs || m.thread_ts || m.ts, threadUi.afterTs || m.ts, threadUi.newerReplyCount, threadUi.containerId);
    } else {
      const badgeOpts = threadUi ? { containerId: threadUi.containerId, threadTs: threadUi.threadTs } : {};
      badge = threadBadge(m, channel, truncIdForBadge, badgeOpts);
    }
  }
  const fwdHtml = renderFwd(m.fwd, users);
  const filesHtml = renderFiles(m.files);
  const extras = fwdHtml + filesHtml;
  const timeHtml = badge ? '' : msgTime(m.ts, channel);
  if (wasTruncated && extras) {
    return textHtml + `<span id="trunc_${truncateId}-files" style="display:none">${extras}</span>` + badge + timeHtml;
  }
  if (filesHtml && timeHtml) {
    return textHtml + fwdHtml + `<div class="files-time-row">${filesHtml}${timeHtml}</div>` + badge;
  }
  return textHtml + fwdHtml + filesHtml + badge + timeHtml;
}

function threadRepliesContainer(m, channel, threadUi = null) {
  const hasReplies = (m.reply_count || 0) > 0 || (threadUi?.mode === 'newer' && threadUi.newerReplyCount > 0);
  if (!hasReplies) return '';
  const threadTs = threadUi?.threadTs || m.ts;
  const msgTs = m.ts || threadUi?.threadTs || threadTs;
  const containerId = threadUi?.containerId || `thread-${channel}-${(threadTs || '').replace(/\./g, '_')}-${(msgTs || '').replace(/\./g, '_')}`;
  const modeAttr = threadUi?.mode ? ` data-mode="${threadUi.mode}"` : '';
  const afterAttr = threadUi?.afterTs ? ` data-after-ts="${threadUi.afterTs}"` : '';
  return `<div class="thread-replies-container" data-channel="${channel}" data-ts="${threadTs}" data-container-id="${containerId}"${modeAttr}${afterAttr}></div>`;
}

function threadNeedsSummary(t) {
  if (!t || t._isDmThread) return false;
  if (t._forceThreadSummary) return true;
  return (t.unread_replies || []).length >= 5;
}

// threadTs = root ts for reply context. isDm = true sends reply as top-level DM (no thread).
function msgActions(channel, ts, { showReply = true } = {}) {
  const saved = savedMsgKeys.has(`${channel}:${ts}`);
  const saveClass = saved ? ' saved' : '';
  const fill = saved ? 'currentColor' : 'none';
  const myReactions = myReactionsMap[`${channel}:${ts}`] || [];
  const likeClass = myReactions.includes('+1') ? ' reacted' : '';
  const heartClass = myReactions.includes('yellow_heart') ? ' reacted' : '';
  const replyBtn = showReply
    ? `<span class="action-btn action-msg-reply" data-channel="${channel}" data-ts="${ts}" title="Reply in thread"><kbd>R</kbd> reply</span>`
    : '';
  return `<div class="msg-actions">
    <span class="action-btn action-react${likeClass}" data-channel="${channel}" data-ts="${ts}" data-emoji="+1" title="+1"><kbd>L</kbd> 👍</span>
    <span class="action-btn action-react${heartClass}" data-channel="${channel}" data-ts="${ts}" data-emoji="yellow_heart" title="yellow_heart"><kbd>H</kbd> 💛</span>
    <span class="action-btn action-save${saveClass}" data-channel="${channel}" data-ts="${ts}" title="${saved ? 'Saved' : 'Save'}"><kbd>S</kbd> save</span>
    ${replyBtn}
  </div>`;
}

function slackPermalink(channel, ts) {
  if (!channel || !ts) return '';
  return `${location.origin}/archives/${channel}/p${ts.replace('.', '')}`;
}

function msgTime(ts, channel) {
  const t = formatTimeTooltip(ts);
  if (!t) return '';
  const attrs = channel && ts ? ` data-channel="${channel}" data-ts="${ts}"` : '';
  const href = slackPermalink(channel, ts);
  if (href) return `<a class="msg-time"${attrs} href="${href}" target="_blank">${t}</a>`;
  return `<span class="msg-time"${attrs}>${t}</span>`;
}

function itemTime(ts, channel) {
  const attrs = channel && ts ? ` data-channel="${channel}" data-ts="${ts}"` : '';
  const href = slackPermalink(channel, ts);
  if (href) return `<a class="item-time"${attrs} href="${href}" target="_blank">${formatTime(ts)}</a>`;
  return `<span class="item-time"${attrs}>${formatTime(ts)}</span>`;
}

function itemActions(channel, markTs, threadTs, isDm, channelName = '', isNoise = false) {
  return `<div class="item-actions">
    <span class="mark-all-read" data-channel="${channel}" data-ts="${markTs}"${threadTs ? ` data-thread-ts="${threadTs}"` : ''}><kbd>M</kbd> mark read</span>
    ${threadTs || isDm ? `<span class="action-reply" data-channel="${channel}" data-ts="${threadTs || markTs}"${isDm ? ' data-dm="true"' : ''}>${isDm ? 'send a DM' : 'reply'}</span>` : ''}
    ${threadTs ? `<span class="action-mute" data-channel="${channel}" data-thread-ts="${threadTs}"><kbd>T</kbd> mute thread</span>` : ''}
    ${!threadTs && !isDm ? `<span class="action-mute-channel" data-channel="${channel}"><kbd>T</kbd> mute channel</span>` : ''}
    ${!threadTs && !isDm && !isNoise ? `<span class="action-always-noise" data-channel="${channel}" data-channel-name="${escapeHtml(channelName)}">mark noise</span>` : ''}
    ${!threadTs && !isDm && isNoise ? `<span class="action-never-noise" data-channel="${channel}" data-channel-name="${escapeHtml(channelName)}">never noise</span>` : ''}
    ${!threadTs && !isDm ? `<span class="action-mark-digest" data-channel="${channel}" data-channel-name="${escapeHtml(channelName)}">mark digest</span>` : ''}
  </div>`;
}

function reasonBadge(item, cssClass) {
  if (!item._reason) return '';
  const cls = cssClass === 'act-now' ? 'reason-act-now' : 'reason-priority';
  return `<div class="item-reason ${cls}">${escapeHtml(item._reason)}</div>`;
}

// ── Render a single item (thread, DM, or channel) as HTML ──
function renderThreadItem(t, data, cssClass) {
  const unread = t.unread_replies || [];
  const lastUnread = unread[unread.length - 1];
  const seenCount = Math.max(0, (t.reply_count || 0) - unread.length);

  let channelLabel;
  if (t._isDmThread) {
    const allUsers = [t.root_user, ...unread.map((r) => r.user)].filter(Boolean);
    const partner = allUsers.find((u) => u !== data.selfId) || allUsers[0];
    channelLabel = escapeHtml(uname(partner, data.users));
  } else {
    const ch = data.channels[t.channel_id] || t.channel_id;
    channelLabel = `#${ch}`;
  }

  const markAllTs = lastUnread?.ts || t.ts;
  let html = `<div class="item ${cssClass}">
    <div class="item-left">
      ${channelLink(channelLabel, t.channel_id)}
      ${itemTime(markAllTs, t.channel_id)}`;
  if (t.mention_count > 0 || t._isMentioned) {
    html += `<div class="item-mention">@mentioned</div>`;
  }
  html += reasonBadge(t, cssClass);
  const _rtid = truncateId;
  const rootTextHtml = truncate(t.root_text, 400, data.users);
  const rootExtras = wrapFilesIfTruncated(_rtid, renderFwd(t.root_fwd, data.users), renderFiles(t.root_files));
  const rootSeenClass = seenCount > 0 ? ' root-seen' : '';
  html += `</div>
    <div class="item-right">
      <div class="msg-row"><div class="msg-content item-text${rootSeenClass}">${userLink(uname(t.root_user, data.users), t.channel_id, t.ts)} ${rootTextHtml}${rootExtras}${msgTime(t.ts, t.channel_id)}</div>${msgActions(t.channel_id, t.ts)}</div>`;
  // Thread reply summarization for non-DM threads that meet summary criteria
  const shouldSummarize = threadNeedsSummary(t);
  const threadKey = shouldSummarize ? `thread-summary-${t.channel_id}-${(t.ts || '').replace('.', '_')}` : '';
  const repliesMsgId = shouldSummarize ? `${threadKey}-replies` : '';

  html += '<div class="thread-replies-container">';
  if (seenCount > 0) {
    const unreadTs = unread.map((r) => r.ts).join(',');
    html += `<div class="seen-replies-toggle" data-channel="${t.channel_id}" data-ts="${t.ts}" data-unread-ts="${unreadTs}">${seenCount} earlier ${seenCount === 1 ? 'reply' : 'replies'}</div>`;
    html += `<div class="seen-replies-container" data-for="${t.channel_id}-${t.ts}"></div>`;
  }

  if (shouldSummarize) {
    if (t._threadSummary) {
      html += `<div class="deep-summary" style="margin:6px 0 2px">${escapeHtml(t._threadSummary)}</div>`;
      html += `<span class="show-messages-link" data-target="${repliesMsgId}" style="margin-top:2px">show ${unread.length} ${unread.length === 1 ? 'reply' : 'replies'} ↓</span>`;
    } else {
      html += `<div id="${threadKey}-loading" style="color:#555;font-size:12px;font-style:italic;margin:6px 0 2px">Summarizing replies...</div>`;
      html += `<span class="show-messages-link" data-target="${repliesMsgId}" style="margin-top:2px">show ${unread.length} ${unread.length === 1 ? 'reply' : 'replies'} ↓</span>`;
    }
    html += `<div class="deep-messages" id="${repliesMsgId}">`;
  }

  for (const r of unread) {
    const _urtid = truncateId;
    const rTextHtml = truncate(r.text, 1000, data.users);
    const rExtras = wrapFilesIfTruncated(_urtid, renderFwd(r.fwd, data.users), renderFiles(r.files));
    html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(uname(r.user, data.users), t.channel_id, r.ts)} ${rTextHtml}${rExtras}${msgTime(r.ts, t.channel_id)}</div>${msgActions(t.channel_id, r.ts)}</div>`;
  }

  if (shouldSummarize) {
    html += '</div>';
  }

  html += '</div>';
  html += itemActions(t.channel_id, markAllTs, t.ts, t._isDmThread);
  html += '</div></div>';
  return html;
}

function dmPartnerName(dm, data) {
  const messages = dm.messages || [];
  if (dm.isGroup) {
    const explicitIds = (dm.members || [])
      .filter((uid) => uid && uid !== data.selfId);
    const inferredIds = messages
      .map((m) => (m.user && m.subtype !== 'bot_message' ? m.user : null))
      .filter((uid) => uid && uid !== data.selfId);
    const combinedIds = [...explicitIds, ...inferredIds];
    const uniqueIds = [...new Set(combinedIds)];
    const names = uniqueIds.map((uid) => uname(uid, data.users)).filter(Boolean);
    if (names.length === 0) return 'Group DM';
    if (names.length <= 3) return names.join(', ');
    return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
  }
  // Find the most common non-bot user in the DM — that's who it's with
  for (const m of messages) {
    if (m.user && m.subtype !== 'bot_message') return uname(m.user, data.users);
  }
  return 'DM';
}

function renderDmItem(dm, data, cssClass) {
  if (!dm.messages || dm.messages.length === 0) return '';
  const latest = dm.messages[0];
  const partner = dmPartnerName(dm, data);
  let html = `<div class="item ${cssClass}">
    <div class="item-left">
      ${channelLink(escapeHtml(partner), dm.channel_id)}
      ${itemTime(latest.ts, dm.channel_id)}
      ${reasonBadge(dm, cssClass)}
    </div>
    <div class="item-right">`;
  for (const m of [...dm.messages].reverse()) {
    const sender = dm.isGroup ? `${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), dm.channel_id, m.ts)} ` : '';
    const _dtid = truncateId;
    const dmTextHtml = truncate(m.text, 1000, data.users);
    const dmExtras = wrapFilesIfTruncated(_dtid, renderFwd(m.fwd, data.users), renderFiles(m.files));
    html += `<div class="msg-row"><div class="msg-content item-text">${sender}${dmTextHtml}${dmExtras}${msgTime(m.ts, dm.channel_id)}</div>${msgActions(dm.channel_id, m.ts, { showReply: false })}</div>`;
  }
  html += itemActions(dm.channel_id, latest.ts, null, true);
  html += '</div></div>';
  return html;
}

function buildThreadUiMeta(data, channelId, message) {
  if (!data || !channelId || !message) return null;
  let hasThread = false;
  const meta = {};
  if ((message.reply_count || 0) > 0) {
    hasThread = true;
    meta.threadTs = message.ts;
  }
  if (message.thread_ts && message.thread_ts !== message.ts) {
    const newerCount = countNewerThreadReplies(data, channelId, message.thread_ts, message.ts);
    if (newerCount > 0) {
      hasThread = true;
      meta.threadTs = message.thread_ts;
      meta.mode = 'newer';
      meta.afterTs = message.ts;
      meta.newerReplyCount = newerCount;
    }
  }
  if (!hasThread) return null;
  const rootTs = meta.threadTs || message.ts;
  const msgTs = message.ts || rootTs;
  meta.threadTs = rootTs;
  meta.containerId = `thread-${channelId}-${(rootTs || '').replace(/\./g, '_')}-${(msgTs || '').replace(/\./g, '_')}`;
  return meta;
}

function renderChannelItem(cp, data, cssClass) {
  const ch = data.channels[cp.channel_id] || cp.channel_id;
  const latest = cp.messages[0];
  let html = `<div class="item ${cssClass}">
    <div class="item-left">
      ${channelLink('#' + escapeHtml(ch), cp.channel_id)}
      ${itemTime(latest?.ts, cp.channel_id)}`;
  if (cp.mention_count > 0 || cp._isMentioned) {
    html += `<div class="item-mention">@mentioned</div>`;
  }
  html += reasonBadge(cp, cssClass);
  if (cp._repliers?.length) {
    const names = cp._repliers.map(escapeHtml).join(', ');
    const overflow = cp._replierOverflow > 0 ? ` +${cp._replierOverflow}` : '';
    html += `<div class="item-replied">${names}${overflow} replied</div>`;
  }
  html += `</div>
    <div class="item-right">`;
  if (cp._summary) {
    const zendesk = extractZendeskSummary(cp._summary);
    const summaryMsg = cp.messages[0];
    const senderName = summaryMsg ? (summaryMsg.subtype === 'bot_message' ? 'Bot' : uname(summaryMsg.user, data.users)) : 'Bot';
    html += `<div class="msg-row"><div class="msg-content item-text">${userLink(senderName, cp.channel_id, summaryMsg?.ts)} ${escapeHtml(zendesk || cp._summary)}</div>${summaryMsg ? msgActions(cp.channel_id, summaryMsg.ts) : ''}</div>`;
  } else {
    const visibleMsgs = cp.messages.slice(0, 10).reverse();
    for (const m of visibleMsgs) {
      const threadUi = buildThreadUiMeta(data, cp.channel_id, m);
      if (cp._summarizeThreads && (m.reply_count || 0) >= 10) {
        // Render message without thread badge; badge moves below summary
        const threadTs = threadUi?.threadTs || m.ts;
        const containerId = threadUi?.containerId || `thread-${cp.channel_id}-${(threadTs || '').replace(/\./g, '_')}-${(m.ts || '').replace(/\./g, '_')}`;
        const modeAttr = threadUi?.mode ? ` data-mode="${threadUi.mode}"` : '';
        const afterAttr = threadUi?.afterTs ? ` data-after-ts="${threadUi.afterTs}"` : '';
        const key = `ch-thread-summary-${cp.channel_id}-${(m.ts || '').replace('.', '_')}`;
        const repliesId = `${key}-replies`;
        html += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users, 400, threadUi, { skipBadge: true })}`
          + `<div class="thread-replies-container" data-channel="${cp.channel_id}" data-ts="${threadTs}" data-container-id="${containerId}"${modeAttr}${afterAttr}>`
          + `<div id="${key}-loading" style="color:#555;font-size:12px;font-style:italic;margin:6px 0 2px">Summarizing replies…</div>`
          + `<span class="show-messages-link" data-target="${repliesId}" data-fetch-replies="1" data-channel="${cp.channel_id}" data-ts="${threadTs}" style="margin-top:2px">show ${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'} ↓</span>`
          + `<div class="deep-messages" id="${repliesId}"></div>`
          + `</div></div>${msgActions(cp.channel_id, m.ts)}`;
      } else {
        html += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users, 400, threadUi)}${threadRepliesContainer(m, cp.channel_id, threadUi)}</div>${msgActions(cp.channel_id, m.ts)}`;
      }
      html += `</div>`;
    }
    if (cp.messages.length > 10) {
      html += `<div class="item-text" style="color:#888;font-size:0.85em">+${cp.messages.length - 10} more messages</div>`;
    }
  }
  html += itemActions(cp.channel_id, latest?.ts, null, false, ch, cssClass === 'noise-item');
  html += '</div></div>';
  return html;
}

function renderDeepSummarizedItem(cp, data) {
  const ch = data.channels[cp.channel_id] || cp.channel_id;
  const latest = cp.messages[0];
  const typeLabels = {
    key_update: 'Key Update',
    decision: 'Decision',
    heated_discussion: 'Heated Discussion',
    needs_attention: 'Needs Attention',
    feedback_digest: 'Feedback Digest',
    activity_digest: 'Activity Digest',
  };
  const typeBadge = cp._deepType ? (typeLabels[cp._deepType] || cp._deepType) : '';
  const msgs = cp.fullMessages?.history || cp.messages;
  const oldestTs = msgs[msgs.length - 1]?.ts;
  const newestTs = msgs[0]?.ts;
  const timeDisplay = oldestTs && newestTs && formatTime(oldestTs) !== formatTime(newestTs)
    ? `${formatTime(oldestTs)} → ${formatTime(newestTs)}`
    : formatTime(newestTs);
  let messagesHtml = '';
  for (const m of msgs) {
    const threadUi = buildThreadUiMeta(data, cp.channel_id, m);
    messagesHtml += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users, 400, threadUi)}${threadRepliesContainer(m, cp.channel_id, threadUi)}</div>${msgActions(cp.channel_id, m.ts)}</div>`;
  }
  const deepMsgId = `deep-msgs-${cp.channel_id}`;
  return `<div class="item noise-item">
    <div class="item-left">
      ${channelLink('#' + escapeHtml(ch), cp.channel_id)}
      ${newestTs ? `<a class="item-time" data-channel="${cp.channel_id}" data-ts="${newestTs}" href="${slackPermalink(cp.channel_id, newestTs)}" target="_blank">${timeDisplay}</a>` : `<span class="item-time">${timeDisplay}</span>`}
    </div>
    <div class="item-right">
      <div class="msg-row"><div class="msg-content">
        <div>${typeBadge ? `<span class="deep-type-badge">${escapeHtml(typeBadge)}</span>` : ''}${cp._deepFetchFailed ? `<span class="error" style="font-size:11px;margin-left:6px;">⚠ fetch failed, limited context</span>` : ''}</div>
        <div class="deep-summary">${escapeHtml(cp._deepSummary || '')}</div>
        <div style="display:flex;gap:12px;margin-top:6px;">
          <span class="show-messages-link" data-target="${deepMsgId}" style="margin-top:0">show ${msgs.length} message${msgs.length === 1 ? '' : 's'} ↓</span>
          <span class="show-messages-link mark-all-read" data-channel="${cp.channel_id}" data-ts="${latest?.ts}" style="margin-top:0">mark as read</span>
          <span class="show-messages-link action-mute-channel" data-channel="${cp.channel_id}" style="margin-top:0">mute channel</span>
          <span class="show-messages-link action-never-noise" data-channel="${cp.channel_id}" data-channel-name="${escapeHtml(ch)}" style="margin-top:0">never noise</span>
          <span class="show-messages-link action-mark-digest" data-channel="${cp.channel_id}" data-channel-name="${escapeHtml(ch)}" style="margin-top:0">mark digest</span>
        </div>
      </div></div>
      <div class="deep-messages" id="${deepMsgId}">${messagesHtml}</div>
    </div>
  </div>`;
}

function renderSavedItem(item, data) {
  const channel = item.item_id;
  const ts = item.ts;
  const ch = data.channels?.[channel] || channel;
  const msg = item.message || {};
  const user = msg.user;
  const _stid = truncateId;
  const textHtml = msg.text ? truncate(msg.text, 400, data.users) : '';
  const savedExtras = wrapFilesIfTruncated(_stid, renderFwd(msg.fwd, data.users), renderFiles(msg.files));
  return `<div class="item saved-item" data-complete-request-id="">
    <div class="item-left">
      ${channelLink('#' + escapeHtml(ch), channel)}
      ${itemTime(ts, channel)}
    </div>
    <div class="item-right">
      <div class="msg-row">
        <div class="msg-content item-text">${user ? userLink(uname(user, data.users), channel, ts) + ' ' : ''}${textHtml}${savedExtras}${msgTime(ts, channel)}</div>
        <span class="action-btn action-complete-saved" data-item-id="${escapeHtml(channel)}" data-ts="${escapeHtml(ts)}" title="Mark complete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </span>
      </div>
    </div>
  </div>`;
}

function renderBotThreadItem(cp, data, cssClass) {
  const ch = data.channels[cp.channel_id] || cp.channel_id;
  const allMsgs = cp.messages;
  const key = `bot-thread-${cp.channel_id}-${(cp.sort_ts || '').replace('.', '_')}`;
  const deepMsgId = `${key}-msgs`;

  let messagesHtml = '';
  for (const m of allMsgs) {
    const threadUi = buildThreadUiMeta(data, cp.channel_id, m);
    messagesHtml += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' || !m.user ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users, 400, threadUi)}${threadRepliesContainer(m, cp.channel_id, threadUi)}</div>${msgActions(cp.channel_id, m.ts, { showReply: false })}</div>`;
  }

  let contentHtml;
  if (cp._botSummary) {
    contentHtml = `
      <div class="msg-row"><div class="msg-content">
        <div class="deep-summary">${escapeHtml(cp._botSummary)}</div>
        <div style="display:flex;gap:12px;margin-top:6px;">
          <span class="show-messages-link" data-target="${deepMsgId}" style="margin-top:0">show ${allMsgs.length} message${allMsgs.length === 1 ? '' : 's'} ↓</span>
          <span class="show-messages-link mark-all-read" data-channel="${cp.channel_id}" data-ts="${allMsgs[allMsgs.length - 1]?.ts}" style="margin-top:0">mark as read</span>
        </div>
      </div></div>
      <div class="deep-messages" id="${deepMsgId}">${messagesHtml}</div>`;
  } else {
    contentHtml = `
      <div class="msg-row"><div class="msg-content">
        <div id="${key}-summary" style="color:#555;font-size:12px;font-style:italic;margin-bottom:4px">Analyzing discussion...</div>
      </div></div>
      <div class="deep-messages" style="display:block">${messagesHtml}</div>`;
  }

  return `<div class="item ${cssClass}" data-bot-thread-key="${key}">
    <div class="item-left">
      ${channelLink('#' + escapeHtml(ch), cp.channel_id)}
      ${itemTime(allMsgs[allMsgs.length - 1]?.ts, cp.channel_id)}
    </div>
    <div class="item-right">
      ${contentHtml}
      ${itemActions(cp.channel_id, allMsgs[allMsgs.length - 1]?.ts, null, false, ch, cssClass === 'noise-item')}
    </div>
  </div>`;
}

function renderAnyItem(item, data, cssClass) {
  if (item._type === 'thread') return renderThreadItem(item, data, cssClass);
  if (item._type === 'dm') return renderDmItem(item, data, cssClass);
  if (item._type === 'channel') {
    if (item._deepSummary) return renderDeepSummarizedItem(item, data);
    if (item._isBotThread) return renderBotThreadItem(item, data, cssClass);
    return renderChannelItem(item, data, cssClass);
  }
  return '';
}

const HANDLE_MENTION_REGEX = /(?:^|[\s"'([{<])@(?:gem|cemre)(?=$|[\s.,!?;:)\]\}>"'])/i;
const BARE_NAME_REGEX = /(?:^|[\s"'([{<])(?:gem|cemre)(?=$|[\s.,!?;:)\]\}>"'])/i;

function containsSelfMention(text, selfId) {
  if (!text || !selfId) return false;
  if (text.includes(`<@${selfId}>`)) return true;
  if (text.includes(`@${selfId}`)) return true;
  return HANDLE_MENTION_REGEX.test(text) || BARE_NAME_REGEX.test(text);
}

// ── Deterministic pre-filters ──
// Hard-drops, bot→whenFree. Everything else goes to LLM for classification + ranking.
function applyPreFilters(data) {
  const { selfId, threads, dms, channelPosts, channels, users } = data;
  const meta = data.channelMeta || {};

  const noise = [];
  const whenFree = [];
  const digests = [];
  const forLlm = { threads: [], dms: [], channelPosts: [] };

  function isBot(m) { return m.bot_id || m.subtype === 'bot_message'; }

  const threadList = Array.isArray(threads) ? threads : [];
  const channelPostList = Array.isArray(channelPosts) ? channelPosts : [];
  const dmList = Array.isArray(dms) ? dms : [];

  // Track replies that were also posted to the channel so we can drop the duplicate thread entry
  const broadcastedThreadReplyKeys = new Set();
  for (const cp of channelPostList) {
    const channelId = cp?.channel_id;
    if (!channelId) continue;
    for (const msg of cp.messages || []) {
      if (msg.thread_ts && msg.thread_ts !== msg.ts) {
        broadcastedThreadReplyKeys.add(`${channelId}:${msg.ts}`);
      }
    }
  }

  const filteredThreads = [];
  for (const t of threadList) {
    if (!t) continue;
    const muteKey = threadKey(t.channel_id, t.ts);
    if (muteKey && mutedThreadKeys.has(muteKey)) continue;
    const unread = t.unread_replies || [];
    if (unread.length > 0 && broadcastedThreadReplyKeys.size > 0) {
      const deduped = unread.filter((reply) => !broadcastedThreadReplyKeys.has(`${t.channel_id}:${reply.ts}`));
      if (deduped.length !== unread.length) {
        t.unread_replies = deduped;
        if (deduped.length > 0) {
          const latest = deduped[deduped.length - 1];
          if (latest?.ts) t.sort_ts = latest.ts;
        }
      }
    }
    if ((t.unread_replies || []).length === 0) continue;
    filteredThreads.push(t);
  }
  data.threads = filteredThreads;

  // Threads: annotate metadata for LLM
  const diaChannelNames = new Set(['dia-dogfooding', 'help-dia']);
  for (const t of filteredThreads) {
    t._userReplied = (t.reply_users || []).includes(selfId);
    t._type = 'thread';
    t._isDmThread = t.channel_id?.startsWith('D') || false;

    // Only check unread replies for mentions — the root_text was already seen,
    // so a mention there shouldn't make every new reply "priority"
    const unreadTexts = (t.unread_replies || []).map((r) => r.text).join(' ');
    t._isMentioned = containsSelfMention(unreadTexts, selfId);

    // dia-dogfooding / help-dia threads: only surface if 10+ replies, rest → noise
    const tChName = channels[t.channel_id] || '';
    const isOwnThread = t.root_user === selfId;
    if (diaChannelNames.has(tChName) && !isOwnThread) {
      if ((t.reply_count || 0) >= 10) {
        t._forceThreadSummary = true;
        whenFree.push(t);
      } else {
        noise.push(t);
      }
      continue;
    }

    // All-bot unread replies → when free
    if ((t.unread_replies || []).every(isBot)) {
      whenFree.push(t);
      continue;
    }

    forLlm.threads.push(t);
  }

  // Unified digest routing helper
  function routeToDigest(cp) {
    if (cp._isMentioned) {
      forLlm.channelPosts.push(cp);
      return;
    }
    const hotMsgs = cp.messages.filter((m) => (m.reply_count || 0) >= 4);
    const coldMsgs = cp.messages.filter((m) => (m.reply_count || 0) < 4);
    if (hotMsgs.length > 0) {
      const hotCp = { ...cp, messages: hotMsgs };
      const replierIds = [...new Set(hotMsgs.flatMap((m) => m.reply_users || []))];
      hotCp._repliers = replierIds.slice(0, 3).map((uid) => uname(uid, users));
      hotCp._replierOverflow = Math.max(0, replierIds.length - 3);
      whenFree.push(hotCp);
    }
    if (coldMsgs.length > 0) digests.push({ ...cp, messages: coldMsgs, _isDigestChannel: true });
  }

  // Build set of thread roots so we can dedup channel posts that are already shown as threads
  const threadRootKeys = new Set();
  const threadByKey = {};
  for (const t of filteredThreads) {
    if (t.channel_id && t.ts) {
      const key = `${t.channel_id}:${t.ts}`;
      threadRootKeys.add(key);
      threadByKey[key] = t;
    }
  }

  // Channel posts
  for (const cp of channelPostList) {
    cp._type = 'channel';

    const allCpTexts = cp.messages.map((m) => m.text || '').join(' ');
    cp._isMentioned = containsSelfMention(allCpTexts, selfId);

    // Dedup: if every message in this channel post is already a thread root, skip it
    // but carry over mention_count and _isMentioned to the thread
    const cpMsgsInThreads = cp.messages.filter((m) => threadRootKeys.has(`${cp.channel_id}:${m.ts}`));
    if (cpMsgsInThreads.length === cp.messages.length && cp.messages.length > 0) {
      for (const m of cpMsgsInThreads) {
        const t = threadByKey[`${cp.channel_id}:${m.ts}`];
        if (t) {
          if (cp.mention_count > 0) t.mention_count = (t.mention_count || 0) + cp.mention_count;
          if (cp._isMentioned) t._isMentioned = true;
        }
      }
      continue;
    }

    // dia-dogfooding / help-dia: split — individual posts with 10+ replies → whenFree, rest → noise
    const chName = channels[cp.channel_id] || '';
    if (diaChannelNames.has(chName)) {
      const hotMsgs = cp.messages.filter((m) => (m.reply_count || 0) >= 10);
      const coldMsgs = cp.messages.filter((m) => (m.reply_count || 0) < 10);
      if (hotMsgs.length > 0) {
        const hotCp = { ...cp, messages: hotMsgs, _type: 'channel' };
        const replierIds = [...new Set(hotMsgs.flatMap((m) => m.reply_users || []))];
        hotCp._repliers = replierIds.slice(0, 3).map((uid) => uname(uid, users));
        hotCp._replierOverflow = Math.max(0, replierIds.length - 3);
        hotCp._summarizeThreads = true;
        whenFree.push(hotCp);
      }
      if (coldMsgs.length > 0) {
        noise.push({ ...cp, messages: coldMsgs, _type: 'channel' });
      }
      continue;
    }

    // User-marked digest channels
    if (digestChannels[cp.channel_id]) {
      routeToDigest(cp);
      continue;
    }

    // Persistent channel preferences — bypass LLM entirely
    if (noiseChannels[cp.channel_id]) {
      noise.push(cp);
      continue;
    }
    if (neverNoiseChannels[cp.channel_id]) {
      whenFree.push(cp);
      continue;
    }

    // All-bot messages → digest (deep analysis only for 4+)
    if (cp.messages.every(isBot)) {
      if (cp.messages.length >= 4) cp._deepAnalysis = true;
      routeToDigest(cp);
      continue;
    }

    forLlm.channelPosts.push(cp);
  }

  // DMs
  for (const dm of dmList) {
    dm._type = 'dm';
    const originalMessages = dm.messages || [];
    const filteredMessages = originalMessages.filter((m) => !threadRootKeys.has(`${dm.channel_id}:${m.ts}`));
    if (filteredMessages.length === 0) {
      // Entire DM already surfaced via thread cards; skip duplicate render
      continue;
    }
    if (filteredMessages.length !== originalMessages.length) {
      dm.messages = filteredMessages;
    }
    if (dm.messages.every(isBot)) {
      whenFree.push(dm);
      continue;
    }
    forLlm.dms.push(dm);
  }

  return { noise, whenFree, digests, forLlm };
}

// ── Serialize items for LLM ──
function serializeForLlm(forLlm, data, channelIndexOffset = 0) {
  const items = [];
  const meta = data.channelMeta || {};

  for (let i = 0; i < forLlm.threads.length; i++) {
    const t = forLlm.threads[i];
    const ch = data.channels[t.channel_id] || t.channel_id;
    items.push({
      id: `thread_${i}`,
      type: t._isDmThread ? 'dm_thread' : 'thread',
      channel: ch,
      isPrivate: meta[t.channel_id]?.isPrivate || false,
      isMentioned: t._isMentioned || false,
      rootUser: uname(t.root_user, data.users),
      rootText: plainTruncate(textWithFwd(t.root_text, t.root_fwd), 1000, data.users),
      userReplied: t._userReplied,
      newReplies: t.unread_replies.map((r) => ({
        user: uname(r.user, data.users),
        text: plainTruncate(textWithFwd(r.text, r.fwd), 1000, data.users),
      })),
    });
  }

  for (let i = 0; i < forLlm.dms.length; i++) {
    const dm = forLlm.dms[i];
    const participantIds = (dm.members || []).filter((uid) => uid && uid !== data.selfId);
    const participantNames = [...new Set(participantIds.map((uid) => uname(uid, data.users)))].filter(Boolean);
    items.push({
      id: `dm_${i}`,
      type: 'dm',
      isGroup: !!dm.isGroup,
      participants: participantNames,
      messages: dm.messages.map((m) => ({
        user: m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users),
        text: plainTruncate(textWithFwd(m.text, m.fwd), 1000, data.users),
      })),
    });
  }

  for (let i = 0; i < forLlm.channelPosts.length; i++) {
    const cp = forLlm.channelPosts[i];
    const ch = data.channels[cp.channel_id] || cp.channel_id;
    items.push({
      id: `channel_${i + channelIndexOffset}`,
      type: 'channel',
      channel: ch,
      isPrivate: meta[cp.channel_id]?.isPrivate || false,
      isMentioned: cp._isMentioned || false,
      mentionCount: cp.mention_count || 0,
      messages: cp.messages.map((m) => ({
        user: m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users),
        text: plainTruncate(textWithFwd(m.text, m.fwd), 1000, data.users),
      })),
    });
  }

  return items;
}

// ── Map LLM priorities back to original data objects ──
function mapPriorities(priorities, forLlm, deterministicNoise, deterministicWhenFree, data, reasons = {}) {
  const actNow = [];
  const priority = [];
  const whenFree = [...deterministicWhenFree];
  const noise = [...deterministicNoise];
  const meta = data?.channelMeta || {};

  function place(item, cat) {
    const isPrivate = meta[item.channel_id]?.isPrivate || item._type === 'dm' || item._isDmThread;
    const isDm = item._type === 'dm' || item._isDmThread;
    const isMentioned = item._isMentioned || false;
    const isQualified = isDm || isPrivate || isMentioned;
    const userReplied = item._userReplied || false;

    // DM overrides: VIP DMs → act_now, all other DMs → at least priority
    if (isDm) {
      const senders = (item.messages || item.unread_replies || []).map((m) =>
        uname(m.user, data.users).toLowerCase()
      );
      const isVipDm = senders.some((s) => VIPS.includes(s));
      if (isVipDm) cat = 'act_now';
      else if (cat !== 'act_now') cat = 'priority';
    }

    // Floor: direct @mentions are at least priority (LLM can upgrade to act_now but not below priority)
    if (isMentioned && cat !== 'act_now') cat = 'priority';

    // Hard gate: only DMs, private channels, or @mentions can reach act_now/priority
    if (!isQualified && (cat === 'act_now' || cat === 'priority')) cat = 'when_free';

    if (cat === 'act_now' || cat === 'priority') {
      item._reason = reasons[item._llmId] || undefined;
    }

    if (cat === 'act_now') { actNow.push(item); return; }
    if (cat === 'priority') { priority.push(item); return; }

    // Public channel posts without @mention always go to noise (deep summarization pipeline)
    if (item._type === 'channel' && !isPrivate && !isMentioned) { noise.push(item); return; }

    if (userReplied && (cat === 'noise' || cat === 'drop')) { whenFree.push(item); return; }
    if (cat === 'drop') return;
    if (cat === 'noise' && isPrivate) { whenFree.push(item); return; }
    if (cat === 'when_free') { whenFree.push(item); return; }
    noise.push(item);
  }

  forLlm.threads.forEach((t, i) => { t._llmId = `thread_${i}`; place(t, priorities[`thread_${i}`]); });
  forLlm.dms.forEach((dm, i) => { dm._llmId = `dm_${i}`; place(dm, priorities[`dm_${i}`]); });
  forLlm.channelPosts.forEach((cp, i) => { cp._llmId = `channel_${i}`; place(cp, priorities[`channel_${i}`]); });

  return { actNow, priority, whenFree, noise };
}

function getItemSortTs(item) {
  return parseFloat(item.sort_ts || item.messages?.[0]?.ts || '0');
}

// ── Render prioritized view ──
function sortNoiseItems(items, noiseOrder = []) {
  const orderMap = new Map(noiseOrder.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const aPos = orderMap.has(a._llmId) ? orderMap.get(a._llmId) : Infinity;
    const bPos = orderMap.has(b._llmId) ? orderMap.get(b._llmId) : Infinity;
    if (aPos !== bPos) return aPos - bPos;
    // Fallback for pre-filtered items with no LLM ID (deterministic noise channels)
    const aMsgs = (a.fullMessages?.history || a.messages || []).length;
    const bMsgs = (b.fullMessages?.history || b.messages || []).length;
    if (bMsgs !== aMsgs) return bMsgs - aMsgs;
    const aTs = parseFloat(a.messages?.[0]?.ts || a.sort_ts || '0');
    const bTs = parseFloat(b.messages?.[0]?.ts || b.sort_ts || '0');
    return bTs - aTs;
  });
}

function renderPrioritized(prioritized, data, popular, loading = false, deepNoiseLoading = false, savedItems = [], deepDigestsLoading = false) {
  const { actNow, priority, whenFree, noise } = prioritized;
  const digests = prioritized.digests || [];
  let html = '';

  // Saved items (collapsed by default) — pinned to top
  if (savedItems && savedItems.length > 0) {
    html += '<section class="priority-section">';
    html += `<div class="section-toggle" id="saved-items-toggle">Saved · ${savedItems.length} ↓</div>`;
    html += '<div class="saved-items-list" id="saved-items-list">';
    for (const item of savedItems) html += renderSavedItem(item, data);
    html += '</div>';
    html += '</section>';
  }

  // Act Now
  if (actNow.length > 0) {
    html += '<section class="priority-section"><h2 class="act-now">Act Now</h2>';
    for (const item of actNow) html += renderAnyItem(item, data, 'act-now');
    html += '</section>';
  }

  // Priority
  if (priority && priority.length > 0) {
    html += '<section class="priority-section"><h2 class="priority-header">Priority</h2>';
    for (const item of priority) html += renderAnyItem(item, data, 'priority-item');
    html += `<div class="noise-section-footer"><button id="priority-mark-read-btn">Mark all priority as read</button></div>`;
    html += '</section>';
  }

  // When You Have a Moment (collapsed by default)
  if (whenFree.length > 0) {
    html += '<section class="priority-section">';
    html += `<div class="section-toggle" id="when-free-toggle">When Free · ${whenFree.length} ↓</div>`;
    html += '<div class="when-free-items" id="when-free-items">';
    for (const item of whenFree) html += renderAnyItem(item, data, 'when-free');
    html += `<div class="noise-section-footer"><button id="whenfree-mark-read-btn">Mark all as read</button></div>`;
    html += '</div></section>';
  }

  // Interesting Elsewhere
  if (popular && popular.length > 0) {
    html += '<section class="priority-section"><h2 class="interesting">Interesting Elsewhere</h2>';
    for (const p of popular) {
      const _ptid = truncateId;
      const pTextHtml = truncate(p.text, 400, data.users);
      const pExtras = wrapFilesIfTruncated(_ptid, renderFwd(p.fwd, data.users), renderFiles(p.files));
      html += `<div class="item interesting">
        <div class="item-left">
          ${channelLink('#' + escapeHtml(p.channel_name || p.channel_id), p.channel_id)}
          ${itemTime(p.ts, p.channel_id)}
          <div class="engagement-stats">${p.reaction_count} reactions · ${p.reply_count} replies</div>
        </div>
        <div class="item-right">
          <div class="msg-row"><div class="msg-content item-text">${p.user ? userLink(uname(p.user, data.users), p.channel_id, p.ts) + ' ' : ''}${pTextHtml}${pExtras}${msgTime(p.ts, p.channel_id)}</div>${msgActions(p.channel_id, p.ts)}</div>
        </div>
      </div>`;
    }
    html += '</section>';
  }

  // Loading indicator while LLM is working
  if (loading) {
    html += '<div id="status"><div class="detail">Analyzing remaining messages with AI...</div></div>';
  }

  // Noise (collapsed by default) — split into recent (last 24h) and older
  if (!loading && (noise.length > 0 || deepNoiseLoading)) {
    const noiseCutoff = Date.now() / 1000 - 86400;
    const noiseRecent = noise.filter((item) => getItemSortTs(item) >= noiseCutoff);
    const noiseOlder = noise.filter((item) => getItemSortTs(item) < noiseCutoff);
    html += '<section class="priority-section">';
    if (noiseRecent.length > 0 || deepNoiseLoading) {
      html += `<div class="section-toggle" id="noise-recent-toggle">Recent Noise · ${noiseRecent.length} ↓</div>`;
      html += '<div class="noise-items" id="noise-recent-items">';
      for (const item of noiseRecent) html += renderAnyItem(item, data, 'noise-item');
      if (deepNoiseLoading) {
        html += '<div id="deep-noise-area" style="padding:8px 24px;font-size:12px;color:#3d3f42">Analyzing busy channels...</div>';
      }
      html += `<div class="noise-section-footer"><button id="noise-mark-recent-btn">Mark all recent noise as read</button></div>`;
      html += '</div>';
    }
    // Always render older section when deepNoiseLoading so it's ready to receive items; hide if empty
    if (noiseOlder.length > 0 || deepNoiseLoading) {
      const olderHidden = noiseOlder.length === 0;
      html += `<div class="section-toggle" id="noise-older-toggle"${olderHidden ? ' style="display:none"' : ''}>Older Noise · ${noiseOlder.length} ↓</div>`;
      html += '<div class="noise-items" id="noise-older-items">';
      for (const item of noiseOlder) html += renderAnyItem(item, data, 'noise-item');
      html += `<div class="noise-section-footer" id="noise-older-footer"${olderHidden ? ' style="display:none"' : ''}><button id="noise-mark-older-btn">Mark all older noise as read</button><button id="bankruptcy-btn">☠ Bankruptcy — mark everything older than 7 days as read</button></div>`;
      html += '</div>';
    }
    html += '</section>';
  }

  // Digests (collapsed by default)
  if (!loading && (digests.length > 0 || deepDigestsLoading)) {
    html += '<section class="priority-section">';
    html += `<div class="section-toggle" id="digests-toggle">Digests · ${digests.length} ↓</div>`;
    html += '<div class="noise-items" id="digest-items">';
    for (const item of digests) html += renderAnyItem(item, data, 'noise-item');
    if (deepDigestsLoading) {
      html += '<div id="deep-digest-area" style="padding:8px 24px;font-size:12px;color:#3d3f42">Summarizing digests...</div>';
    }
    html += `<div class="noise-section-footer"><button id="digests-mark-read-btn">Mark all digests as read</button></div>`;
    html += '</div></section>';
  }

  // All clear
  if (!loading && !deepNoiseLoading && !deepDigestsLoading && actNow.length === 0 && (!priority || priority.length === 0) && whenFree.length === 0 && (!popular || popular.length === 0) && noise.length === 0 && digests.length === 0) {
    html += '<div id="status">All clear — nothing needs your attention.</div>';
  }

  // VIP section placeholder (filled in async by kickoffVipSection)
  if (!loading) {
    html += `<div id="vip-area">
  <div class="section-toggle" id="vip-toggle">Creep on VIPs ↓</div>
  <div id="vip-items" style="display:none"></div>
</div>`;
  }

  bodyEl.innerHTML = html;
  focusedItemIndex = -1;
  resetThreadUnreadIndex();
  lastRenderData = data;
  mentionLookupDirty = true;

  // Wire up noise toggles
  function wireNoiseToggle(toggleId, itemsId, label) {
    const toggle = shadow.getElementById(toggleId);
    const items = shadow.getElementById(itemsId);
    if (toggle && items) {
      toggle.addEventListener('click', () => {
        const expanded = items.classList.toggle('expanded');
        const count = items.querySelectorAll('.item').length;
        toggle.textContent = `${label} · ${count} ${expanded ? '↑' : '↓'}`;
      });
    }
  }
  wireNoiseToggle('when-free-toggle', 'when-free-items', 'When Free');
  wireNoiseToggle('noise-recent-toggle', 'noise-recent-items', 'Recent Noise');
  wireNoiseToggle('noise-older-toggle', 'noise-older-items', 'Older Noise');
  wireNoiseToggle('saved-items-toggle', 'saved-items-list', 'Saved');
  wireNoiseToggle('digests-toggle', 'digest-items', 'Digests');
}

// ── New DM watcher — polls for DMs that arrive after initial fetch ──
const DM_POLL_INTERVAL_MS = 30000;

function stopDmWatcher() {
  if (dmWatchTimer) { clearInterval(dmWatchTimer); dmWatchTimer = null; }
}

function startDmWatcher(data) {
  stopDmWatcher();
  // Collect channel IDs of DMs already rendered (from all priority buckets)
  knownDmChannelIds = new Set();
  const allItems = [...(cachedView?.prioritized?.actNow || []), ...(cachedView?.prioritized?.priority || []),
    ...(cachedView?.prioritized?.whenFree || []), ...(cachedView?.prioritized?.noise || [])];
  for (const item of allItems) {
    if (item._type === 'dm') knownDmChannelIds.add(item.channel_id);
  }
  // Also include DMs from the raw data in case they were filtered/dropped
  for (const dm of (data.dms || [])) knownDmChannelIds.add(dm.channel_id);

  dmWatchTimer = setInterval(() => {
    if (!visible) return; // skip if overlay is hidden
    window.postMessage({
      type: `${FSLACK}:pollNewDms`,
      knownChannelIds: [...knownDmChannelIds],
      cachedUsers: { ...cachedUserMap, ...(lastRenderData?.users || {}) },
      requestId: `dmpoll_${Date.now()}`,
    }, '*');
  }, DM_POLL_INTERVAL_MS);
}

function insertNewDm(dm, data) {
  dm._type = 'dm';
  knownDmChannelIds.add(dm.channel_id);

  // Skip all-bot DMs — they'd go to whenFree in a full fetch
  if (dm.messages.every((m) => m.bot_id || m.subtype === 'bot_message')) return;

  // Determine priority: VIP → act_now, else → priority
  const senders = (dm.messages || []).map((m) => uname(m.user, data.users).toLowerCase());
  const isVip = senders.some((s) => VIPS.includes(s));
  const section = isVip ? 'act-now' : 'priority-item';
  const sectionHeader = isVip ? 'Act Now' : 'Priority';

  const itemHtml = renderDmItem(dm, data, section);
  if (!itemHtml) return;

  // Wrap in a container for the fade-in animation
  const wrapper = document.createElement('div');
  wrapper.classList.add('dm-watch-new');
  wrapper.innerHTML = itemHtml;

  // Find or create the target section
  const headerClass = isVip ? 'act-now' : 'priority-header';
  let sectionEl = shadow.querySelector(`h2.${headerClass}`)?.closest('.priority-section');
  if (!sectionEl) {
    // Create the section and insert at the top of bodyEl
    sectionEl = document.createElement('section');
    sectionEl.className = 'priority-section';
    const h2 = document.createElement('h2');
    h2.className = headerClass;
    h2.textContent = sectionHeader;
    sectionEl.appendChild(h2);
    // act-now goes first; priority goes after act-now if it exists
    if (isVip) {
      bodyEl.insertBefore(sectionEl, bodyEl.firstChild);
    } else {
      const actNowSection = shadow.querySelector('h2.act-now')?.closest('.priority-section');
      if (actNowSection) actNowSection.after(sectionEl);
      else bodyEl.insertBefore(sectionEl, bodyEl.firstChild);
    }
  }

  // Insert after the h2 header (prepend within the section)
  const h2 = sectionEl.querySelector('h2');
  if (h2 && h2.nextSibling) h2.after(wrapper);
  else sectionEl.appendChild(wrapper);

  // Update the cached view so mark-read etc. works
  if (cachedView?.prioritized) {
    const bucket = isVip ? cachedView.prioritized.actNow : cachedView.prioritized.priority;
    bucket.unshift(dm);
  }

  console.log(`[fslack] New DM detected: ${dmPartnerName(dm, data)} → ${sectionHeader}`);
}

// ── Seen replies lazy loading ──
let lastRenderData = null;
let threadUnreadIndex = null;
let threadUnreadIndexSource = null;
let mentionLookupCache = null;
let mentionLookupDirty = true;

function normalizeMentionToken(token) {
  return token ? token.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

function mergeCachedUsers(users) {
  if (!users) return;
  let changed = false;
  for (const [uid, name] of Object.entries(users || {})) {
    if (!uid || !name || cachedUserMap[uid] === name) continue;
    cachedUserMap[uid] = name;
    changed = true;
  }
  if (changed) mentionLookupDirty = true;
}

function mergeCachedMentionHints(hints, { replace = false } = {}) {
  if (!hints) return;
  if (replace) cachedUserMentionHints = {};
  let changed = replace;
  for (const [uid, values] of Object.entries(hints || {})) {
    if (!uid) continue;
    const list = Array.isArray(values) ? values.filter((v) => typeof v === 'string' && v.trim()) : [];
    if (list.length === 0) continue;
    const deduped = Array.from(new Set(list));
    const existing = cachedUserMentionHints[uid] || [];
    if (existing.length === deduped.length && existing.every((v, i) => v === deduped[i])) continue;
    cachedUserMentionHints[uid] = deduped;
    changed = true;
  }
  if (changed) mentionLookupDirty = true;
}

function buildMentionLookup(users = {}, mentionHints = {}) {
  const map = new Map();
  const addCandidates = (uid, value) => {
    if (!uid || !value) return;
    const rawParts = value.match(/[A-Za-z0-9]+/g) || [];
    const candidates = new Set([value, value.replace(/\s+/g, '')]);
    rawParts.forEach((p) => candidates.add(p));
    if (rawParts.length >= 2) {
      const first = rawParts[0];
      const last = rawParts[rawParts.length - 1];
      if (first && last) candidates.add(first + last[0]);
    }
    for (const candidate of candidates) {
      const norm = normalizeMentionToken(candidate);
      if (!norm) continue;
      const existing = map.get(norm);
      if (!existing) map.set(norm, uid);
      else if (existing !== uid) map.set(norm, null);
    }
  };
  for (const [uid, name] of Object.entries(users || {})) {
    addCandidates(uid, name);
  }
  for (const [uid, hints] of Object.entries(mentionHints || {})) {
    if (!Array.isArray(hints)) continue;
    for (const hint of hints) addCandidates(uid, hint);
  }
  return map;
}

function ensureMentionLookup() {
  if (!mentionLookupDirty && mentionLookupCache) return mentionLookupCache;
  const users = { ...cachedUserMap, ...(lastRenderData?.users || {}) };
  const mentionHints = { ...cachedUserMentionHints, ...(lastRenderData?.userMentionHints || {}) };
  if (Object.keys(users).length === 0 && Object.keys(mentionHints).length === 0) {
    mentionLookupCache = null;
    mentionLookupDirty = false;
    return null;
  }
  mentionLookupCache = buildMentionLookup(users, mentionHints);
  mentionLookupDirty = false;
  return mentionLookupCache;
}

function convertUserMentions(text) {
  if (!text) return text;
  const lookup = ensureMentionLookup();
  if (!lookup || lookup.size === 0) return text;
  return text.replace(/@([A-Za-z0-9._'-]+)/g, (match, rawName, offset, full) => {
    const prevChar = offset > 0 ? full[offset - 1] : '';
    if (prevChar === '<' || (prevChar && /[A-Za-z0-9._-]/.test(prevChar))) return match;
    if (RESERVED_MENTIONS.has(rawName.toLowerCase())) return match;
    const norm = normalizeMentionToken(rawName);
    if (!norm) return match;
    const userId = lookup.get(norm);
    if (!userId) return match;
    return `<@${userId}>`;
  });
}

function resetThreadUnreadIndex() {
  threadUnreadIndex = null;
  threadUnreadIndexSource = null;
}

function ensureThreadUnreadIndex(data) {
  if (!data) return new Map();
  if (threadUnreadIndex && threadUnreadIndexSource === data) return threadUnreadIndex;
  const map = new Map();
  for (const t of data.threads || []) {
    if (!t.channel_id || !t.ts) continue;
    map.set(`${t.channel_id}:${t.ts}`, t.unread_replies || []);
  }
  threadUnreadIndex = map;
  threadUnreadIndexSource = data;
  return map;
}

function parseThreadTsValue(ts) {
  const num = parseFloat(ts);
  return Number.isFinite(num) ? num : 0;
}

function countNewerThreadReplies(data, channelId, threadTs, afterTs) {
  if (!data || !channelId || !threadTs || !afterTs) return 0;
  const index = ensureThreadUnreadIndex(data);
  const replies = index.get(`${channelId}:${threadTs}`);
  if (!replies || replies.length === 0) return 0;
  const afterVal = parseThreadTsValue(afterTs);
  let count = 0;
  for (const r of replies) {
    if (parseThreadTsValue(r.ts) > afterVal) count++;
  }
  return count;
}
let replyRequestId = 0;

bodyEl.addEventListener('click', (e) => {
  // Lightbox: intercept clicks on media thumbnails
  const thumb = e.target.closest('.file-thumb[data-lb-url]');
  if (thumb) {
    e.preventDefault();
    const container = thumb.closest('.msg-files');
    const allThumbs = container ? [...container.querySelectorAll('.file-thumb[data-lb-url]')] : [thumb];
    const items = allThumbs.map(el => ({ url: el.dataset.lbUrl, type: el.dataset.lbType || 'image' }));
    const idx = allThumbs.indexOf(thumb);
    lbShow(items, idx >= 0 ? idx : 0);
    return;
  }

  // Voice message play button
  const voiceBtn = e.target.closest('.voice-play-btn');
  if (voiceBtn) {
    e.preventDefault();
    const url = voiceBtn.dataset.voiceUrl;
    if (!url) return;
    const existing = voiceBtn.closest('.voice-msg')?.querySelector('audio');
    if (existing) { existing.paused ? existing.play() : existing.pause(); return; }
    const audio = new Audio(url);
    audio.className = 'voice-audio';
    voiceBtn.closest('.voice-msg').appendChild(audio);
    audio.play();
    voiceBtn.textContent = '\u23F8';
    audio.addEventListener('pause', () => { voiceBtn.textContent = '\u25B6'; });
    audio.addEventListener('play', () => { voiceBtn.textContent = '\u23F8'; });
    audio.addEventListener('ended', () => { voiceBtn.textContent = '\u25B6'; });
    return;
  }

  // Let links in messages open normally
  if (e.target.closest('a[href]')) return;

  const completeBtn = e.target.closest('.action-complete-saved');
  if (completeBtn) {
    if (completeBtn.dataset.pending) return;
    completeBtn.dataset.pending = 'true';
    const { itemId, ts } = completeBtn.dataset;
    const itemEl = completeBtn.closest('.saved-item');
    const requestId = `complete_${Date.now()}`;
    if (itemEl) itemEl.dataset.completeRequestId = requestId;
    window.postMessage({ type: `${FSLACK}:completeSaved`, item_id: itemId, ts, requestId }, '*');
    if (itemEl) { itemEl.style.transition = 'opacity 0.3s'; itemEl.style.opacity = '0.3'; }
    return;
  }


  // VIP section lazy-load toggle
  const vipToggle = e.target.closest('#vip-toggle');
  if (vipToggle) {
    const vipItems = shadow.getElementById('vip-items');
    if (!vipItems) return;
    const isExpanded = vipItems.style.display !== 'none';
    if (isExpanded) {
      vipItems.style.display = 'none';
      vipToggle.textContent = 'Creep on VIPs ↓';
    } else {
      vipItems.style.display = '';
      vipToggle.textContent = 'Creep on VIPs ↑';
      if (!vipItems.dataset.loaded) {
        vipItems.innerHTML = '<div style="padding:8px 24px;font-size:12px;color:#3d3f42">Loading VIP activity...</div>';
        window.postMessage({ type: `${FSLACK}:fetchVips` }, '*');
        kickoffVipSection(lastRenderData);
      }
    }
    return;
  }

  // Permalink: click username to navigate Slack in-place
  const userEl = e.target.closest('.item-user[data-channel]');
  if (userEl) {
    e.preventDefault();
    const { channel, ts } = userEl.dataset;
    navigateSlack(channel, ts);
    return;
  }

  // Permalink: click timestamp to navigate Slack in-place
  const timeEl = e.target.closest('.msg-time[data-channel], .item-time[data-channel]');
  if (timeEl) {
    e.preventDefault();
    const { channel, ts } = timeEl.dataset;
    navigateSlack(channel, ts);
    return;
  }

  // Thread badge: expand replies inline (shift/meta-click opens in new tab)
  const threadBadgeEl = e.target.closest('.msg-thread-badge');
  if (threadBadgeEl) {
    const { channel, ts, truncId, containerId } = threadBadgeEl.dataset;

    // Expand truncated text if this badge merged "See more"
    // Modifier click → navigate Slack in-place
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.button === 1) {
      navigateSlack(channel, ts);
      return;
    }

    const container = findThreadContainer(channel, ts, containerId);
    if (!container) return;

    // Already loaded → toggle visibility (including truncated text)
    if (threadBadgeEl.classList.contains('expanded')) {
      const isVisible = container.style.display !== 'none';
      container.style.display = isVisible ? 'none' : '';
      if (truncId) {
        const shortEl = shadow.getElementById(`${truncId}-short`);
        const fullEl = shadow.getElementById(`${truncId}-full`);
        const filesEl = shadow.getElementById(`${truncId}-files`);
        if (shortEl && fullEl) {
          shortEl.style.display = isVisible ? '' : 'none';
          fullEl.style.display = isVisible ? 'none' : '';
        }
        if (filesEl) filesEl.style.display = isVisible ? 'none' : '';
      }
      const n = parseInt(container.dataset.count, 10) || 0;
      updateThreadBadgeLabel(threadBadgeEl, n, !isVisible);
      return;
    }

    // Loading in progress → ignore
    if (threadBadgeEl.classList.contains('loading')) return;

    // First click → expand truncated text + fetch replies
    if (truncId) {
      const shortEl = shadow.getElementById(`${truncId}-short`);
      const fullEl = shadow.getElementById(`${truncId}-full`);
      const filesEl = shadow.getElementById(`${truncId}-files`);
      if (shortEl && fullEl) { shortEl.style.display = 'none'; fullEl.style.display = ''; }
      if (filesEl) filesEl.style.display = '';
    }
    threadBadgeEl.classList.add('loading');
    threadBadgeEl.textContent = 'Loading...';
    const reqId = `thread_${++replyRequestId}`;
    threadBadgeEl.dataset.requestId = reqId;
    window.postMessage({ type: `${FSLACK}:fetchReplies`, channel, ts, requestId: reqId }, '*');
    return;
  }

  // Channel name: navigate Slack in-place
  const channelEl = e.target.closest('.item-channel[data-channel]');
  if (channelEl) {
    const { channel } = channelEl.dataset;
    navigateSlack(channel, null);
    return;
  }

  // See more / See less toggle
  const seeMore = e.target.closest('.see-more');
  if (seeMore) {
    const id = seeMore.dataset.truncId;
    const shortEl = shadow.getElementById(`${id}-short`);
    const fullEl = shadow.getElementById(`${id}-full`);
    const filesEl = shadow.getElementById(`${id}-files`);
    if (shortEl && fullEl) { shortEl.style.display = 'none'; fullEl.style.display = ''; }
    if (filesEl) filesEl.style.display = '';
    return;
  }
  const seeLess = e.target.closest('.see-less');
  if (seeLess) {
    const id = seeLess.dataset.truncId;
    const shortEl = shadow.getElementById(`${id}-short`);
    const fullEl = shadow.getElementById(`${id}-full`);
    const filesEl = shadow.getElementById(`${id}-files`);
    if (shortEl && fullEl) { shortEl.style.display = ''; fullEl.style.display = 'none'; }
    if (filesEl) filesEl.style.display = 'none';
    return;
  }

  // Mark all read / undo
  const markAll = e.target.closest('.mark-all-read');
  if (markAll) {
    if (markAll.classList.contains('done')) {
      const { channel, ts, threadTs } = markAll.dataset;
      markAll.textContent = '...';
      markAll.classList.remove('done');
      window.postMessage({ type: `${FSLACK}:markUnread`, channel, ts, thread_ts: threadTs, requestId: `unread_${Date.now()}` }, '*');
      markAll.dataset.pending = 'true';
    } else if (!markAll.dataset.pending) {
      const { channel, ts, threadTs } = markAll.dataset;
      markAll.textContent = '...';
      window.postMessage({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, requestId: `readall_${Date.now()}` }, '*');
      markAll.dataset.pending = 'true';
    }
    return;
  }

  // Reaction action (toggle)
  const reactBtn = e.target.closest('.action-react');
  if (reactBtn && !reactBtn.dataset.pending) {
    const { channel, ts, emoji } = reactBtn.dataset;
    if (reactBtn.classList.contains('reacted')) {
      reactBtn.style.opacity = '0.4';
      reactBtn.classList.remove('reacted');
      const requestId = `unreact_${Date.now()}_${++reactionRequestCounter}`;
      pendingUnreactButtons[requestId] = reactBtn;
      window.postMessage({ type: `${FSLACK}:removeReaction`, channel, ts, emoji, requestId }, '*');
      reactBtn.dataset.pending = requestId;
      reactBtn.dataset.pendingKind = 'unreact';
    } else {
      reactBtn.style.opacity = '0.4';
      const requestId = `react_${Date.now()}_${++reactionRequestCounter}`;
      pendingReactButtons[requestId] = reactBtn;
      window.postMessage({ type: `${FSLACK}:addReaction`, channel, ts, emoji, requestId }, '*');
      reactBtn.dataset.pending = requestId;
      reactBtn.dataset.pendingKind = 'react';
    }
    return;
  }

  // Save / unsave toggle
  const saveBtn = e.target.closest('.action-save');
  if (saveBtn) {
    const { channel, ts } = saveBtn.dataset;
    const key = `${channel}:${ts}`;
    const svgPath = saveBtn.querySelector('svg path');
    if (saveBtn.classList.contains('saved')) {
      // Unsave
      saveBtn.classList.remove('saved');
      saveBtn.title = 'Save';
      if (svgPath) svgPath.setAttribute('fill', 'none');
      savedMsgKeys.delete(key);
      chrome.storage.local.set({ fslackSavedMsgs: [...savedMsgKeys] });
      window.postMessage({ type: `${FSLACK}:unsaveMessage`, channel, ts, requestId: `unsave_${Date.now()}` }, '*');
    } else {
      // Save
      saveBtn.classList.add('saved');
      saveBtn.title = 'Saved';
      if (svgPath) svgPath.setAttribute('fill', 'currentColor');
      savedMsgKeys.add(key);
      chrome.storage.local.set({ fslackSavedMsgs: [...savedMsgKeys] });
      window.postMessage({ type: `${FSLACK}:saveMessage`, channel, ts, requestId: `save_${Date.now()}` }, '*');
      // Also mark as read
      const markBtn = saveBtn.closest('.item')?.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (markBtn) markBtn.click();
    }
    return;
  }

  // Reply to individual message (threaded reply from gutter)
  const msgReplyBtn = e.target.closest('.action-msg-reply');
  if (msgReplyBtn) {
    const msgRow = msgReplyBtn.closest('.msg-row');
    if (!msgRow || msgRow.nextElementSibling?.classList.contains('reply-form')) return;
    const { channel, ts } = msgReplyBtn.dataset;
    const form = document.createElement('div');
    form.className = 'reply-form';
    form.innerHTML = `<textarea class="reply-input" rows="1" placeholder="Reply in thread... (⌘Enter to send)"></textarea><button class="reply-send">Send</button>`;
    msgRow.insertAdjacentElement('afterend', form);
    const input = form.querySelector('.reply-input');
    for (const evt of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut', 'input']) {
      input.addEventListener(evt, (ev) => ev.stopPropagation());
    }
    input.focus();
    function autoResize() {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    }
    input.addEventListener('input', autoResize);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && input.value.trim()) {
        ev.preventDefault();
        sendReply(form, channel, ts, input.value.trim());
      }
      if (ev.key === 'Escape') form.remove();
    });
    form.querySelector('.reply-send').addEventListener('click', () => {
      if (input.value.trim()) sendReply(form, channel, ts, input.value.trim());
    });
    return;
  }

  // Reply action (in item-actions)
  const replyBtn = e.target.closest('.action-reply');
  if (replyBtn) {
    const itemActions = replyBtn.closest('.item-actions');
    if (!itemActions || itemActions.nextElementSibling?.classList.contains('reply-form')) return;
    const { channel, ts, dm } = replyBtn.dataset;
    const isDm = dm === 'true';
    const form = document.createElement('div');
    form.className = 'reply-form';
    const placeholder = isDm ? 'Send a DM... (⌘Enter to send)' : 'Reply... (⌘Enter to send)';
    form.innerHTML = `<textarea class="reply-input" rows="1" placeholder="${placeholder}"></textarea><button class="reply-send">Send</button>`;
    itemActions.insertAdjacentElement('afterend', form);
    const input = form.querySelector('.reply-input');
    for (const evt of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut', 'input']) {
      input.addEventListener(evt, (ev) => ev.stopPropagation());
    }
    input.focus();
    function autoResize() {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    }
    input.addEventListener('input', autoResize);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && input.value.trim()) {
        ev.preventDefault();
        sendReply(form, channel, isDm ? null : ts, input.value.trim());
      }
      if (ev.key === 'Escape') form.remove();
    });
    form.querySelector('.reply-send').addEventListener('click', () => {
      if (input.value.trim()) sendReply(form, channel, isDm ? null : ts, input.value.trim());
    });
    return;
  }

  // Mute thread (also mark as read)
  const muteBtn = e.target.closest('.action-mute');
  if (muteBtn && !muteBtn.dataset.pending) {
    const { channel, threadTs } = muteBtn.dataset;
    muteBtn.textContent = '...';
    muteBtn.dataset.pending = 'true';
    const markAllBtn = muteBtn.closest('.item-actions')?.querySelector('.mark-all-read')
      || muteBtn.closest('.item')?.querySelector('.mark-all-read');
    if (markAllBtn && !markAllBtn.classList.contains('done') && !markAllBtn.dataset.pending) {
      const { ts, threadTs: tTs } = markAllBtn.dataset;
      markAllBtn.textContent = '...';
      markAllBtn.dataset.pending = 'true';
      window.postMessage({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: tTs, requestId: `readall_${Date.now()}` }, '*');
    }
    muteThreadLocally(channel, threadTs);
    const itemEl = muteBtn.closest('.item');
    if (itemEl) {
      itemEl.style.opacity = '0.3';
      setTimeout(() => itemEl.remove(), 150);
    }
    window.postMessage({ type: `${FSLACK}:muteThread`, channel, thread_ts: threadTs, requestId: `mute_${Date.now()}` }, '*');
    return;
  }

  // Mute channel
  const muteChannelBtn = e.target.closest('.action-mute-channel');
  if (muteChannelBtn && !muteChannelBtn.dataset.pending) {
    const { channel } = muteChannelBtn.dataset;
    muteChannelBtn.textContent = '...';
    muteChannelBtn.dataset.pending = 'true';
    const markAllBtn = muteChannelBtn.closest('.item-actions')?.querySelector('.mark-all-read')
      || muteChannelBtn.closest('.item')?.querySelector('.mark-all-read');
    if (markAllBtn && !markAllBtn.classList.contains('done') && !markAllBtn.dataset.pending) {
      const { ts, threadTs } = markAllBtn.dataset;
      markAllBtn.textContent = '...';
      markAllBtn.dataset.pending = 'true';
      window.postMessage({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, requestId: `readall_${Date.now()}` }, '*');
    }
    window.postMessage({ type: `${FSLACK}:muteChannel`, channel, requestId: `mutech_${Date.now()}` }, '*');
    return;
  }

  // "mark as digest"
  const markDigestBtn = e.target.closest('.action-mark-digest');
  if (markDigestBtn && !markDigestBtn.dataset.pending) {
    const { channel, channelName } = markDigestBtn.dataset;
    markDigestBtn.dataset.pending = 'true';
    markDigestBtn.textContent = '...';
    digestChannels[channel] = channelName || channel;
    delete noiseChannels[channel];
    chrome.storage.local.set({ fslackDigestChannels: digestChannels, fslackNoiseChannels: noiseChannels }, () => {
      markDigestBtn.closest('.item')?.remove();
      cachedView = null;
      chrome.storage.local.remove('fslackViewCache');
    });
    return;
  }

  // "always noise"
  const alwaysNoiseBtn = e.target.closest('.action-always-noise');
  if (alwaysNoiseBtn && !alwaysNoiseBtn.dataset.pending) {
    const { channel, channelName } = alwaysNoiseBtn.dataset;
    alwaysNoiseBtn.dataset.pending = 'true';
    alwaysNoiseBtn.textContent = '...';
    noiseChannels[channel] = channelName || channel;
    delete neverNoiseChannels[channel];
    chrome.storage.local.set({ fslackNoiseChannels: noiseChannels, fslackNeverNoiseChannels: neverNoiseChannels }, () => {
      alwaysNoiseBtn.closest('.item')?.remove();
      cachedView = null;
      chrome.storage.local.remove('fslackViewCache');
    });
    return;
  }

  // "never noise"
  const neverNoiseBtn = e.target.closest('.action-never-noise');
  if (neverNoiseBtn && !neverNoiseBtn.dataset.pending) {
    const { channel, channelName } = neverNoiseBtn.dataset;
    neverNoiseBtn.dataset.pending = 'true';
    neverNoiseBtn.textContent = '...';
    neverNoiseChannels[channel] = channelName || channel;
    delete noiseChannels[channel];
    chrome.storage.local.set({ fslackNeverNoiseChannels: neverNoiseChannels, fslackNoiseChannels: noiseChannels }, () => {
      neverNoiseBtn.closest('.item')?.remove();
      cachedView = null;
      chrome.storage.local.remove('fslackViewCache');
    });
    return;
  }

  // Send reply via postMessage
  const sendBtn = e.target.closest('.reply-send');
  if (sendBtn) return; // handled by direct listener above

  // Mark VIP as seen — hide their messages until new ones arrive
  const vipSeenBtn = e.target.closest('.vip-mark-seen');
  if (vipSeenBtn) {
    const vipName = vipSeenBtn.dataset.vipName;
    const maxTs = vipSeenBtn.dataset.maxTs;
    if (vipName && maxTs) {
      vipSeenTimestamps[vipName] = maxTs;
      chrome.storage.local.set({ fslackVipSeen: vipSeenTimestamps });
      vipSeenBtn.closest('.item')?.remove();
    }
    return;
  }

  // Show/hide full messages for deep-summarized items
  const showMsgsLink = e.target.closest('.show-messages-link[data-target]');
  if (showMsgsLink) {
    const targetId = showMsgsLink.dataset.target;
    const msgsDiv = shadow.getElementById(targetId);
    if (msgsDiv) {
      // Fetch-on-demand: if replies need loading, fetch first
      if (showMsgsLink.dataset.fetchReplies && !msgsDiv.hasChildNodes()) {
        if (showMsgsLink.classList.contains('loading')) return;
        if (!showMsgsLink.dataset.showText) showMsgsLink.dataset.showText = showMsgsLink.textContent;
        showMsgsLink.classList.add('loading');
        showMsgsLink.textContent = 'Loading…';
        const channel = showMsgsLink.dataset.channel;
        const ts = showMsgsLink.dataset.ts;
        const reqId = `showrep_${++replyRequestId}`;
        const handler = (event) => {
          if (event.source !== window) return;
          if (event.data?.type !== `${FSLACK}:repliesResult`) return;
          if (event.data.requestId !== reqId) return;
          window.removeEventListener('message', handler);
          const replies = (event.data.replies || []).filter((r) => r.ts !== ts);
          let html = '';
          const rd = lastRenderData;
          for (const r of replies) {
            const userName = rd ? uname(r.user, rd.users) : r.user;
            const _lrtid = truncateId;
            const lrTextHtml = truncate(r.text, 400, rd?.users);
            const lrExtras = wrapFilesIfTruncated(_lrtid, renderFwd(r.fwd, rd?.users), renderFiles(r.files));
            html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(userName, channel, r.ts)} ${lrTextHtml}${lrExtras}${msgTime(r.ts, channel)}</div>${msgActions(channel, r.ts)}</div>`;
          }
          msgsDiv.innerHTML = html;
          msgsDiv.style.display = 'block';
          showMsgsLink.classList.remove('loading');
          showMsgsLink.textContent = showMsgsLink.dataset.showText.replace('show', 'hide').replace('↓', '↑');
        };
        window.addEventListener('message', handler);
        window.postMessage({ type: `${FSLACK}:fetchReplies`, channel, ts, requestId: reqId }, '*');
        return;
      }
      if (!showMsgsLink.dataset.showText) showMsgsLink.dataset.showText = showMsgsLink.textContent;
      if (msgsDiv.style.display === 'block') {
        msgsDiv.style.display = 'none';
        showMsgsLink.textContent = showMsgsLink.dataset.showText;
      } else {
        msgsDiv.style.display = 'block';
        showMsgsLink.textContent = showMsgsLink.dataset.showText.replace('show', 'hide').replace('↓', '↑');
      }
    }
    return;
  }

  // Mark all priority as read
  const priorityMarkRead = e.target.closest('#priority-mark-read-btn');
  if (priorityMarkRead && !priorityMarkRead.disabled) {
    const priorityItemEls = bodyEl.querySelectorAll('.item.priority-item:not(.read-done)');
    let count = 0;
    for (const item of priorityItemEls) {
      const markAll = item.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (!markAll) continue;
      const { channel, ts, threadTs } = markAll.dataset;
      markAll.textContent = '...';
      markAll.dataset.pending = 'true';
      window.postMessage({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, requestId: `readall_${Date.now()}_${count}` }, '*');
      count++;
    }
    priorityMarkRead.textContent = count > 0 ? `Marked ${count} as read` : 'Nothing to mark';
    priorityMarkRead.disabled = true;
    return;
  }

  // Mark all when-free as read
  const whenfreeMarkRead = e.target.closest('#whenfree-mark-read-btn');
  if (whenfreeMarkRead && !whenfreeMarkRead.disabled) {
    const section = shadow.getElementById('when-free-items');
    const whenfreeItemEls = section ? section.querySelectorAll('.item.when-free:not(.read-done)') : [];
    let count = 0;
    for (const item of whenfreeItemEls) {
      const markAll = item.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (!markAll) continue;
      const { channel, ts, threadTs } = markAll.dataset;
      markAll.textContent = '...';
      markAll.dataset.pending = 'true';
      window.postMessage({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, requestId: `readall_${Date.now()}_${count}` }, '*');
      count++;
    }
    whenfreeMarkRead.textContent = count > 0 ? `Marked ${count} as read` : 'Nothing to mark';
    whenfreeMarkRead.disabled = true;
    if (section?.classList.contains('expanded')) {
      const toggle = section.previousElementSibling;
      if (toggle?.classList.contains('section-toggle')) toggle.click();
    }
    return;
  }

  // Mark all digests as read
  const digestsMarkRead = e.target.closest('#digests-mark-read-btn');
  if (digestsMarkRead && !digestsMarkRead.disabled) {
    const section = shadow.getElementById('digest-items');
    const digestItemEls = section ? section.querySelectorAll('.item.noise-item:not(.read-done)') : [];
    let count = 0;
    for (const item of digestItemEls) {
      const markAll = item.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (!markAll) continue;
      const { channel, ts, threadTs } = markAll.dataset;
      markAll.textContent = '...';
      markAll.dataset.pending = 'true';
      window.postMessage({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, requestId: `readall_${Date.now()}_${count}` }, '*');
      count++;
    }
    digestsMarkRead.textContent = count > 0 ? `Marked ${count} as read` : 'Nothing to mark';
    digestsMarkRead.disabled = true;
    if (section?.classList.contains('expanded')) {
      const toggle = section.previousElementSibling;
      if (toggle?.classList.contains('section-toggle')) toggle.click();
    }
    return;
  }

  // Mark recent noise as read
  const noiseMarkRecent = e.target.closest('#noise-mark-recent-btn');
  if (noiseMarkRecent && !noiseMarkRecent.disabled) {
    const section = shadow.getElementById('noise-recent-items');
    const noiseItemEls = section ? section.querySelectorAll('.item.noise-item:not(.read-done)') : [];
    let count = 0;
    for (const item of noiseItemEls) {
      const markAll = item.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (!markAll) continue;
      const { channel, ts, threadTs } = markAll.dataset;
      markAll.textContent = '...';
      markAll.dataset.pending = 'true';
      window.postMessage({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, requestId: `readall_${Date.now()}_${count}` }, '*');
      count++;
    }
    noiseMarkRecent.textContent = count > 0 ? `Marked ${count} as read` : 'Nothing to mark';
    noiseMarkRecent.disabled = true;
    if (section?.classList.contains('expanded')) {
      const toggle = section.previousElementSibling;
      if (toggle?.classList.contains('section-toggle')) toggle.click();
    }
    return;
  }

  // Mark older noise as read
  const noiseMarkOlder = e.target.closest('#noise-mark-older-btn');
  if (noiseMarkOlder && !noiseMarkOlder.disabled) {
    const section = shadow.getElementById('noise-older-items');
    const noiseItemEls = section ? section.querySelectorAll('.item.noise-item:not(.read-done)') : [];
    let count = 0;
    for (const item of noiseItemEls) {
      const markAll = item.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (!markAll) continue;
      const { channel, ts, threadTs } = markAll.dataset;
      markAll.textContent = '...';
      markAll.dataset.pending = 'true';
      window.postMessage({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, requestId: `readall_${Date.now()}_${count}` }, '*');
      count++;
    }
    noiseMarkOlder.textContent = count > 0 ? `Marked ${count} as read` : 'Nothing to mark';
    noiseMarkOlder.disabled = true;
    if (section?.classList.contains('expanded')) {
      const toggle = section.previousElementSibling;
      if (toggle?.classList.contains('section-toggle')) toggle.click();
    }
    return;
  }

  // Bankruptcy: mark everything older than 7 days as read
  const bankruptcyBtn = e.target.closest('#bankruptcy-btn');
  if (bankruptcyBtn && !bankruptcyBtn.disabled) {
    const sevenDaysAgo = (Date.now() / 1000) - 7 * 24 * 60 * 60;
    const items = bodyEl.querySelectorAll('.item:not(.read-done)');
    let count = 0;
    for (const item of items) {
      const markAll = item.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (!markAll) continue;
      const ts = parseFloat(markAll.dataset.ts);
      if (!ts || ts >= sevenDaysAgo) continue;
      const { channel, ts: markTs, threadTs } = markAll.dataset;
      markAll.textContent = '...';
      markAll.dataset.pending = 'true';
      window.postMessage({ type: `${FSLACK}:markRead`, channel, ts: markTs, thread_ts: threadTs, requestId: `readall_${Date.now()}_${count}` }, '*');
      count++;
    }
    bankruptcyBtn.textContent = count > 0
      ? `Declared bankruptcy on ${count} item${count === 1 ? '' : 's'}`
      : 'Nothing older than 7 days to clear';
    bankruptcyBtn.disabled = true;
    return;
  }

  // Seen replies lazy load / chunked expansion
  const toggle = e.target.closest('.seen-replies-toggle');
  if (toggle) {
    handleSeenRepliesToggleClick(toggle);
    return;
  }
});

// Click-to-focus: move keyboard nav to clicked item
bodyEl.addEventListener('click', (e) => {
  const nav = e.target.closest('.msg-row, .item, .section-toggle');
  if (!nav) return;
  // Prefer the most specific navigable element (msg-row inside item)
  const target = nav.classList.contains('item')
    ? (nav.querySelector('.msg-row') ? e.target.closest('.msg-row') || nav : nav)
    : nav;
  const els = getNavigableElements();
  const idx = els.indexOf(target);
  if (idx >= 0) focusItem(idx);
});

function seenRepliesLabel(count) {
  return count === 1 ? 'reply' : 'replies';
}

function renderNextSeenRepliesChunk(toggle, container) {
  const chunkData = toggle._seenRepliesData;
  if (!chunkData) return;

  const start = chunkData.rendered || 0;
  const end = Math.min(chunkData.replies.length, start + SEEN_REPLIES_CHUNK);
  if (start === end) return;

  const data = lastRenderData;
  let html = '';
  const segment = chunkData.replies.slice(start, end);
  if (start === 0) container.innerHTML = '';
  for (const r of segment) {
    const userName = data ? uname(r.user, data.users) : r.user;
    const _srtid = truncateId;
    const srTextHtml = truncate(r.text, 400, data?.users);
    const srExtras = wrapFilesIfTruncated(_srtid, renderFwd(r.fwd, data?.users), renderFiles(r.files));
    html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(userName, toggle.dataset.channel, r.ts)} ${srTextHtml}${srExtras}${msgTime(r.ts, toggle.dataset.channel)}</div>${msgActions(toggle.dataset.channel, r.ts)}</div>`;
  }
  container.insertAdjacentHTML('beforeend', html);
  container.style.display = '';
  chunkData.rendered = end;

  const total = chunkData.replies.length;
  const remaining = total - chunkData.rendered;
  toggle.dataset.totalReplies = `${total}`;

  if (remaining > 0) {
    const toShow = Math.min(SEEN_REPLIES_CHUNK, remaining);
    toggle.dataset.state = 'partial';
    toggle.classList.remove('expanded');
    toggle.textContent = `Show ${toShow} more earlier ${seenRepliesLabel(toShow)}`;
  } else {
    toggle.dataset.state = 'full';
    toggle.classList.add('expanded');
    toggle.textContent = `Hide ${total} earlier ${seenRepliesLabel(total)}`;
  }
}

function handleSeenRepliesToggleClick(toggle) {
  if (toggle.dataset.state === 'empty' || toggle.classList.contains('loading')) return;

  const channel = toggle.dataset.channel;
  const ts = toggle.dataset.ts;
  if (!channel || !ts) return;
  const container = bodyEl.querySelector(`.seen-replies-container[data-for="${channel}-${ts}"]`);
  if (!container) return;

  const chunkData = toggle._seenRepliesData;
  if (chunkData) {
    const total = chunkData.replies.length;
    if (toggle.dataset.state === 'collapsed') {
      container.style.display = '';
      toggle.dataset.state = 'full';
      toggle.classList.add('expanded');
      toggle.textContent = `Hide ${total} earlier ${seenRepliesLabel(total)}`;
      return;
    }
    if (chunkData.rendered < total) {
      renderNextSeenRepliesChunk(toggle, container);
      return;
    }
    const isVisible = container.style.display !== 'none';
    if (isVisible) {
      container.style.display = 'none';
      toggle.dataset.state = 'collapsed';
      toggle.classList.remove('expanded');
      toggle.textContent = `${total} earlier ${seenRepliesLabel(total)}`;
    } else {
      container.style.display = '';
      toggle.dataset.state = 'full';
      toggle.classList.add('expanded');
      toggle.textContent = `Hide ${total} earlier ${seenRepliesLabel(total)}`;
    }
    return;
  }

  toggle.classList.add('loading');
  toggle.dataset.state = 'loading';
  toggle.textContent = 'Loading...';

  const reqId = `reply_${++replyRequestId}`;
  toggle.dataset.requestId = reqId;
  window.postMessage({ type: `${FSLACK}:fetchReplies`, channel, ts, requestId: reqId }, '*');
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== `${FSLACK}:repliesResult`) return;

  const { requestId, replies } = event.data;

  // Populate reaction map for dynamically fetched replies
  for (const r of replies || []) {
    if (r.my_reactions?.length) {
      // Infer channel from the toggle or badge that requested this
      const el = bodyEl.querySelector(`[data-request-id="${requestId}"]`);
      const ch = el?.dataset.channel;
      if (ch) myReactionsMap[`${ch}:${r.ts}`] = r.my_reactions;
    }
  }

  // ── Seen-replies toggle (thread items) ──
  const toggle = bodyEl.querySelector(`.seen-replies-toggle[data-request-id="${requestId}"]`);
  if (toggle) {
    const channel = toggle.dataset.channel;
    const ts = toggle.dataset.ts;
    const container = bodyEl.querySelector(`.seen-replies-container[data-for="${channel}-${ts}"]`);
    if (!container) return;

    const data = lastRenderData;
    const unreadTs = new Set((toggle.dataset.unreadTs || '').split(',').filter(Boolean));

    // Show only seen replies (exclude unread ones already displayed below)
    const seenReplies = replies.filter((r) => !unreadTs.has(r.ts));

    toggle.classList.remove('loading');
    delete toggle.dataset.requestId;

    if (seenReplies.length === 0) {
      container.innerHTML = '';
      toggle.dataset.state = 'empty';
      toggle.classList.remove('expanded');
      toggle.textContent = 'No earlier replies';
      return;
    }

    toggle._seenRepliesData = { replies: seenReplies, rendered: 0 };
    container.innerHTML = '';
    container.style.display = '';
    renderNextSeenRepliesChunk(toggle, container);
    return;
  }

  // ── Thread badge inline expand (channel posts) ──
  const badge = bodyEl.querySelector(`.msg-thread-badge[data-request-id="${requestId}"]`);
  if (badge) {
    const channel = badge.dataset.channel;
    const ts = badge.dataset.ts;
    const container = findThreadContainer(channel, ts, badge.dataset.containerId);
    if (!container) return;

    const data = lastRenderData;
    // conversations.replies returns root message at index 0 — skip it
    let threadReplies = replies.filter((r) => r.ts !== ts);
    if (badge.dataset.mode === 'newer') {
      const afterTs = badge.dataset.afterTs;
      const afterVal = parseThreadTsValue(afterTs);
      threadReplies = threadReplies.filter((r) => parseThreadTsValue(r.ts) > afterVal);
    }

    let html = '';
    for (const r of threadReplies) {
      const userName = data ? uname(r.user, data.users) : r.user;
      const _trtid = truncateId;
      const trTextHtml = truncate(r.text, 400, data?.users);
      const trExtras = wrapFilesIfTruncated(_trtid, renderFwd(r.fwd, data?.users), renderFiles(r.files));
      html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(userName, channel, r.ts)} ${trTextHtml}${trExtras}${msgTime(r.ts, channel)}</div>${msgActions(channel, r.ts)}</div>`;
    }
    container.innerHTML = html;
    container.style.display = '';
    container.dataset.count = threadReplies.length;

    badge.classList.remove('loading');
    const n = threadReplies.length;
    if (n === 0) {
      badge.classList.remove('expanded');
      updateThreadBadgeLabel(badge, 0, false);
      return;
    }
    badge.classList.add('expanded');
    updateThreadBadgeLabel(badge, n, true);
    return;
  }
});

// ── Send reply helper ──
function autoMarkItemRead(item, { requireThread = false, overrideTs } = {}) {
  if (!item) return;
  const markAll = item.querySelector('.mark-all-read');
  if (!markAll) return;
  if (requireThread && !markAll.dataset.threadTs) return;
  if (markAll.classList.contains('done') || markAll.dataset.pending) return;
  const { channel, ts, threadTs } = markAll.dataset;
  const markTs = overrideTs || ts;
  if (overrideTs) markAll.dataset.ts = markTs;
  markAll.textContent = '...';
  markAll.dataset.pending = 'true';
  window.postMessage({ type: `${FSLACK}:markRead`, channel, ts: markTs, thread_ts: threadTs, requestId: `readall_${Date.now()}` }, '*');
}

function sendReply(form, channel, threadTs, text) {
  const input = form.querySelector('.reply-input');
  const btn = form.querySelector('.reply-send');
  const finalText = convertUserMentions(text);
  input.value = finalText;
  input.disabled = true;
  btn.disabled = true;
  btn.textContent = '...';
  const reqId = `post_${Date.now()}`;
  form.dataset.requestId = reqId;
  window.postMessage({ type: `${FSLACK}:postReply`, channel, thread_ts: threadTs, text: finalText, requestId: reqId }, '*');
}

// ── Action result listeners ──
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data || {};

  if (msg.type === `${FSLACK}:reactResult`) {
    const btn = (msg.requestId && pendingReactButtons[msg.requestId])
      || bodyEl.querySelector('.action-react[data-pending-kind="react"]');
    if (msg.requestId) delete pendingReactButtons[msg.requestId];
    if (btn) {
      delete btn.dataset.pending;
      delete btn.dataset.pendingKind;
      btn.style.opacity = '';
      if (msg.ok) {
        btn.classList.add('reacted');
        if (btn.dataset.emoji === '+1' || btn.dataset.emoji === 'yellow_heart') {
          autoMarkItemRead(btn.closest('.item'), { requireThread: true });
        }
      }
    }
  }

  if (msg.type === `${FSLACK}:unreactResult`) {
    const btn = (msg.requestId && pendingUnreactButtons[msg.requestId])
      || bodyEl.querySelector('.action-react[data-pending-kind="unreact"]');
    if (msg.requestId) delete pendingUnreactButtons[msg.requestId];
    if (btn) {
      delete btn.dataset.pending;
      delete btn.dataset.pendingKind;
      btn.style.opacity = '';
      if (!msg.ok) btn.classList.add('reacted'); // revert on failure
    }
  }

  if (msg.type === `${FSLACK}:saveResult`) {
    // DOM already updated on click; nothing to do here
  }

  if (msg.type === `${FSLACK}:completeSavedResult`) {
    const { requestId, ok } = msg;
    const itemEl = shadow.querySelector(`.saved-item[data-complete-request-id="${requestId}"]`);
    if (ok) {
      if (itemEl) itemEl.remove();
      const toggle = shadow.getElementById('saved-items-toggle');
      const list = shadow.getElementById('saved-items-list');
      if (toggle && list) {
        const count = list.querySelectorAll('.item').length;
        if (count === 0) {
          list.closest('.priority-section')?.style.setProperty('display', 'none');
        } else {
          toggle.textContent = toggle.textContent.replace(/\d+/, count);
        }
      }
    } else {
      if (itemEl) { itemEl.style.opacity = ''; itemEl.dataset.completeRequestId = ''; }
      const btn = itemEl?.querySelector('.action-complete-saved');
      if (btn) delete btn.dataset.pending;
    }
  }

  if (msg.type === `${FSLACK}:markReadResult`) {
    if (msg.ok) { removeCachedItem(msg.channel, msg.thread_ts); }
    const markAll = bodyEl.querySelector('.mark-all-read[data-pending="true"]');
    if (markAll) {
      delete markAll.dataset.pending;
      if (msg.ok) {
        markAll.textContent = 'undo';
        markAll.classList.add('done');
        const item = markAll.closest('.item');
        if (item) item.classList.add('read-done');
      } else { markAll.textContent = 'mark read'; }
    }
  }

  if (msg.type === `${FSLACK}:markUnreadResult`) {
    const markAll = bodyEl.querySelector('.mark-all-read[data-pending="true"]');
    if (markAll) {
      delete markAll.dataset.pending;
      if (msg.ok) {
        markAll.textContent = 'mark read';
        const item = markAll.closest('.item');
        if (item) item.classList.remove('read-done');
      } else {
        markAll.textContent = 'undo';
        markAll.classList.add('done');
      }
    }
  }

  if (msg.type === `${FSLACK}:muteThreadResult`) {
    const muteBtn = bodyEl.querySelector('.action-mute[data-pending="true"]');
    if (muteBtn) delete muteBtn.dataset.pending;
    if (!msg.ok) console.warn('[fslack] Slack muteThread failed; keeping local mute only');
  }

  if (msg.type === `${FSLACK}:muteChannelResult`) {
    const muteBtn = bodyEl.querySelector('.action-mute-channel[data-pending="true"]');
    if (muteBtn) {
      if (msg.ok) {
        muteBtn.closest('.item')?.remove();
      } else {
        delete muteBtn.dataset.pending;
        muteBtn.textContent = 'mute channel';
      }
    }
  }

  if (msg.type === `${FSLACK}:postReplyResult`) {
    const form = bodyEl.querySelector(`.reply-form[data-request-id="${msg.requestId}"]`);
    if (!form) return;
    if (msg.ok) {
      const text = form.querySelector('.reply-input').value;
      const item = form.closest('.item');
      const isMsgLevel = form.previousElementSibling?.classList.contains('msg-row');
      const replyHtml = isMsgLevel
        ? `<div class="msg-row"><div class="msg-content item-reply" style="color:#1d9bd1"><span class="item-user">You:</span> ${escapeHtml(text)}</div></div>`
        : `<div class="item-reply" style="color:#1d9bd1"><span class="item-user">You:</span> ${escapeHtml(text)}</div>`;
      form.insertAdjacentHTML('beforebegin', replyHtml);
      // Keep form open for continued replies — clear, re-enable, re-focus
      const inp = form.querySelector('.reply-input');
      const btn = form.querySelector('.reply-send');
      inp.value = '';
      inp.disabled = false;
      inp.style.height = 'auto';
      btn.disabled = false;
      btn.textContent = 'Send';
      inp.focus();
      // Auto mark as read, same flow as clicking "mark read" (undo works for free)
      autoMarkItemRead(item, { overrideTs: msg.ts });
    } else {
      const btn = form.querySelector('.reply-send');
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Send'; btn.disabled = false; form.querySelector('.reply-input').disabled = false; }, 2000);
    }
  }
});

// ── API key inline prompt ──
function showApiKeyPrompt(rawData) {
  bodyEl.innerHTML = `
    <div class="api-key-form">
      <div style="color: #fff; font-size: 16px; margin-bottom: 12px;">Claude API Key Required</div>
      <div style="color: #ababad; font-size: 13px; margin-bottom: 16px;">
        Enter your Anthropic API key to enable smart prioritization.<br>
        Key is stored locally in your browser.
      </div>
      <input id="api-key-input" type="password" placeholder="sk-ant-..."><br>
      <div style="margin-top: 12px; display: flex; gap: 8px; justify-content: center;">
        <button id="save-key-btn">Save & Prioritize</button>
        <button id="skip-key-btn" class="secondary">Skip</button>
      </div>
    </div>`;

  // Stop Slack from hijacking keyboard events on the input
  const keyInput = shadow.getElementById('api-key-input');
  for (const evt of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut', 'input']) {
    keyInput.addEventListener(evt, (e) => e.stopPropagation());
  }

  shadow.getElementById('save-key-btn').addEventListener('click', () => {
    const key = shadow.getElementById('api-key-input').value.trim();
    if (!key) return;
    chrome.runtime.sendMessage({ type: `${FSLACK}:setApiKey`, key }, () => {
      prioritizeAndRender(rawData);
    });
  });

  shadow.getElementById('skip-key-btn').addEventListener('click', () => {
    render(rawData);
  });
}

// ── Async VIP section: wait for data, summarize, render ──
async function kickoffVipSection(data) {
  // Wait up to 3s for pendingVips to arrive from inject.js
  let vips = pendingVips;
  if (vips === null) {
    await new Promise((resolve) => {
      const deadline = Date.now() + 3000;
      const poll = setInterval(() => {
        if (pendingVips !== null || Date.now() > deadline) {
          clearInterval(poll);
          vips = pendingVips || [];
          resolve();
        }
      }, 100);
    });
  }
  if (!vips) vips = [];

  const vipArea = shadow.getElementById('vip-items');
  if (!vipArea) return;

  // Filter out messages the user has already read in that channel, or manually dismissed
  const filteredVips = vips.map((v) => ({
    ...v,
    messages: v.messages.filter((m) => {
      const seenTs = vipSeenTimestamps[v.name];
      if (seenTs && parseFloat(m.ts) <= parseFloat(seenTs)) return false;
      if (!m.channel_id || !data?.lastRead) return true;
      const lr = data.lastRead[m.channel_id];
      if (!lr) return true;
      if (parseFloat(m.ts) <= parseFloat(lr)) return false;
      return true;
    }),
  }));

  const relevantVips = filteredVips.filter((v) => v.messages.length > 0);
  if (relevantVips.length === 0) {
    vipArea.innerHTML = '';
    vipArea.dataset.loaded = '1';
    return;
  }

  // Summarize each VIP in parallel with a byte cap
  const MAX_PAYLOAD_BYTES = 2000;
  const summaries = await Promise.all(relevantVips.map(async (vip) => {
    const messages = [];
    let bytes = 0;
    for (const m of vip.messages) {
      const entry = {
        channel: m.channel_name || m.channel_id,
        text: plainTruncate(textWithFwd(m.text, m.fwd), 150, data?.users || {}),
        ts: m.ts,
      };
      const s = JSON.stringify(entry);
      if (bytes + s.length > MAX_PAYLOAD_BYTES) break;
      messages.push(entry);
      bytes += s.length;
    }
    let response;
    try {
      response = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: `${FSLACK}:summarizeVip`, data: { name: vip.name, messages } }, resolve)
      );
    } catch {
      response = { error: 'send failed' };
    }
    return { vip, result: response?.summary };
  }));

  let vipHtml = '<section class="priority-section"><h2 style="color:#ab7ae0">Creep on VIPs</h2>';
  let hasContent = false;
  for (let i = 0; i < summaries.length; i++) {
    const { vip, result } = summaries[i];
    if (!result?.relevant) continue;
    hasContent = true;
    const latestTs = vip.messages[0]?.ts;
    const msgId = `vip-msgs-${i}`;
    // Group messages by channel
    const byChannel = new Map();
    for (const m of vip.messages) {
      const key = m.channel_id || m.channel_name || '?';
      if (!byChannel.has(key)) byChannel.set(key, { name: m.channel_name || '?', permalink: m.permalink, messages: [] });
      byChannel.get(key).messages.push(m);
    }
    let messagesHtml = '';
    for (const [, ch] of byChannel) {
      const channelLabel = ch.permalink
        ? `<a href="${escapeHtml(ch.permalink.replace(/\/p\d+$/, ''))}" target="_blank" style="color:#616061">#${escapeHtml(ch.name)}</a>`
        : `#${escapeHtml(ch.name)}`;
      messagesHtml += `<div style="margin-top:4px"><span style="font-size:11px">${channelLabel}</span><ul style="margin:2px 0 0;padding-left:18px">`;
      for (const m of ch.messages) {
        messagesHtml += `<li class="item-text" style="margin:1px 0">${formatSlackHtml(m.text || '', data?.users)}${renderFiles(m.files)}</li>`;
      }
      messagesHtml += '</ul></div>';
    }
    vipHtml += `<div class="item vip-item">
      <div class="item-left">
        <span class="item-channel">${escapeHtml(vip.name)}</span>
        <span class="item-time">${formatTime(latestTs)}</span>
      </div>
      <div class="item-right">
        <div class="msg-row"><div class="msg-content">
          <ul class="deep-summary">${(result.bullets || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>
          <div style="display:flex;gap:12px;margin-top:6px;">
            <span class="show-messages-link" data-target="${msgId}" style="margin-top:0">show ${vip.messages.length} message${vip.messages.length === 1 ? '' : 's'} ↓</span>
            <span class="show-messages-link vip-mark-seen" data-vip-name="${escapeHtml(vip.name)}" data-max-ts="${escapeHtml(vip.messages[0]?.ts || '')}" style="margin-top:0">mark as seen</span>
          </div>
        </div></div>
        <div class="deep-messages" id="${msgId}">${messagesHtml}</div>
      </div>
    </div>`;
  }

  if (!hasContent) {
    vipArea.innerHTML = '';
    vipArea.dataset.loaded = '1';
    return;
  }
  vipHtml += '</section>';
  vipArea.innerHTML = vipHtml;
  vipArea.dataset.loaded = '1';
}

// ── Async bot thread summarization ──
function runBotThreadSummarization(whenFreeItems, data) {
  const botThreads = whenFreeItems.filter((item) => item._isBotThread && !item._botSummary);
  if (botThreads.length === 0) return;

  (async () => {
    for (const cp of botThreads) {
      const ch = data.channels[cp.channel_id] || cp.channel_id;
      const messages = cp.messages.map((m) => ({
        user: m.subtype === 'bot_message' || !m.user ? 'Bot' : uname(m.user, data.users),
        text: plainTruncate(textWithFwd(m.text, m.fwd), 400, data.users),
      }));
      let response;
      try {
        response = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: `${FSLACK}:summarizeBotThread`, data: { channel: ch, messages } }, resolve)
        );
      } catch { continue; }
      if (!response?.summary?.summary) continue;

      cp._botSummary = response.summary.summary;
      const key = `bot-thread-${cp.channel_id}-${(cp.sort_ts || '').replace('.', '_')}`;
      const itemEl = shadow.querySelector(`[data-bot-thread-key="${key}"]`);
      if (!itemEl) continue;

      // Replace loading content with summary + expandable messages
      const deepMsgId = `${key}-msgs`;
      let messagesHtml = '';
      for (const m of cp.messages) {
        const _btid = truncateId;
        const bTextHtml = truncate(m.text, 400, data.users);
        const bExtras = wrapFilesIfTruncated(_btid, renderFwd(m.fwd, data.users), renderFiles(m.files));
        messagesHtml += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' || !m.user ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${bTextHtml}${bExtras}${msgTime(m.ts, cp.channel_id)}</div>${msgActions(cp.channel_id, m.ts, { showReply: false })}</div>`;
      }
      const rightEl = itemEl.querySelector('.item-right');
      const actionsEl = itemEl.querySelector('.item-actions');
      const actionsHtml = actionsEl ? actionsEl.outerHTML : '';
      rightEl.innerHTML = `
        <div class="msg-row"><div class="msg-content">
          <div class="deep-summary">${escapeHtml(cp._botSummary)}</div>
          <div style="display:flex;gap:12px;margin-top:6px;">
            <span class="show-messages-link" data-target="${deepMsgId}" style="margin-top:0">show ${cp.messages.length} message${cp.messages.length === 1 ? '' : 's'} ↓</span>
            <span class="show-messages-link mark-all-read" data-channel="${cp.channel_id}" data-ts="${cp.messages[cp.messages.length - 1]?.ts}" style="margin-top:0">mark as read</span>
          </div>
        </div></div>
        <div class="deep-messages" id="${deepMsgId}">${messagesHtml}</div>
        ${actionsHtml}`;
    }
  })();
}

// ── Async thread reply summarization (non-DM threads meeting summary criteria) ──
function runThreadReplySummarization(allItems, data) {
  const threads = allItems.filter((item) => item._type === 'thread' && !item._threadSummary && threadNeedsSummary(item));
  if (threads.length === 0) return;

  const MAX_PAYLOAD_BYTES = 3000;

  (async () => {
    for (const t of threads) {
      const ch = data.channels[t.channel_id] || t.channel_id;
      const unread = t.unread_replies || [];
      const replies = [];
      let bytes = 0;
      for (const r of unread) {
        const entry = { user: uname(r.user, data.users), text: plainTruncate(textWithFwd(r.text, r.fwd), 400, data.users) };
        const s = JSON.stringify(entry);
        if (bytes + s.length > MAX_PAYLOAD_BYTES) break;
        bytes += s.length;
        replies.push(entry);
      }

      let response;
      try {
        response = await new Promise((resolve) =>
          chrome.runtime.sendMessage({
            type: `${FSLACK}:summarizeThreadReplies`,
            data: { channel: ch, rootUser: uname(t.root_user, data.users), rootText: plainTruncate(textWithFwd(t.root_text, t.root_fwd), 400, data.users), replies }
          }, resolve)
        );
      } catch { continue; }
      if (!response?.summary?.summary) continue;

      t._threadSummary = response.summary.summary;
      const threadKey = `thread-summary-${t.channel_id}-${(t.ts || '').replace('.', '_')}`;
      const loadingEl = shadow.getElementById(`${threadKey}-loading`);
      if (!loadingEl) continue;

      // Replace loading text with summary
      const summaryEl = document.createElement('div');
      summaryEl.className = 'deep-summary';
      summaryEl.style.cssText = 'margin:6px 0 2px';
      summaryEl.textContent = t._threadSummary;
      loadingEl.replaceWith(summaryEl);
    }
  })();
}

// ── Async channel-post thread summarization (fetch replies then summarize) ──
function runChannelThreadSummarization(allItems, data) {
  console.log(`[chThreadSumm] called with ${allItems.length} items, types:`, allItems.map(i => `${i._type}/${i._summarizeThreads ? 'summ' : 'no'}`));
  const items = allItems.filter((item) => item._type === 'channel' && item._summarizeThreads);
  if (items.length === 0) { console.log('[chThreadSumm] no qualifying items, returning'); return; }

  const MAX_PAYLOAD_BYTES = 3000;
  const FETCH_TIMEOUT = 5000;

  function fetchRepliesAsync(channel, ts) {
    return new Promise((resolve) => {
      const reqId = `chtsumm_${++replyRequestId}`;
      console.log(`[chThreadSumm] fetchReplies reqId=${reqId} channel=${channel} ts=${ts}`);
      const timer = setTimeout(() => {
        console.warn(`[chThreadSumm] fetchReplies TIMEOUT reqId=${reqId} channel=${channel} ts=${ts}`);
        window.removeEventListener('message', handler);
        resolve([]);
      }, FETCH_TIMEOUT);
      const handler = (event) => {
        if (event.source !== window) return;
        if (event.data?.type !== `${FSLACK}:repliesResult`) return;
        if (event.data.requestId !== reqId) return;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        console.log(`[chThreadSumm] fetchReplies OK reqId=${reqId} replies=${(event.data.replies || []).length}`);
        resolve(event.data.replies || []);
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: `${FSLACK}:fetchReplies`, channel, ts, requestId: reqId }, '*');
    });
  }

  // Collect all qualifying messages, then process in parallel
  const tasks = [];
  for (const cp of items) {
    const ch = data.channels[cp.channel_id] || cp.channel_id;
    for (const m of cp.messages) {
      if ((m.reply_count || 0) < 10) continue;
      const key = `ch-thread-summary-${cp.channel_id}-${(m.ts || '').replace('.', '_')}`;
      tasks.push({ cp, ch, m, key });
    }
  }
  if (tasks.length === 0) return;

  console.log(`[chThreadSumm] starting ${tasks.length} thread summarizations`);
  for (const { cp, ch, m, key } of tasks) {
    (async () => {
      const loadingEl = shadow.getElementById(`${key}-loading`);
      if (!loadingEl) { console.warn(`[chThreadSumm] no loadingEl for key=${key}`); return; }

      console.log(`[chThreadSumm] fetching replies for key=${key} channel=${cp.channel_id} ts=${m.ts}`);
      const rawReplies = await fetchRepliesAsync(cp.channel_id, m.ts);
      if (rawReplies.length === 0) { console.warn(`[chThreadSumm] no replies for key=${key}`); loadingEl.remove(); return; }
      console.log(`[chThreadSumm] got ${rawReplies.length} raw replies for key=${key}, sending to LLM`);

      const replies = [];
      let bytes = 0;
      for (const r of rawReplies) {
        const entry = { user: uname(r.user, data.users), text: plainTruncate(textWithFwd(r.text, r.fwd), 400, data.users) };
        const s = JSON.stringify(entry);
        if (bytes + s.length > MAX_PAYLOAD_BYTES) break;
        bytes += s.length;
        replies.push(entry);
      }

      let response;
      try {
        response = await new Promise((resolve) =>
          chrome.runtime.sendMessage({
            type: `${FSLACK}:summarizeThreadReplies`,
            data: { channel: ch, rootUser: uname(m.user, data.users), rootText: plainTruncate(textWithFwd(m.text, m.fwd), 400, data.users), replies }
          }, resolve)
        );
      } catch (err) { console.error(`[chThreadSumm] sendMessage error for key=${key}`, err); return; }
      if (!response?.summary?.summary) { console.warn(`[chThreadSumm] no summary in response for key=${key}`, response); loadingEl.remove(); return; }

      console.log(`[chThreadSumm] got summary for key=${key}: "${response.summary.summary.slice(0, 80)}…"`);
      const summaryEl = document.createElement('div');
      summaryEl.className = 'deep-summary';
      summaryEl.style.cssText = 'margin:6px 0 2px';
      summaryEl.textContent = response.summary.summary;
      loadingEl.replaceWith(summaryEl);
    })();
  }
}

// ── Main orchestration: pre-filter → LLM → render ──
let pendingPopular = null;
let pendingVips = null;
let pendingSaved = null;
let gotSaved = false;

function buildMyReactionsMap(data) {
  const map = {};
  function add(ch, msgs) {
    for (const m of msgs || []) {
      if (m.my_reactions?.length) map[`${ch}:${m.ts}`] = m.my_reactions;
    }
  }
  for (const t of data.threads || []) {
    add(t.channel_id, [{ ts: t.ts, my_reactions: t.root_my_reactions }]);
    add(t.channel_id, t.unread_replies);
  }
  for (const dm of data.dms || []) add(dm.channel_id, dm.messages);
  for (const cp of data.channelPosts || []) {
    add(cp.channel_id, cp.messages);
    if (cp.fullMessages) {
      add(cp.channel_id, cp.fullMessages.history);
      for (const thread of cp.fullMessages.threads || []) add(cp.channel_id, thread.messages);
    }
  }
  return map;
}

function prioritizeAndRender(data) {
  myReactionsMap = buildMyReactionsMap(data);
  const preFiltered = applyPreFilters(data);
  const { forLlm } = preFiltered;
  const meta = data.channelMeta || {};

  // Split channel posts: private go in call 1 (with threads/DMs), public go in call 2
  const privateChannelPosts = forLlm.channelPosts.filter((cp) => meta[cp.channel_id]?.isPrivate);
  const publicChannelPosts = forLlm.channelPosts.filter((cp) => !meta[cp.channel_id]?.isPrivate);
  // Reorder so private come first — mapPriorities uses array index for IDs
  forLlm.channelPosts = [...privateChannelPosts, ...publicChannelPosts];
  const privateCount = privateChannelPosts.length;

  const totalItems = forLlm.threads.length + forLlm.dms.length + forLlm.channelPosts.length;

  if (totalItems === 0) {
    // Only noise/dropped/bot — render what we have
    const prioritized = { actNow: [], priority: [], whenFree: preFiltered.whenFree, noise: preFiltered.noise, digests: preFiltered.digests };
    renderPrioritized(prioritized, data, pendingPopular, false, false, pendingSaved || []);
    runBotThreadSummarization(prioritized.whenFree, data);
    const allElevatedEarly = [...prioritized.actNow, ...prioritized.priority, ...prioritized.whenFree];
    runThreadReplySummarization(allElevatedEarly, data);
    runChannelThreadSummarization(allElevatedEarly, data);
    saveViewCache(data, pendingPopular, prioritized, pendingSaved || []);
    return;
  }

  // Show loading while LLM works
  bodyEl.innerHTML = '<div id="status"><div class="detail">Analyzing messages with AI...</div></div>';

  const selfName = data.users?.[data.selfId] || '';

  // Call 1: threads, DMs, private channels (act_now/priority/when_free/noise)
  const importantItems = serializeForLlm(
    { threads: forLlm.threads, dms: forLlm.dms, channelPosts: privateChannelPosts },
    data, 0
  );
  // Call 2: public channels only (when_free vs noise — noise ones get deep summarization)
  const publicItems = serializeForLlm(
    { threads: [], dms: [], channelPosts: publicChannelPosts },
    data, privateCount
  );

  function sendPrioritize(items) {
    return new Promise((resolve) => {
      if (items.length === 0) { resolve({ priorities: {}, noiseOrder: [] }); return; }
      chrome.runtime.sendMessage({ type: `${FSLACK}:prioritize`, data: items, selfName }, (resp) => {
        if (chrome.runtime.lastError) { resolve({ error: 'extension_error' }); return; }
        resolve(resp);
      });
    });
  }

  Promise.all([sendPrioritize(importantItems), sendPrioritize(publicItems)]).then(([importantResp, publicResp]) => {
      if (importantResp?.error === 'extension_error' || publicResp?.error === 'extension_error') {
        render(data);
        return;
      }

      if (importantResp?.error === 'no_api_key' || publicResp?.error === 'no_api_key') {
        showApiKeyPrompt(data);
        return;
      }

      const firstError = importantResp?.error || publicResp?.error;
      if (firstError) {
        console.warn('FSlack prioritization error:', firstError);
        // Fall back to cached priorities if available
        if (cachedView?.prioritized) {
          renderPrioritized(cachedView.prioritized, cachedView.data, cachedView.popular, false, false, cachedView.saved || []);
          const banner = document.createElement('div');
          banner.className = 'warning-banner';
          banner.textContent = 'Showing cached results (API temporarily unavailable)';
          bodyEl.insertBefore(banner, bodyEl.firstChild);
        } else {
          render(data);
          const banner = document.createElement('div');
          banner.className = 'warning-banner';
          banner.textContent = `Prioritization unavailable: ${firstError}`;
          bodyEl.insertBefore(banner, bodyEl.firstChild);
        }
        return;
      }

      const mergedPriorities = { ...importantResp.priorities, ...publicResp.priorities };
      const mergedNoiseOrder = [...(importantResp.noiseOrder || []), ...(publicResp.noiseOrder || [])];
      const mergedReasons = { ...(importantResp.reasons || {}), ...(publicResp.reasons || {}) };

      const prioritized = mapPriorities(mergedPriorities, forLlm, preFiltered.noise, preFiltered.whenFree, data, mergedReasons);
      prioritized.digests = preFiltered.digests;
      prioritized.noise = sortNoiseItems(prioritized.noise, mergedNoiseOrder);
      const deepNoise = prioritized.noise.filter((item) =>
        (item.fullMessages?.history || item.messages || []).length >= 3
      );
      const regularNoise = prioritized.noise.filter((item) =>
        (item.fullMessages?.history || item.messages || []).length < 3
      );
      const digestItems = prioritized.digests || [];

      const allElevated = [...prioritized.actNow, ...prioritized.priority, ...prioritized.whenFree];

      if (deepNoise.length === 0 && digestItems.length === 0) {
        renderPrioritized(prioritized, data, pendingPopular, false, false, pendingSaved || []);
        runBotThreadSummarization(prioritized.whenFree, data);
        runThreadReplySummarization(allElevated, data);
        runChannelThreadSummarization(allElevated, data);
        saveViewCache(data, pendingPopular, prioritized, pendingSaved || []);
        return;
      }

      // Render main sections; loading indicators show for each type
      renderPrioritized({ ...prioritized, noise: regularNoise, digests: digestItems }, data, pendingPopular, false, deepNoise.length > 0, pendingSaved || [], digestItems.length > 0);
      runBotThreadSummarization(prioritized.whenFree, data);
      runThreadReplySummarization(allElevated, data);
      runChannelThreadSummarization(allElevated, data);
      saveViewCache(data, pendingPopular, { ...prioritized, noise: regularNoise, digests: digestItems }, pendingSaved || []);

      // Summarize each deep-noise and digest channel individually with a byte cap on messages sent
      const MAX_PAYLOAD_BYTES = 3000;
      function buildSummarizePayload(cp) {
        const ch = data.channels[cp.channel_id] || cp.channel_id;
        const allMsgs = cp.fullMessages?.history || cp.messages;
        const messages = [];
        let bytes = 0;
        for (const m of allMsgs) {
          const entry = {
            user: m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users),
            text: plainTruncate(textWithFwd(m.text, m.fwd), 400, data.users),
          };
          const s = JSON.stringify(entry);
          if (bytes + s.length > MAX_PAYLOAD_BYTES) break;
          messages.push(entry);
          bytes += s.length;
        }
        return { channel: ch, messages };
      }

      (async () => {
        const deepNoiseArea = shadow.getElementById('deep-noise-area');
        const noiseRecentEl = shadow.getElementById('noise-recent-items');
        const noiseOlderEl = shadow.getElementById('noise-older-items');
        const noiseRecentToggleEl = shadow.getElementById('noise-recent-toggle');
        const noiseOlderToggleEl = shadow.getElementById('noise-older-toggle');
        const digestItemsEl = shadow.getElementById('digest-items');
        const deepDigestArea = shadow.getElementById('deep-digest-area');
        const digestsToggleEl = shadow.getElementById('digests-toggle');

        let noiseDone = 0;
        if (deepNoiseArea && deepNoise.length > 0) deepNoiseArea.textContent = `Summarizing channels... 0/${deepNoise.length}`;

        const allDeepItems = [...deepNoise, ...digestItems];
        const results = await Promise.all(allDeepItems.map(async (cp) => {
          const payload = buildSummarizePayload(cp);
          let response;
          try {
            response = await new Promise((resolve) =>
              chrome.runtime.sendMessage({ type: `${FSLACK}:summarize`, data: payload }, resolve)
            );
          } catch {
            response = { error: 'send failed' };
          }
          if (!cp._isDigestChannel) {
            noiseDone++;
            if (deepNoiseArea) deepNoiseArea.textContent = `Summarizing channels... ${noiseDone}/${deepNoise.length}`;
          }
          return { cp, result: response?.summary, error: response?.error };
        }));

        if (deepNoiseArea) deepNoiseArea.textContent = '';

        const summarizedNoiseItems = [];
        const summarizedDigestItems = [];
        for (const { cp, result } of results) {
          if (result?.summary) {
            cp._deepSummary = result.summary;
            cp._deepType = result.type;
          }
          if (cp._isDigestChannel) {
            summarizedDigestItems.push(cp);
          } else {
            summarizedNoiseItems.push(cp);
          }
        }

        // Sort ALL noise items by message count desc, then recency desc
        const allNoise = sortNoiseItems([...regularNoise, ...summarizedNoiseItems], mergedNoiseOrder);
        const noiseCutoff = Date.now() / 1000 - 86400;
        const allNoiseRecent = allNoise.filter((item) => getItemSortTs(item) >= noiseCutoff);
        const allNoiseOlder = allNoise.filter((item) => getItemSortTs(item) < noiseCutoff);

        if (noiseRecentEl) {
          let recentHtml = '';
          for (const item of allNoiseRecent) recentHtml += renderAnyItem(item, data, 'noise-item');
          recentHtml += `<div class="noise-section-footer"><button id="noise-mark-recent-btn">Mark all recent noise as read</button></div>`;
          noiseRecentEl.innerHTML = recentHtml;
          if (noiseRecentToggleEl) {
            const count = allNoiseRecent.length;
            const expanded = noiseRecentEl.classList.contains('expanded');
            noiseRecentToggleEl.textContent = `${count} recent noise item${count === 1 ? '' : 's'} ${expanded ? '↑' : '↓'}`;
          }
        }
        if (noiseOlderEl) {
          let olderHtml = '';
          for (const item of allNoiseOlder) olderHtml += renderAnyItem(item, data, 'noise-item');
          olderHtml += `<div class="noise-section-footer" id="noise-older-footer"${allNoiseOlder.length === 0 ? ' style="display:none"' : ''}><button id="noise-mark-older-btn">Mark all older noise as read</button><button id="bankruptcy-btn">☠ Bankruptcy — mark everything older than 7 days as read</button></div>`;
          noiseOlderEl.innerHTML = olderHtml;
          if (allNoiseOlder.length > 0) {
            if (noiseOlderToggleEl) noiseOlderToggleEl.style.display = '';
          }
          if (noiseOlderToggleEl) {
            const count = allNoiseOlder.length;
            const expanded = noiseOlderEl.classList.contains('expanded');
            noiseOlderToggleEl.textContent = `${count} older noise item${count === 1 ? '' : 's'} ${expanded ? '↑' : '↓'}`;
          }
        }

        // Update digest section with summarized items
        if (digestItemsEl) {
          let digestHtml = '';
          for (const item of summarizedDigestItems) digestHtml += renderAnyItem(item, data, 'noise-item');
          digestHtml += `<div class="noise-section-footer"><button id="digests-mark-read-btn">Mark all digests as read</button></div>`;
          digestItemsEl.innerHTML = digestHtml;
          if (deepDigestArea) deepDigestArea.remove();
          if (digestsToggleEl) {
            const count = summarizedDigestItems.length;
            const expanded = digestItemsEl.classList.contains('expanded');
            digestsToggleEl.textContent = `${count} digest${count === 1 ? '' : 's'} ${expanded ? '↑' : '↓'}`;
          }
        }

        saveViewCache(data, pendingPopular, { ...prioritized, noise: allNoise, digests: summarizedDigestItems }, pendingSaved || []);
      })();
  });
}

// ── Fallback: unprioritized render (original 3-section layout) ──
function render(data) {
  const { badges, threadUnreads, threads, dms, channelPosts, users, channels } = data;
  let html = '';

  // Threads
  if (threads && threads.length > 0) {
    html += '<section><h2>Unread Threads</h2>';
    for (const t of threads) {
      const ch = channels[t.channel_id] || t.channel_id;
      const unread = t.unread_replies || [];
      const lastUnread = unread[unread.length - 1];
      const _frtRootTid = truncateId;
      const frtRootText = truncate(t.root_text, 400, users);
      const frtRootExtras = wrapFilesIfTruncated(_frtRootTid, renderFwd(t.root_fwd, users), renderFiles(t.root_files));
      const seenCount = Math.max(0, (t.reply_count || 0) - unread.length);
      const frtRootSeenClass = seenCount > 0 ? ' root-seen' : '';
      html += `<div class="item">
        <div class="item-left">
          <span class="item-channel" data-channel="${t.channel_id}">#${ch}</span>
          ${itemTime(lastUnread?.ts || t.ts, t.channel_id)}
        </div>
        <div class="item-right">
          <div class="item-text${frtRootSeenClass}">${userLink(uname(t.root_user, users), t.channel_id, t.ts)} ${frtRootText}${frtRootExtras}</div>`;
      if (seenCount > 0) {
        html += `<div class="seen-replies-toggle" data-channel="${t.channel_id}" data-ts="${t.ts}" data-unread-ts="${unread.map(r => r.ts).join(',')}">${seenCount} earlier ${seenCount === 1 ? 'reply' : 'replies'}</div>`;
        html += `<div class="seen-replies-container" data-for="${t.channel_id}-${t.ts}"></div>`;
      }
      for (const r of unread) {
        const _frtid = truncateId;
        const frTextHtml = truncate(r.text, 1000, users);
        const frExtras = wrapFilesIfTruncated(_frtid, renderFwd(r.fwd, users), renderFiles(r.files));
        html += `<div class="item-reply">${userLink(uname(r.user, users), t.channel_id, r.ts)} ${frTextHtml}${frExtras}</div>`;
      }
      html += '</div></div>';
    }
    html += '</section>';
  }

  // DMs
  if (dms && dms.length > 0) {
    html += '<section><h2>Unread DMs</h2>';
    for (const dm of dms) {
      const lastMsg = dm.messages[0];
      if (!lastMsg) continue;
      const _fdtid = truncateId;
      const fdmText = truncate(lastMsg.text, 1000, users);
      const fdmExtras = wrapFilesIfTruncated(_fdtid, renderFwd(lastMsg.fwd, users), renderFiles(lastMsg.files));
      html += `<div class="item">
        <div class="item-left">
          <span class="item-channel" data-channel="${dm.channel_id}">DM</span>
          ${itemTime(lastMsg.ts, dm.channel_id)}
        </div>
        <div class="item-right">
          <div class="item-text">${userLink(lastMsg.subtype === 'bot_message' ? 'Bot' : uname(lastMsg.user, users), dm.channel_id, lastMsg.ts)} ${fdmText}${fdmExtras}</div>
        </div>
      </div>`;
    }
    html += '</section>';
  }

  // Channel posts
  if (channelPosts && channelPosts.length > 0) {
    html += '<section><h2>Unread Channels</h2>';
    for (const cp of channelPosts) {
      const ch = channels[cp.channel_id] || cp.channel_id;
      const latest = cp.messages[0];
      html += `<div class="item">
        <div class="item-left">
          <span class="item-channel" data-channel="${cp.channel_id}">#${ch}</span>
          ${itemTime(latest?.ts, cp.channel_id)}`;
      if (cp.mention_count > 0 || cp._isMentioned) {
        html += `<div class="item-mention">@mentioned</div>`;
      }
      html += `</div>
        <div class="item-right">`;
      for (const m of cp.messages.slice(0, 3)) {
        const _fctid = truncateId;
        const fcText = truncate(m.text, 400, users);
        const fcExtras = wrapFilesIfTruncated(_fctid, renderFwd(m.fwd, users), renderFiles(m.files));
        html += `<div class="item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, users), cp.channel_id, m.ts)} ${fcText}${fcExtras}${threadBadge(m, cp.channel_id)}</div>`;
      }
      if (cp.messages.length > 3) {
        html += `<div class="item-reply-count">+${cp.messages.length - 3} more</div>`;
      }
      html += '</div></div>';
    }
    html += '</section>';
  }

  if ((!threads || threads.length === 0) && (!dms || dms.length === 0) && (!channelPosts || channelPosts.length === 0)) {
    html += '<div id="status">All clear — nothing needs your attention.</div>';
  }

  bodyEl.innerHTML = html;
  focusedItemIndex = -1;
}

// ── Fetch button: fire both unreads + popular in parallel ──
fetchBtn.addEventListener('click', startFetch);

// ── Listen for messages from inject.js ──
let pendingUnreads = null;
let gotUnreads = false;
let gotPopular = false;

function resetFetchState() {
  pendingUnreads = null;
  pendingPopular = null;
  pendingVips = null;
  pendingSaved = null;
  gotUnreads = false;
  gotPopular = false;
  gotSaved = false;
  stopDmWatcher();
}

function tryPrioritize() {
  if (!gotUnreads) return;
  // Don't wait for popular or saved — they may fail or be slow
  // But give them a short window if unreads arrive first
  if (!gotPopular || !gotSaved) {
    setTimeout(() => {
      if (!gotPopular) {
        gotPopular = true;
        pendingPopular = [];
      }
      if (!gotSaved) {
        gotSaved = true;
        pendingSaved = [];
      }
      runPrioritize();
    }, 2000);
    return;
  }
  runPrioritize();
}

function runPrioritize() {
  if (!pendingUnreads) return;
  const data = pendingUnreads;

  // Deduplicate popular against unreads
  if (pendingPopular && pendingPopular.length > 0) {
    const unreadKeys = new Set();
    for (const t of data.threads || []) unreadKeys.add(`${t.channel_id}:${t.ts}`);
    for (const cp of data.channelPosts || []) {
      for (const m of cp.messages) unreadKeys.add(`${cp.channel_id}:${m.ts}`);
    }
    pendingPopular = pendingPopular.filter((p) => !unreadKeys.has(`${p.channel_id}:${p.ts}`));
  }

  fetchBtn.disabled = false;
  fetchBtn.textContent = 'Fetch Unreads';
  lastFetchTime = Date.now();
  updateLastUpdated();
  if (lastUpdatedTimer) clearInterval(lastUpdatedTimer);
  lastUpdatedTimer = setInterval(updateLastUpdated, 1000);
  prioritizeAndRender(data);
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data || {};

  if (msg.type === `${FSLACK}:toggleOverlay`) {
    toggle();
    return;
  }

  if (msg.type === `${FSLACK}:progress`) {
    bodyEl.innerHTML = `<div id="status">
      <div class="step">Step ${msg.step}/7</div>
      <div class="detail">${msg.detail || ''}</div>
    </div>`;
  }

  if (msg.type === `${FSLACK}:result`) {
    pendingUnreads = msg.data;
    gotUnreads = true;
    // Cache resolved user/channel names + emoji for next fetch
    if (msg.data) {
      const toStore = {};
      if (msg.data.users) {
        mergeCachedUsers(msg.data.users);
        toStore.fslackUsers = cachedUserMap;
      }
      if (msg.data.userMentionHints) {
        mergeCachedMentionHints(msg.data.userMentionHints);
        toStore.fslackUserMentionHints = cachedUserMentionHints;
      }
      if (msg.data.channels) toStore.fslackChannels = msg.data.channels;
      if (msg.data.channelMeta) toStore.fslackChannelMeta = msg.data.channelMeta;
      if (msg.data.emoji && !msg.data.emojiFromCache) {
        toStore.fslackEmoji = msg.data.emoji;
        toStore.fslackEmojiTs = Date.now();
      }
      if (Object.keys(toStore).length > 0) chrome.storage.local.set(toStore);
      customEmojiMap = msg.data.emoji || null;
      if (msg.data.channels) channelNameMap = msg.data.channels;
    }
    tryPrioritize();
  }

  if (msg.type === `${FSLACK}:popularResult`) {
    pendingPopular = msg.data || [];
    gotPopular = true;
    tryPrioritize();
  }

  if (msg.type === `${FSLACK}:savedResult`) {
    pendingSaved = msg.items || [];
    gotSaved = true;
    console.log('[fslack] savedResult received, items:', pendingSaved.length, pendingSaved[0]);
    tryPrioritize();
  }

  if (msg.type === `${FSLACK}:vipResult`) {
    pendingVips = msg.data || [];
  }

  if (msg.type === `${FSLACK}:newDmsResult`) {
    const { newDms, resolvedUsers } = msg;
    if (newDms && newDms.length > 0 && lastRenderData) {
      // Merge any newly-resolved users into our maps
      if (resolvedUsers) {
        mergeCachedUsers(resolvedUsers);
        lastRenderData.users = { ...lastRenderData.users, ...resolvedUsers };
      }
      for (const dm of newDms) {
        if (!knownDmChannelIds.has(dm.channel_id)) {
          insertNewDm(dm, lastRenderData);
        }
      }
    }
  }

  if (msg.type === `${FSLACK}:error`) {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch Unreads';
    bodyEl.innerHTML = `<div id="status" class="error">${msg.error}</div>`;
    resetFetchState();
  }
});

// Auto-show on load — only when opened via ?fslack bookmark
// Use the original navigation URL (immune to SPA replaceState rewrites)
const _navUrl = (() => {
  try {
    const entry = performance.getEntriesByType('navigation')[0];
    if (entry?.name) return new URL(entry.name);
  } catch {}
  return new URL(window.location.href);
})();
const _autoShow = _navUrl.searchParams.has('fslack');

window.addEventListener('message', (event) => {
  if (event.source === window && event.data?.type === `${FSLACK}:ready`) {
    injectReady = true;
    if (visible && !showFromCache()) startFetch();
  }
});
// Always load persisted cache so toggle path has data for showFromCache()
chrome.storage.local.get(['fslackViewCache', 'fslackSavedMsgs', 'fslackLastFetchTs', 'fslackVipSeen', 'fslackMutedThreads'], (result) => {
  if (result.fslackViewCache && !cachedView) {
    cachedView = result.fslackViewCache;
  }
  persistedFetchTs = result.fslackLastFetchTs || 0;
  savedMsgKeys = new Set(result.fslackSavedMsgs || []);
  vipSeenTimestamps = result.fslackVipSeen || {};
  mutedThreadKeys = new Set(result.fslackMutedThreads || []);
  if (_autoShow && !sessionStorage.getItem('fslack_hide')) {
    show();
  } else {
    sessionStorage.removeItem('fslack_hide');
  }
});
