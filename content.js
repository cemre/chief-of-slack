// content.js — overlay UI on top of Slack + bridge to inject.js + LLM prioritization

const FSLACK = 'fslack';
const VIPS = ['josh', 'tara', 'dustin', 'brahm', 'rosey', 'samir', 'jane'];
const SEEN_REPLIES_CHUNK = 10;


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
  <header>
    <h1>Flack <span class="last-updated-wrap"><span id="last-updated" class="last-updated"></span><span id="refresh-link" class="refresh-link">refresh</span></span></h1>
    <div class="header-actions">
      <button id="fetch-btn">Fetch Unreads</button>
      <button id="close-btn" class="secondary">Back to Slack</button>
    </div>
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
const fetchBtn = shadow.getElementById('fetch-btn');
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
let focusedItemIndex = -1;  // keyboard nav: index into visible items, -1 = none

// Preload custom emoji + channel names from cache for instant render on showFromCache()
chrome.storage.local.get(['fslackEmoji', 'fslackEmojiTs', 'fslackChannels'], (cached) => {
  const EMOJI_TTL_MS = 24 * 60 * 60 * 1000;
  if (cached.fslackEmoji && cached.fslackEmojiTs && Date.now() - cached.fslackEmojiTs < EMOJI_TTL_MS) {
    customEmojiMap = cached.fslackEmoji;
  }
  if (cached.fslackChannels) channelNameMap = cached.fslackChannels;
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

function startFetch() {
  if (fetchBtn.disabled) return;
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Fetching...';
  bodyEl.innerHTML = '<div id="status">Starting fetch...</div>';
  resetFetchState();
  // Load cached names and pass to inject.js
  chrome.storage.local.get(['fslackUsers', 'fslackChannels', 'fslackChannelMeta', 'fslackNoiseChannels', 'fslackNeverNoiseChannels', 'fslackDigestChannels', 'fslackSavedMsgs', 'fslackEmoji', 'fslackEmojiTs', 'fslackVipSeen'], (cached) => {
    noiseChannels = cached.fslackNoiseChannels || {};
    neverNoiseChannels = cached.fslackNeverNoiseChannels || {};
    digestChannels = cached.fslackDigestChannels || {};
    savedMsgKeys = new Set(cached.fslackSavedMsgs || []);
    vipSeenTimestamps = cached.fslackVipSeen || {};
    const EMOJI_TTL_MS = 24 * 60 * 60 * 1000;
    const cachedEmoji = (cached.fslackEmojiTs && Date.now() - cached.fslackEmojiTs < EMOJI_TTL_MS)
      ? (cached.fslackEmoji || {}) : null;
    window.postMessage({
      type: `${FSLACK}:fetch`,
      cachedUsers: cached.fslackUsers || {},
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
    runThreadReplySummarization([...(cachedView.prioritized.actNow || []), ...(cachedView.prioritized.priority || []), ...(cachedView.prioritized.whenFree || [])], cachedView.data);
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
  if (showFromCache()) return;
  if (injectReady) startFetch();
}
function hide() { visible = false; overlay.classList.remove('visible'); }
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

function isThreadExpanded(scopeEl) {
  if (!scopeEl) return false;
  const badge = scopeEl.querySelector('.msg-thread-badge.expanded');
  if (!badge) return false;
  // Badge keeps .expanded after first load, but container display is toggled
  const { channel, ts } = badge.dataset;
  if (!channel || !ts) return false;
  const container = bodyEl.querySelector(`.thread-replies-container[data-channel="${channel}"][data-ts="${ts}"]`);
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

let truncateId = 0;

function cleanSlackText(text, users) {
  if (!text) return '';
  text = text.replace(/<@(U[A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, displayName) => `@${displayName || users?.[id] || id}`);
  text = text.replace(/<#(C[A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `#${label || channelNameMap?.[id] || id}`);
  text = text.replace(/<([^|>]+)\|([^>]+)>/g, (_, _url, label) => label);
  text = text.replace(/<([^>]+)>/g, (_, url) => url);
  return text;
}

function formatSlackHtml(text, users) {
  if (!text) return '';
  let result = '';
  let lastIndex = 0;
  const regex = /<([^>]+)>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    result += escapeHtml(text.slice(lastIndex, match.index));
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
      result += `<a href="${escapeHtml(inner)}" target="_blank" rel="noopener">${escapeHtml(inner)}</a>`;
    } else {
      result += escapeHtml(inner);
    }
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
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
  if (cleaned.length <= max) return formatSlackHtml(text, users);
  const id = `trunc_${++truncateId}`;
  const short = applyEmoji(escapeHtml(cleaned.slice(0, max)), customEmojiMap);
  const full = formatSlackHtml(text, users).replace(/\n/g, '<br>');
  return `<span id="${id}-short">${short}... <span class="see-more" data-trunc-id="${id}">See more</span></span><span id="${id}-full" style="display:none">${full} <span class="see-less" data-trunc-id="${id}">See less</span></span>`;
}

function plainTruncate(text, max = 150, users) {
  const cleaned = cleanSlackText(text, users);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + '...';
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
  return `<span class="item-user" data-channel="${channel}" data-ts="${ts}">${name}:</span>`;
}

function channelLink(label, channelId) {
  if (!channelId) return `<span class="item-channel">${label}</span>`;
  return `<span class="item-channel" data-channel="${channelId}">${label}</span>`;
}

function threadBadge(m, channel, truncId) {
  if (!m.reply_count) return '';
  const n = m.reply_count;
  const seeMore = truncId ? ' · See more' : '';
  const truncAttr = truncId ? ` data-trunc-id="${truncId}"` : '';
  const time = formatTimeTooltip(m.ts);
  const timeHtml = time ? `<span class="msg-time">${time}</span>` : '';
  const timeAttr = time ? ` data-time="${escapeHtml(time)}"` : '';
  return `<span class="msg-thread-badge" data-channel="${channel}" data-ts="${m.ts}"${truncAttr}${timeAttr}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>${n} ${n === 1 ? 'reply' : 'replies'}${seeMore}${timeHtml}</span>`;
}

// Render message text + files + thread badge with merged "See more" / "N replies"
function renderMsgBody(m, channel, users, maxLen = 400) {
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
  const badge = threadBadge(m, channel, truncIdForBadge);
  return textHtml + renderFiles(m.files) + badge + (badge ? '' : msgTime(m.ts));
}

function threadRepliesContainer(m, channel) {
  if (!m.reply_count) return '';
  return `<div class="thread-replies-container" data-channel="${channel}" data-ts="${m.ts}"></div>`;
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

function msgTime(ts) {
  const t = formatTimeTooltip(ts);
  return t ? `<span class="msg-time">${t}</span>` : '';
}

function itemActions(channel, markTs, threadTs, isDm, channelName = '', isNoise = false) {
  return `<div class="item-actions">
    <span class="mark-all-read" data-channel="${channel}" data-ts="${markTs}"${threadTs ? ` data-thread-ts="${threadTs}"` : ''}><kbd>M</kbd> mark read</span>
    ${threadTs || isDm ? `<span class="action-reply" data-channel="${channel}" data-ts="${threadTs || markTs}"${isDm ? ' data-dm="true"' : ''}>reply</span>` : ''}
    ${threadTs ? `<span class="action-mute" data-channel="${channel}" data-thread-ts="${threadTs}"><kbd>T</kbd> mute thread</span>` : ''}
    ${!threadTs && !isDm ? `<span class="action-mute-channel" data-channel="${channel}"><kbd>T</kbd> mute channel</span>` : ''}
    ${!threadTs && !isDm && !isNoise ? `<span class="action-always-noise" data-channel="${channel}" data-channel-name="${escapeHtml(channelName)}">mark noise</span>` : ''}
    ${!threadTs && !isDm && isNoise ? `<span class="action-never-noise" data-channel="${channel}" data-channel-name="${escapeHtml(channelName)}">never noise</span>` : ''}
    ${!threadTs && !isDm ? `<span class="action-mark-digest" data-channel="${channel}" data-channel-name="${escapeHtml(channelName)}">mark digest</span>` : ''}
  </div>`;
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
      <span class="item-time">${formatTime(markAllTs)}</span>`;
  if (t.mention_count > 0 || t._isMentioned) {
    html += `<div class="item-mention">@mentioned</div>`;
  }
  html += `</div>
    <div class="item-right">
      <div class="msg-row"><div class="msg-content item-text">${userLink(uname(t.root_user, data.users), t.channel_id, t.ts)} ${truncate(t.root_text, 400, data.users)}${renderFiles(t.root_files)}${msgTime(t.ts)}</div>${msgActions(t.channel_id, t.ts)}</div>`;
  // Thread reply summarization for non-DM threads with 5+ unread replies
  const shouldSummarize = !t._isDmThread && unread.length >= 5;
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
    html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(uname(r.user, data.users), t.channel_id, r.ts)} ${truncate(r.text, 1000, data.users)}${renderFiles(r.files)}${msgTime(r.ts)}</div>${msgActions(t.channel_id, r.ts)}</div>`;
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
      <span class="item-time">${formatTime(latest.ts)}</span>
    </div>
    <div class="item-right">`;
  for (const m of [...dm.messages].reverse()) {
    const sender = dm.isGroup ? `${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), dm.channel_id, m.ts)} ` : '';
    html += `<div class="msg-row"><div class="msg-content item-text">${sender}${truncate(m.text, 1000, data.users)}${renderFiles(m.files)}${msgTime(m.ts)}</div>${msgActions(dm.channel_id, m.ts)}</div>`;
  }
  html += itemActions(dm.channel_id, latest.ts, null, true);
  html += '</div></div>';
  return html;
}

function renderChannelItem(cp, data, cssClass) {
  const ch = data.channels[cp.channel_id] || cp.channel_id;
  const latest = cp.messages[0];
  let html = `<div class="item ${cssClass}">
    <div class="item-left">
      ${channelLink('#' + escapeHtml(ch), cp.channel_id)}
      <span class="item-time">${formatTime(latest?.ts)}</span>`;
  if (cp.mention_count > 0 || cp._isMentioned) {
    html += `<div class="item-mention">@mentioned</div>`;
  }
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
      html += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users)}</div>${msgActions(cp.channel_id, m.ts)}${threadRepliesContainer(m, cp.channel_id)}</div>`;
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
    messagesHtml += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users)}</div>${msgActions(cp.channel_id, m.ts)}${threadRepliesContainer(m, cp.channel_id)}</div>`;
  }
  const deepMsgId = `deep-msgs-${cp.channel_id}`;
  return `<div class="item noise-item">
    <div class="item-left">
      ${channelLink('#' + escapeHtml(ch), cp.channel_id)}
      <span class="item-time">${timeDisplay}</span>
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
  const textHtml = msg.text ? truncate(msg.text, 400, data.users) : '';
  return `<div class="item saved-item" data-complete-request-id="">
    <div class="item-left">
      ${channelLink('#' + escapeHtml(ch), channel)}
      <span class="item-time">${formatTime(ts)}</span>
    </div>
    <div class="item-right">
      <div class="msg-row">
        <div class="msg-content item-text">${user ? userLink(uname(user, data.users), channel, ts) + ' ' : ''}${textHtml}${renderFiles(msg.files)}${msgTime(ts)}</div>
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
    messagesHtml += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' || !m.user ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users)}</div>${msgActions(cp.channel_id, m.ts, { showReply: false })}${threadRepliesContainer(m, cp.channel_id)}</div>`;
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
      <span class="item-time">${formatTime(allMsgs[allMsgs.length - 1]?.ts)}</span>
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

  // Threads: annotate metadata for LLM
  const diaChannelNames = new Set(['dia-dogfooding', 'help-dia']);
  for (const t of threads) {
    t._userReplied = (t.reply_users || []).includes(selfId);
    t._type = 'thread';
    t._isDmThread = t.channel_id?.startsWith('D') || false;

    const allTexts = [t.root_text, ...(t.unread_replies || []).map((r) => r.text)].join(' ');
    t._isMentioned = containsSelfMention(allTexts, selfId);

    // dia-dogfooding / help-dia threads: only surface if 10+ replies, rest → noise
    const tChName = channels[t.channel_id] || '';
    if (diaChannelNames.has(tChName)) {
      if ((t.reply_count || 0) >= 10) {
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
    const hasEngagement = cp.messages.some((m) => (m.reply_count || 0) >= 3);
    if (hasEngagement) {
      const replierIds = [...new Set(
        cp.messages.filter((m) => (m.reply_count || 0) >= 3).flatMap((m) => m.reply_users || [])
      )];
      cp._repliers = replierIds.slice(0, 3).map((uid) => uname(uid, users));
      cp._replierOverflow = Math.max(0, replierIds.length - 3);
      whenFree.push(cp);
    } else {
      cp._isDigestChannel = true;
      digests.push(cp);
    }
  }

  // Build set of thread roots so we can dedup channel posts that are already shown as threads
  const threadRootKeys = new Set();
  const threadByKey = {};
  for (const t of threads) {
    if (t.channel_id && t.ts) {
      const key = `${t.channel_id}:${t.ts}`;
      threadRootKeys.add(key);
      threadByKey[key] = t;
    }
  }

  // Channel posts
  for (const cp of channelPosts) {
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
  for (const dm of dms) {
    dm._type = 'dm';
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
      rootText: plainTruncate(t.root_text, 1000, data.users),
      userReplied: t._userReplied,
      newReplies: t.unread_replies.map((r) => ({
        user: uname(r.user, data.users),
        text: plainTruncate(r.text, 1000, data.users),
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
        text: plainTruncate(m.text, 1000, data.users),
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
        text: plainTruncate(m.text, 1000, data.users),
      })),
    });
  }

  return items;
}

// ── Map LLM priorities back to original data objects ──
function mapPriorities(priorities, forLlm, deterministicNoise, deterministicWhenFree, data) {
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
    html += '</section>';
  }

  // When You Have a Moment
  if (whenFree.length > 0) {
    html += '<section class="priority-section"><h2 class="when-free">When You Have a Moment</h2>';
    for (const item of whenFree) html += renderAnyItem(item, data, 'when-free');
    html += '</section>';
  }

  // Interesting Elsewhere
  if (popular && popular.length > 0) {
    html += '<section class="priority-section"><h2 class="interesting">Interesting Elsewhere</h2>';
    for (const p of popular) {
      html += `<div class="item interesting">
        <div class="item-left">
          ${channelLink('#' + escapeHtml(p.channel_name || p.channel_id), p.channel_id)}
          <span class="item-time">${formatTime(p.ts)}</span>
          <div class="engagement-stats">${p.reaction_count} reactions · ${p.reply_count} replies</div>
        </div>
        <div class="item-right">
          <div class="msg-row"><div class="msg-content item-text">${p.user ? userLink(uname(p.user, data.users), p.channel_id, p.ts) + ' ' : ''}${truncate(p.text, 400, data.users)}${renderFiles(p.files)}${msgTime(p.ts)}</div>${msgActions(p.channel_id, p.ts)}</div>
        </div>
      </div>`;
    }
    html += '</section>';
  }

  // Loading indicator while LLM is working
  if (loading) {
    html += '<div id="status"><div class="detail">Analyzing remaining messages with AI...</div></div>';
  }

  // Saved items (last 72h, collapsed by default)
  if (savedItems && savedItems.length > 0) {
    html += '<section class="priority-section">';
    html += `<div class="section-toggle" id="saved-items-toggle">${savedItems.length} saved item${savedItems.length === 1 ? '' : 's'} ↓</div>`;
    html += '<div class="saved-items-list" id="saved-items-list">';
    for (const item of savedItems) html += renderSavedItem(item, data);
    html += '</div>';
    html += '</section>';
  }

  // Noise (collapsed by default) — split into recent (last 24h) and older
  if (!loading && (noise.length > 0 || deepNoiseLoading)) {
    const noiseCutoff = Date.now() / 1000 - 86400;
    const noiseRecent = noise.filter((item) => getItemSortTs(item) >= noiseCutoff);
    const noiseOlder = noise.filter((item) => getItemSortTs(item) < noiseCutoff);
    html += '<section class="priority-section">';
    if (noiseRecent.length > 0 || deepNoiseLoading) {
      html += `<div class="section-toggle" id="noise-recent-toggle">${noiseRecent.length} recent noise item${noiseRecent.length === 1 ? '' : 's'} ↓</div>`;
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
      html += `<div class="section-toggle" id="noise-older-toggle"${olderHidden ? ' style="display:none"' : ''}>${noiseOlder.length} older noise item${noiseOlder.length === 1 ? '' : 's'} ↓</div>`;
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
    html += `<div class="section-toggle" id="digests-toggle">Show ${digests.length} digest${digests.length === 1 ? '' : 's'}</div>`;
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
  lastRenderData = data;

  // Wire up noise toggles
  function wireNoiseToggle(toggleId, itemsId, label) {
    const toggle = shadow.getElementById(toggleId);
    const items = shadow.getElementById(itemsId);
    if (toggle && items) {
      toggle.addEventListener('click', () => {
        const expanded = items.classList.toggle('expanded');
        const count = items.querySelectorAll('.item').length;
        toggle.textContent = `${count} ${label}${count === 1 ? '' : 's'} ${expanded ? '↑' : '↓'}`;
      });
    }
  }
  wireNoiseToggle('noise-recent-toggle', 'noise-recent-items', 'recent noise item');
  wireNoiseToggle('noise-older-toggle', 'noise-older-items', 'older noise item');
  wireNoiseToggle('saved-items-toggle', 'saved-items-list', 'saved item');
  wireNoiseToggle('digests-toggle', 'digest-items', 'digest');
}

// ── Seen replies lazy loading ──
let lastRenderData = null;
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

  // Permalink: click username to open message in a new tab
  const userEl = e.target.closest('.item-user[data-channel]');
  if (userEl) {
    const { channel, ts } = userEl.dataset;
    localStorage.setItem('fslack_hide_once', Date.now());
    window.open(`/archives/${channel}/p${ts.replace('.', '')}`, '_blank');
    return;
  }

  // Thread badge: expand replies inline (shift/meta-click opens in new tab)
  const threadBadgeEl = e.target.closest('.msg-thread-badge');
  if (threadBadgeEl) {
    const { channel, ts, truncId } = threadBadgeEl.dataset;

    // Expand truncated text if this badge merged "See more"
    // Modifier click → open in Slack as before
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.button === 1) {
      localStorage.setItem('fslack_hide_once', Date.now());
      window.open(`/archives/${channel}/p${ts.replace('.', '')}`, '_blank');
      return;
    }

    const container = bodyEl.querySelector(`.thread-replies-container[data-channel="${channel}"][data-ts="${ts}"]`);
    if (!container) return;

    // Already loaded → toggle visibility (including truncated text)
    if (threadBadgeEl.classList.contains('expanded')) {
      const isVisible = container.style.display !== 'none';
      container.style.display = isVisible ? 'none' : '';
      if (truncId) {
        const shortEl = shadow.getElementById(`${truncId}-short`);
        const fullEl = shadow.getElementById(`${truncId}-full`);
        if (shortEl && fullEl) {
          shortEl.style.display = isVisible ? '' : 'none';
          fullEl.style.display = isVisible ? 'none' : '';
        }
      }
      const n = parseInt(container.dataset.count, 10) || 0;
      const svg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
      const timeHtml = threadBadgeEl.dataset.time ? `<span class="msg-time">${escapeHtml(threadBadgeEl.dataset.time)}</span>` : '';
      threadBadgeEl.innerHTML = isVisible
        ? `${svg}${n} ${n === 1 ? 'reply' : 'replies'}${timeHtml}`
        : `${svg}Hide ${n} ${n === 1 ? 'reply' : 'replies'}${timeHtml}`;
      return;
    }

    // Loading in progress → ignore
    if (threadBadgeEl.classList.contains('loading')) return;

    // First click → expand truncated text + fetch replies
    if (truncId) {
      const shortEl = shadow.getElementById(`${truncId}-short`);
      const fullEl = shadow.getElementById(`${truncId}-full`);
      if (shortEl && fullEl) { shortEl.style.display = 'none'; fullEl.style.display = ''; }
    }
    threadBadgeEl.classList.add('loading');
    threadBadgeEl.textContent = 'Loading...';
    const reqId = `thread_${++replyRequestId}`;
    threadBadgeEl.dataset.requestId = reqId;
    window.postMessage({ type: `${FSLACK}:fetchReplies`, channel, ts, requestId: reqId }, '*');
    return;
  }

  // Channel name: open channel in a new tab
  const channelEl = e.target.closest('.item-channel[data-channel]');
  if (channelEl) {
    const { channel } = channelEl.dataset;
    localStorage.setItem('fslack_hide_once', Date.now());
    window.open(`/archives/${channel}`, '_blank');
    return;
  }

  // See more / See less toggle
  const seeMore = e.target.closest('.see-more');
  if (seeMore) {
    const id = seeMore.dataset.truncId;
    const shortEl = shadow.getElementById(`${id}-short`);
    const fullEl = shadow.getElementById(`${id}-full`);
    if (shortEl && fullEl) { shortEl.style.display = 'none'; fullEl.style.display = ''; }
    return;
  }
  const seeLess = e.target.closest('.see-less');
  if (seeLess) {
    const id = seeLess.dataset.truncId;
    const shortEl = shadow.getElementById(`${id}-short`);
    const fullEl = shadow.getElementById(`${id}-full`);
    if (shortEl && fullEl) { shortEl.style.display = ''; fullEl.style.display = 'none'; }
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
      window.postMessage({ type: `${FSLACK}:removeReaction`, channel, ts, emoji, requestId: `unreact_${Date.now()}` }, '*');
      reactBtn.dataset.pending = 'unreact';
    } else {
      reactBtn.style.opacity = '0.4';
      window.postMessage({ type: `${FSLACK}:addReaction`, channel, ts, emoji, requestId: `react_${Date.now()}` }, '*');
      reactBtn.dataset.pending = 'react';
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
    form.innerHTML = `<textarea class="reply-input" rows="1" placeholder="Reply... (⌘Enter to send)"></textarea><button class="reply-send">Send</button>`;
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
      if (!showMsgsLink.dataset.showText) showMsgsLink.dataset.showText = showMsgsLink.textContent;
      if (msgsDiv.style.display === 'block') {
        msgsDiv.style.display = 'none';
        showMsgsLink.textContent = showMsgsLink.dataset.showText;
      } else {
        msgsDiv.style.display = 'block';
        showMsgsLink.textContent = 'hide ↑';
      }
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
    html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(userName, toggle.dataset.channel, r.ts)} ${truncate(r.text, 400, data?.users)}${renderFiles(r.files)}${msgTime(r.ts)}</div>${msgActions(toggle.dataset.channel, r.ts)}</div>`;
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
    const container = bodyEl.querySelector(`.thread-replies-container[data-channel="${channel}"][data-ts="${ts}"]`);
    if (!container) return;

    const data = lastRenderData;
    // conversations.replies returns root message at index 0 — skip it
    const threadReplies = replies.filter((r) => r.ts !== ts);

    let html = '';
    for (const r of threadReplies) {
      const userName = data ? uname(r.user, data.users) : r.user;
      html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(userName, channel, r.ts)} ${truncate(r.text, 400, data?.users)}${renderFiles(r.files)}${msgTime(r.ts)}</div>${msgActions(channel, r.ts)}</div>`;
    }
    container.innerHTML = html;
    container.style.display = '';
    container.dataset.count = threadReplies.length;

    badge.classList.remove('loading');
    badge.classList.add('expanded');
    const n = threadReplies.length;
    const svg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
    const timeHtml = badge.dataset.time ? `<span class="msg-time">${escapeHtml(badge.dataset.time)}</span>` : '';
    badge.innerHTML = n > 0
      ? `${svg}Hide ${n} ${n === 1 ? 'reply' : 'replies'}${timeHtml}`
      : `${svg}No replies${timeHtml}`;
    return;
  }
});

// ── Send reply helper ──
function autoMarkItemRead(item, { requireThread = false } = {}) {
  if (!item) return;
  const markAll = item.querySelector('.mark-all-read');
  if (!markAll) return;
  if (requireThread && !markAll.dataset.threadTs) return;
  if (markAll.classList.contains('done') || markAll.dataset.pending) return;
  const { channel, ts, threadTs } = markAll.dataset;
  markAll.textContent = '...';
  markAll.dataset.pending = 'true';
  window.postMessage({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, requestId: `readall_${Date.now()}` }, '*');
}

function sendReply(form, channel, threadTs, text) {
  const input = form.querySelector('.reply-input');
  const btn = form.querySelector('.reply-send');
  input.disabled = true;
  btn.disabled = true;
  btn.textContent = '...';
  const reqId = `post_${Date.now()}`;
  form.dataset.requestId = reqId;
  window.postMessage({ type: `${FSLACK}:postReply`, channel, thread_ts: threadTs, text, requestId: reqId }, '*');
}

// ── Action result listeners ──
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data || {};

  if (msg.type === `${FSLACK}:reactResult`) {
    const btn = bodyEl.querySelector('.action-react[data-pending="react"]');
    if (btn) {
      delete btn.dataset.pending;
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
    const btn = bodyEl.querySelector('.action-react[data-pending="unreact"]');
    if (btn) {
      delete btn.dataset.pending;
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
    if (muteBtn) {
      if (msg.ok) {
        muteBtn.closest('.item')?.remove();
      } else {
        delete muteBtn.dataset.pending;
        muteBtn.textContent = 'mute thread';
      }
    }
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
      form.remove();
      // Auto mark as read, same flow as clicking "mark read" (undo works for free)
      autoMarkItemRead(item);
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
        text: plainTruncate(m.text, 150, data?.users || {}),
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
        text: plainTruncate(m.text, 400, data.users),
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
        messagesHtml += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' || !m.user ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${truncate(m.text, 400, data.users)}${renderFiles(m.files)}${msgTime(m.ts)}</div>${msgActions(cp.channel_id, m.ts, { showReply: false })}</div>`;
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

// ── Async thread reply summarization (non-DM threads with 5+ unread) ──
function runThreadReplySummarization(allItems, data) {
  const threads = allItems.filter((item) => item._type === 'thread' && !item._isDmThread && !item._threadSummary && (item.unread_replies || []).length >= 5);
  if (threads.length === 0) return;

  const MAX_PAYLOAD_BYTES = 3000;

  (async () => {
    for (const t of threads) {
      const ch = data.channels[t.channel_id] || t.channel_id;
      const unread = t.unread_replies || [];
      const replies = [];
      let bytes = 0;
      for (const r of unread) {
        const entry = { user: uname(r.user, data.users), text: plainTruncate(r.text, 400, data.users) };
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
            data: { channel: ch, rootUser: uname(t.root_user, data.users), rootText: plainTruncate(t.root_text, 400, data.users), replies }
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
    runThreadReplySummarization([...prioritized.actNow, ...prioritized.priority, ...prioritized.whenFree], data);
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
        render(data);
        const banner = document.createElement('div');
        banner.className = 'warning-banner';
        banner.textContent = `Prioritization unavailable: ${firstError}`;
        bodyEl.insertBefore(banner, bodyEl.firstChild);
        return;
      }

      const mergedPriorities = { ...importantResp.priorities, ...publicResp.priorities };
      const mergedNoiseOrder = [...(importantResp.noiseOrder || []), ...(publicResp.noiseOrder || [])];

      const prioritized = mapPriorities(mergedPriorities, forLlm, preFiltered.noise, preFiltered.whenFree, data);
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
        saveViewCache(data, pendingPopular, prioritized, pendingSaved || []);
        return;
      }

      // Render main sections; loading indicators show for each type
      renderPrioritized({ ...prioritized, noise: regularNoise, digests: digestItems }, data, pendingPopular, false, deepNoise.length > 0, pendingSaved || [], digestItems.length > 0);
      runBotThreadSummarization(prioritized.whenFree, data);
      runThreadReplySummarization(allElevated, data);

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
            text: plainTruncate(m.text, 400, data.users),
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
          noiseOlderEl.innerHTML = olderHtml;
          if (allNoiseOlder.length > 0) {
            if (noiseOlderToggleEl) noiseOlderToggleEl.style.display = '';
            const olderFooter = shadow.getElementById('noise-older-footer');
            if (olderFooter) olderFooter.style.display = '';
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
      html += `<div class="item">
        <div class="item-left">
          <span class="item-channel" data-channel="${t.channel_id}">#${ch}</span>
          <span class="item-time">${formatTime(lastUnread?.ts || t.ts)}</span>
        </div>
        <div class="item-right">
          <div class="item-text">${userLink(uname(t.root_user, users), t.channel_id, t.ts)} ${truncate(t.root_text, 400, users)}${renderFiles(t.root_files)}</div>`;
      const seenCount = Math.max(0, (t.reply_count || 0) - unread.length);
      if (seenCount > 0) {
        html += `<div class="seen-replies-toggle" data-channel="${t.channel_id}" data-ts="${t.ts}" data-unread-ts="${unread.map(r => r.ts).join(',')}">${seenCount} earlier ${seenCount === 1 ? 'reply' : 'replies'}</div>`;
        html += `<div class="seen-replies-container" data-for="${t.channel_id}-${t.ts}"></div>`;
      }
      for (const r of unread) {
        html += `<div class="item-reply">${userLink(uname(r.user, users), t.channel_id, r.ts)} ${truncate(r.text, 1000, users)}${renderFiles(r.files)}</div>`;
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
      html += `<div class="item">
        <div class="item-left">
          <span class="item-channel" data-channel="${dm.channel_id}">DM</span>
          <span class="item-time">${formatTime(lastMsg.ts)}</span>
        </div>
        <div class="item-right">
          <div class="item-text">${userLink(lastMsg.subtype === 'bot_message' ? 'Bot' : uname(lastMsg.user, users), dm.channel_id, lastMsg.ts)} ${truncate(lastMsg.text, 1000, users)}${renderFiles(lastMsg.files)}</div>
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
          <span class="item-time">${formatTime(latest?.ts)}</span>`;
      if (cp.mention_count > 0 || cp._isMentioned) {
        html += `<div class="item-mention">@mentioned</div>`;
      }
      html += `</div>
        <div class="item-right">`;
      for (const m of cp.messages.slice(0, 3)) {
        html += `<div class="item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, users), cp.channel_id, m.ts)} ${truncate(m.text, 400, users)}${renderFiles(m.files)}${threadBadge(m, cp.channel_id)}</div>`;
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
      if (msg.data.users) toStore.fslackUsers = msg.data.users;
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
if (!_autoShow) {
  // No ?fslack param — don't auto-show (toggle still works via shortcut/icon)
} else {
  const _hideOnce = localStorage.getItem('fslack_hide_once');
  if (_hideOnce && Date.now() - parseInt(_hideOnce) < 5000) {
    localStorage.removeItem('fslack_hide_once');
  } else if (sessionStorage.getItem('fslack_hide')) {
    sessionStorage.removeItem('fslack_hide');
  } else {
    // Load persisted view cache, timestamp, and saved messages before showing
    chrome.storage.local.get(['fslackViewCache', 'fslackSavedMsgs', 'fslackLastFetchTs', 'fslackVipSeen'], (result) => {
      if (result.fslackViewCache && !cachedView) {
        cachedView = result.fslackViewCache;
      }
      persistedFetchTs = result.fslackLastFetchTs || 0;
      savedMsgKeys = new Set(result.fslackSavedMsgs || []);
      vipSeenTimestamps = result.fslackVipSeen || {};
      show();
    });
  }
}
