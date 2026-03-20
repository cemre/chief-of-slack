// sidepanel.js — Flack side panel UI (migrated from content.js overlay)
console.log('[fslack] sidepanel.js loaded', new Date().toISOString());

const FSLACK = 'fslack';
const SEEN_REPLIES_CHUNK = 10;
const RESERVED_MENTIONS = new Set(['here', 'channel', 'everyone']);

// ── Drafts (local-only, chrome.storage) ──
let _drafts = {}; // { "channel:threadTs" → "text" }
const DRAFT_KEY = 'fslackDrafts';
const DRAFT_SAVE_DELAY = 300; // ms debounce
const _draftTimers = {};

function draftKey(channel, threadTs) {
  return `${channel}:${threadTs || 'dm'}`;
}

function _persistDrafts() {
  chrome.storage.local.set({ [DRAFT_KEY]: _drafts });
}

function saveDraft(channel, threadTs, text) {
  const key = draftKey(channel, threadTs);
  if (!text) {
    delete _drafts[key];
  } else {
    _drafts[key] = text;
  }
  _persistDrafts();
}

function saveDraftDebounced(channel, threadTs, text) {
  const key = draftKey(channel, threadTs);
  clearTimeout(_draftTimers[key]);
  _draftTimers[key] = setTimeout(() => saveDraft(channel, threadTs, text), DRAFT_SAVE_DELAY);
}

function clearDraft(channel, threadTs) {
  const key = draftKey(channel, threadTs);
  clearTimeout(_draftTimers[key]);
  delete _drafts[key];
  _persistDrafts();
}

function loadDraftIntoForm(form, input, channel, threadTs) {
  const key = draftKey(channel, threadTs);
  const text = _drafts[key];
  if (text) {
    input.value = text;
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }
  input.addEventListener('input', () => {
    saveDraftDebounced(channel, threadTs, input.value);
    _flashDraftSaved(form);
  });
  form._draftChannel = channel;
  form._draftThreadTs = threadTs;
}

function _flashDraftSaved(form) {
  const el = form?.querySelector('.draft-saved');
  if (!el) return;
  el.classList.add('visible');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('visible'), 1000);
}

// ── Demo mode (anonymization — extract text, batch LLM calls, apply) ──
const DEMO_BATCH_SIZE = 20;

function runDemoAnonymize() {
  const data = lastRenderData || cachedView?.data;
  if (!data) return;

  // Collect unique names and channels (skip bot IDs and very short strings)
  const names = [...new Set(Object.values(data.users || {}).filter(n => n && n.length > 2 && !/^[BUW][A-Z0-9]{8,}$/.test(n)))];
  const channels = [...new Set(Object.values(data.channels || {}).filter(c => c && c.length > 2))];

  // Collect visible text snippets for product/project name detection
  const snippets = new Set();
  for (const el of bodyEl.querySelectorAll('.item-reason-toggle, .deep-summary, .item-text')) {
    const t = el.textContent.trim();
    if (t && t.length > 5 && t.length < 300) snippets.add(t);
  }

  // Merge names + channels into one list of items to anonymize, then batch
  const allItems = [...names.map(n => ({ type: 'name', value: n })), ...channels.map(c => ({ type: 'channel', value: c }))];
  console.log(`[fslack] demo: ${names.length} names, ${channels.length} channels, ${snippets.size} snippets → ${Math.ceil(allItems.length / DEMO_BATCH_SIZE)} batches`);
  if (allItems.length === 0) return;

  const overlay = document.createElement('div');
  overlay.id = 'demo-loading';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(26,29,33,0.85);display:flex;align-items:center;justify-content:center;color:#1d9bd1;font-size:14px;';
  document.body.appendChild(overlay);

  // Split into batches
  const batches = [];
  for (let i = 0; i < allItems.length; i += DEMO_BATCH_SIZE) {
    const batch = allItems.slice(i, i + DEMO_BATCH_SIZE);
    batches.push({
      names: batch.filter(x => x.type === 'name').map(x => x.value),
      channels: batch.filter(x => x.type === 'channel').map(x => x.value),
    });
  }
  // Only first batch gets snippets (for product name detection)
  const snippetArr = [...snippets].slice(0, 30);

  let done = 0;
  overlay.textContent = `Anonymizing for demo... 0/${batches.length}`;

  // Fire all batches in parallel, apply each as it arrives
  for (let idx = 0; idx < batches.length; idx++) {
    const batch = batches[idx];
    chrome.runtime.sendMessage({
      type: `${FSLACK}:anonymize`,
      data: { names: batch.names, channels: batch.channels, snippets: idx === 0 ? snippetArr : [] },
    }, (resp) => {
      done++;
      overlay.textContent = `Anonymizing for demo... ${done}/${batches.length}`;
      if (resp?.map) {
        console.log(`[fslack] demo: batch ${idx} got ${Object.keys(resp.map).length} replacements`);
        applyDemoReplacements(resp.map);
      } else {
        console.warn(`[fslack] demo: batch ${idx} failed:`, resp?.error);
      }
      if (done === batches.length) overlay.remove();
    });
  }
}

function applyDemoReplacements(map) {
  // Sort by length descending to avoid partial matches (e.g. "Josh" before "Jo")
  const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length);

  // Walk all text nodes in the body
  const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    let text = node.nodeValue;
    let changed = false;
    for (const [real, fake] of entries) {
      if (text.includes(real)) {
        text = text.split(real).join(fake);
        changed = true;
      }
      // Also try lowercase match
      const realLower = real.toLowerCase();
      if (realLower !== real && text.toLowerCase().includes(realLower)) {
        const re = new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        text = text.replace(re, fake);
        changed = true;
      }
    }
    if (changed) node.nodeValue = text;
  }
}

// ── Port connection to background.js ──
let port = null;
const pendingOneShot = {}; // { requestId: callback } for one-off response handlers

function connectPort() {
  console.log('[fslack panel] connectPort()');
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener((msg) => {
    console.log(`[fslack panel] received: ${msg.type}`);
    handlePortMessage(msg);
  });
  port.onDisconnect.addListener(() => {
    console.log('[fslack panel] port disconnected');
    port = null;
    stopDmWatcher();
    // Try to reconnect after a brief delay
    setTimeout(() => {
      try { connectPort(); } catch {}
    }, 1000);
  });
  // Signal to content.js that we're connected
  port.postMessage({ type: `${FSLACK}:sidepanelConnected` });

  // Retry sidepanelConnected after 1s in case content.js wasn't ready on first signal
  setTimeout(() => {
    if (port && !bodyEl.querySelector('.item')) {
      port.postMessage({ type: `${FSLACK}:sidepanelConnected` });
    }
  }, 1000);

  // If no fslack:ready arrives within 5s, nudge the user
  setTimeout(() => {
    const status = document.getElementById('status');
    if (status && status.textContent === 'Waiting for Slack tab...') {
      status.innerHTML = 'No Slack tab found. Open <a href="https://app.slack.com" target="_blank" style="color:#1d9bd1">app.slack.com</a> then <a class="inline-refresh" style="color:#1d9bd1;cursor:pointer">refresh</a>.';
    }
  }, 5000);
}

let fetchTimeoutTimer = null;
function clearFetchTimeout() { if (fetchTimeoutTimer) { clearTimeout(fetchTimeoutTimer); fetchTimeoutTimer = null; } }
function startFetchTimeout(ms = 15000) {
  clearFetchTimeout();
  fetchTimeoutTimer = setTimeout(() => {
    fetchTimeoutTimer = null;
    console.warn('[fslack] fetch timeout — no response received');
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch Unreads';
    if (isBackgroundFetch) {
      isBackgroundFetch = false;
      scheduleBackgroundPoll();
    } else {
      refreshLink.textContent = 'refresh now';
      refreshLink.style.display = '';
      const statusEl = document.getElementById('status');
      if (statusEl && (statusEl.textContent.includes('Starting') || statusEl.textContent.includes('Fetching'))) {
        bodyEl.innerHTML = '<div id="status" class="error">Fetch timed out. Make sure a Slack tab is open and try again.</div>';
      }
    }
    resetFetchState();
  }, ms);
}

function sendToInject(msg) {
  if (!port) {
    console.warn('[fslack] sendToInject: port is null, message dropped:', msg.type);
    return false;
  }
  try { port.postMessage(msg); return true; } catch (e) {
    console.warn('[fslack] sendToInject failed:', e.message);
    return false;
  }
}

// ── DOM refs (direct, no shadow DOM) ──
const overlay = document.getElementById('overlay');
const bodyEl = document.getElementById('body');
const fetchBtn = { disabled: false, textContent: '', addEventListener() {} };
const lastUpdatedEl = document.getElementById('last-updated');
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
const lightbox = document.getElementById('lightbox');
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

const closeBtn = document.getElementById('close-btn');
const refreshLink = document.getElementById('refresh-link');
document.getElementById('settings-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── Slack link click handler: navigate existing tab instead of opening new ones ──
// Cmd/Ctrl-click or middle-click still opens in new tab (browser default)
document.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const link = e.target.closest('a[href]');
  if (!link) return;
  const href = link.href;
  if (!href || !href.startsWith('https://app.slack.com/')) return;
  e.preventDefault();
  // Navigate the existing Slack tab
  chrome.runtime.sendMessage({ type: `${FSLACK}:navigateSlackTab`, url: href });
}, true);
refreshLink.addEventListener('click', () => {
  if (stagedRenderData) {
    // Render pre-fetched background data
    const data = stagedRenderData;
    stagedRenderData = null;
    refreshLink.textContent = 'refresh now';
    refreshLink.classList.remove('has-update');
    isBackgroundFetch = false;
    lastFetchTime = Date.now();
    updateLastUpdated();
    if (lastUpdatedTimer) clearInterval(lastUpdatedTimer);
    lastUpdatedTimer = setInterval(updateLastUpdated, 1000);
    prioritizeAndRender(data);
  } else {
    startFetch();
  }
});


// ── In-place Slack navigation (via relay to inject.js) ──
// Navigation is handled by native <a> tags with href — no inject relay needed.

// ── Debug (temporary) ──
window._fslackDebug = function(channelId) {
  const cid = channelId || 'C093Q028BPF'; // dia-release-leads
  if (!cachedView) { console.log('[debug] no cached view'); return; }
  const d = cachedView.data || {};
  const p = cachedView.prioritized || {};
  const info = {
    selfId: d.selfId,
    channelName: (d.channels || {})[cid],
    channelMeta: (d.channelMeta || {})[cid],
    sidebarSection: sidebarSections[cid] || null,
    rawChannelPost: (d.channelPosts || []).find(cp => cp.channel_id === cid),
    rawThread: (d.threads || []).find(t => t.channel_id === cid),
    inActNow: (p.actNow || []).filter(i => i.channel_id === cid).map(i => ({ _type: i._type, _isMentioned: i._isMentioned, _llmId: i._llmId, _reason: i._reason })),
    inPriority: (p.priority || []).filter(i => i.channel_id === cid).map(i => ({ _type: i._type, _isMentioned: i._isMentioned, _llmId: i._llmId, _reason: i._reason })),
    inWhenFree: (p.whenFree || []).filter(i => i.channel_id === cid).map(i => ({ _type: i._type, _isMentioned: i._isMentioned, _llmId: i._llmId })),
    inNoise: (p.noise || []).filter(i => i.channel_id === cid).map(i => ({ _type: i._type, _isMentioned: i._isMentioned, _llmId: i._llmId })),
    preFilterLog: window._preFilterLog?.[cid] || 'no log',
  };
  const json = JSON.stringify(info, null, 2);
  navigator.clipboard.writeText(json).then(() => console.log('[debug] copied to clipboard'));
  console.log('[debug]', json);
  return info;
};

// ── State ──
let cachedView = null; // { data, popular, prioritized, ts }
let persistedFetchTs = 0; // lightweight timestamp that always persists to storage
let sidebarSections = {};    // { [channelId]: 'floor_priority'|'floor_whenfree'|'hard_noise'|'skip'|'normal' }
let savedMsgKeys = new Set(); // Set of "channel:ts" strings for saved messages
let myReactionsMap = {};     // { "channel:ts": ["+1", "yellow_heart", ...] }
let vipSeenTimestamps = {};   // { [vipName]: latestSeenTs } — messages at or before this ts are hidden
let customEmojiMap = null;
let standardEmojiMap = null;
let channelNameMap = {};
let cachedUserMap = {};
let cachedFullNameMap = {};
let cachedUserMentionHints = {};
let reactionRequestCounter = 0;
const pendingReactButtons = {};
const pendingUnreactButtons = {};
let focusedItemIndex = -1;  // keyboard nav: index into visible items, -1 = none
let dmWatchTimer = null;         // interval ID for new-DM polling
let knownDmChannelIds = new Set(); // DM channels already in the current render
let mutedThreadKeys = new Set();   // Set of "channel:threadTs" strings for muted threads
let autoRefreshTimer = null;       // background poll timer
let isBackgroundFetch = false;     // true when fetching silently in background
let stagedRenderData = null;       // data fetched in background, waiting for user to display

// ── LLM result caches (persist across fetches) ──
// Prioritization: hash-based dedup to skip Claude calls when inbox unchanged
let _prioritizationCache = null; // { importantHash, publicHash, result: { priorities, noiseOrder, reasons } }
// Channel summaries: keyed by "channelId:latestTs"
let _summaryCache = {};
// VIP summaries: keyed by "vipName:latestTs"
let _vipSummaryCache = {};
// All summary types: keyed by "type:channelId:ts"
let _allSummaryCache = {};
// Per-item batch summaries: keyed by djb2 hash of serialized item → summary string
let _itemSummaryCache = {};

// Simple string hash (djb2)
function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}

// Load LLM caches from chrome.storage.local
chrome.storage.local.get(['fslackPrioritizationCache', 'fslackSummaryCache', 'fslackVipSummaryCache', 'fslackAllSummaryCache', 'fslackItemSummaryCache'], (cached) => {
  if (cached.fslackPrioritizationCache) _prioritizationCache = cached.fslackPrioritizationCache;
  if (cached.fslackSummaryCache) _summaryCache = cached.fslackSummaryCache;
  if (cached.fslackVipSummaryCache) _vipSummaryCache = cached.fslackVipSummaryCache;
  if (cached.fslackAllSummaryCache) _allSummaryCache = cached.fslackAllSummaryCache;
  if (cached.fslackItemSummaryCache) _itemSummaryCache = cached.fslackItemSummaryCache;
});

// Preload custom emoji + channel names from cache for instant render on showFromCache()
const USERS_CACHE_VERSION = 2; // bump to invalidate stale user name cache
chrome.storage.local.get(['fslackEmoji', 'fslackEmojiTs', 'fslackChannels', 'fslackUsers', 'fslackUserMentionHints', 'fslackUsersCacheVersion'], (cached) => {
  const EMOJI_TTL_MS = 24 * 60 * 60 * 1000;
  if (cached.fslackEmoji && cached.fslackEmojiTs && Date.now() - cached.fslackEmojiTs < EMOJI_TTL_MS) {
    customEmojiMap = cached.fslackEmoji;
  }
  if (cached.fslackChannels) channelNameMap = cached.fslackChannels;
  if (cached.fslackUsersCacheVersion === USERS_CACHE_VERSION) {
    if (cached.fslackUsers) mergeCachedUsers(cached.fslackUsers);
    if (cached.fslackUserMentionHints) mergeCachedMentionHints(cached.fslackUserMentionHints, { replace: true });
  } else {
    chrome.storage.local.remove(['fslackUsers', 'fslackUserMentionHints']);
    chrome.storage.local.set({ fslackUsersCacheVersion: USERS_CACHE_VERSION });
  }
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
function loadCachedPrefs(callback) {
  chrome.storage.local.get(['fslackUsers', 'fslackFullNames', 'fslackUserMentionHints', 'fslackChannels', 'fslackChannelMeta', 'fslackSavedMsgs', 'fslackEmoji', 'fslackEmojiTs', 'fslackVipSeen', 'fslackMutedThreads'], (cached) => {
    savedMsgKeys = new Set(cached.fslackSavedMsgs || []);
    vipSeenTimestamps = cached.fslackVipSeen || {};
    mutedThreadKeys = new Set(cached.fslackMutedThreads || []);
    mergeCachedUsers(cached.fslackUsers || {});
    mergeCachedFullNames(cached.fslackFullNames || {});
    mergeCachedMentionHints(cached.fslackUserMentionHints || {}, { replace: true });
    const EMOJI_TTL_MS = 24 * 60 * 60 * 1000;
    const cachedEmoji = (cached.fslackEmojiTs && Date.now() - cached.fslackEmojiTs < EMOJI_TTL_MS)
      ? (cached.fslackEmoji || {}) : null;
    callback({
      cachedUsers: cached.fslackUsers || {},
      cachedFullNames: cached.fslackFullNames || {},
      cachedUserMentionHints: cached.fslackUserMentionHints || {},
      cachedChannels: cached.fslackChannels || {},
      cachedChannelMeta: cached.fslackChannelMeta || {},
      cachedEmoji,
    });
  });
}

function startFetch(background = false) {
  if (fetchBtn.disabled) return;
  if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
  isBackgroundFetch = background;
  fetchBtn.disabled = true;
  if (!background) {
    fetchBtn.textContent = 'Fetching...';
    bodyEl.innerHTML = '<div id="status">Starting fetch...</div>';
    stagedRenderData = null;
    refreshLink.style.display = 'none';
    refreshLink.classList.remove('has-update');
  }
  resetFetchState();
  isFastFetch = true;

  if (!port) {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch Unreads';
    isBackgroundFetch = false;
    if (!background) {
      refreshLink.textContent = 'refresh now';
      refreshLink.style.display = '';
      bodyEl.innerHTML = '<div id="status" class="error">Not connected. Make sure a Slack tab is open and try again.</div>';
    }
    return;
  }

  // First-ever fetch or stale cache (>1h): auto-promote to full fetch
  if (!cachedView || (cachedView.ts && Date.now() - cachedView.ts > 60 * 60 * 1000)) {
    if (background) {
      // Do full fetch silently — don't wipe the UI
      console.log(`[fslack] ${!cachedView ? 'No cached view' : 'Cache >1h old'} — background full fetch (no UI wipe)`);
      resetFetchState();
      isFastFetch = false;
      startFetchTimeout();
      loadCachedPrefs((cachePayload) => {
        sendToInject({ type: `${FSLACK}:fetch`, ...cachePayload });
      });
      return;
    }
    console.log(`[fslack] ${!cachedView ? 'No cached view' : 'Cache >1h old'} — auto-promoting to full fetch`);
    fetchBtn.disabled = false; // allow startFullFetch to proceed
    startFullFetch();
    return;
  }

  startFetchTimeout();
  loadCachedPrefs((cachePayload) => {
    sendToInject({ type: `${FSLACK}:fetchFast`, ...cachePayload });
  });
  // Only fetch popular/saved if we don't have them cached
  if (!cachedView?.popular || cachedView.popular.length === 0) {
    sendToInject({ type: `${FSLACK}:fetchPopular` });
  } else {
    pendingPopular = cachedView.popular;
    gotPopular = true;
  }
  if (!cachedView?.saved || cachedView.saved.length === 0) {
    sendToInject({ type: `${FSLACK}:fetchSaved`, requestId: `saved_${Date.now()}` });
  } else {
    pendingSaved = cachedView.saved;
    gotSaved = true;
  }
}

function scheduleBackgroundPoll() {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(() => {
    autoRefreshTimer = null;
    if (!fetchBtn.disabled && !stagedRenderData) startFetch(true);
  }, 5 * 60 * 1000);
}

function startFullFetch() {
  if (fetchBtn.disabled) return;
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Fetching...';
  refreshLink.style.display = 'none';
  bodyEl.innerHTML = '<div id="status">Starting full fetch...</div>';
  resetFetchState();
  isFastFetch = false;
  if (!port) {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch Unreads';
    refreshLink.textContent = 'refresh now';
    refreshLink.style.display = '';
    bodyEl.innerHTML = '<div id="status" class="error">Not connected. Make sure a Slack tab is open and try again.</div>';
    return;
  }
  startFetchTimeout();
  loadCachedPrefs((cachePayload) => {
    sendToInject({ type: `${FSLACK}:fetch`, ...cachePayload });
  });
  sendToInject({ type: `${FSLACK}:fetchPopular` });
  sendToInject({ type: `${FSLACK}:fetchSaved`, requestId: `saved_${Date.now()}` });
}

function showFromCache() {
  // Full cache available and fresh — render it
  if (cachedView && Date.now() - cachedView.ts < 300000) {
    lastFetchTime = cachedView.ts;
    updateLastUpdated();
    if (lastUpdatedTimer) clearInterval(lastUpdatedTimer);
    lastUpdatedTimer = setInterval(updateLastUpdated, 1000);
    renderPrioritized(cachedView.prioritized, cachedView.data, cachedView.popular, false, false, cachedView.saved || [], false, cachedView.ts);
    runBotThreadSummarization(cachedView.prioritized.whenFree || [], cachedView.data);
    runWhenFreeChannelSummarization(cachedView.prioritized.whenFree || [], cachedView.data);
    const allElevatedCache = [...(cachedView.prioritized.actNow || []), ...(cachedView.prioritized.priority || []), ...(cachedView.prioritized.whenFree || [])];
    runThreadReplySummarization(allElevatedCache, cachedView.data);
    runChannelThreadSummarization(allElevatedCache, cachedView.data);
    runRootSummarization(allElevatedCache, cachedView.data);
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
  if (lightbox.classList.contains('open')) return;
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
      if (key === 'ArrowRight' && !isExpanded) {
        focused.click();
        // Move cursor to first item inside the expanded section
        requestAnimationFrame(() => focusItem(focusedItemIndex + 1));
      }
      if (key === 'ArrowLeft' && isExpanded) focused.click();
      return;
    }
    const isRow = focused.classList.contains('msg-row');
    const parentItem = isRow ? focused.closest('.item') : focused;
    const scope = isRow ? focused : focused;
    const showMsgsLink = (isRow ? focused : parentItem)?.querySelector('.show-messages-link[data-target]');
    const showMsgsTarget = showMsgsLink ? document.getElementById(showMsgsLink.dataset.target) : null;
    // Also check for summary-toggle on the item (noise items, when-free channel items)
    const summaryToggleEl = parentItem?.querySelector('.summary-toggle[data-target]');
    const summaryTarget = summaryToggleEl ? document.getElementById(summaryToggleEl.dataset.target) : null;
    const reasonToggle = parentItem?.querySelector('.item-reason-toggle');
    const detailsEl = reasonToggle?.nextElementSibling;
    const hasDetails = detailsEl?.classList.contains('item-details');
    const isExpanded = isThreadExpanded(scope) || isTextExpanded(scope) || (showMsgsTarget && showMsgsTarget.style.display === 'block') || (summaryTarget && summaryTarget.style.display === 'block') || (hasDetails && detailsEl.classList.contains('expanded'));
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
      if (summaryToggleEl && summaryTarget && summaryTarget.style.display !== 'block') summaryToggleEl.click();
      if (hasDetails && !detailsEl.classList.contains('expanded')) reasonToggle.click();
      // After expand, move cursor into the first visible child
      requestAnimationFrame(() => {
        const els = getNavigableElements();
        const firstRow = parentItem?.querySelector('.msg-row');
        const rowIdx = firstRow ? els.indexOf(firstRow) : -1;
        if (rowIdx >= 0) focusItem(rowIdx);
        else {
          // Fallback: re-resolve current position
          const newIdx = els.indexOf(focused);
          if (newIdx >= 0) focusedItemIndex = newIdx;
        }
      });
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
      if (summaryTarget && summaryTarget.style.display === 'block') summaryToggleEl.click();
      if (hasDetails && detailsEl.classList.contains('expanded')) reasonToggle.click();
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
    const showMsgsTarget = showMsgsLink ? document.getElementById(showMsgsLink.dataset.target) : null;
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
    else if (k === 'o' && !parentItem?.classList.contains('vip-item')) (parentItem?.querySelector('.item-left-link') || parentItem?.querySelector('.item-channel[data-channel]'))?.click();
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
  // Inline code: `text` (extract first so content is protected from bold/italic/strike)
  html = html.replace(/(<[^>]*>)|`([^`\n]+)`/g, (match, tag, code) => {
    if (tag) return tag;
    return `<code>${code}</code>`;
  });
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
      result += `<a class="item-channel inline-channel" data-channel="${escapeHtml(cid)}" href="https://app.slack.com/archives/${escapeHtml(cid)}" target="_blank">#${escapeHtml(name)}</a>`;
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

function userLink(name, channel, ts, threadTs) {
  if (!channel || !ts) return `<span class="item-user">${name}:</span>`;
  const href = slackPermalink(channel, ts, threadTs);
  return `<a class="item-user" data-channel="${channel}" data-ts="${ts}" href="${href}" target="_blank">${name}:</a>`;
}

function channelLink(label, channelId) {
  if (!channelId) return `<span class="item-channel">${label}</span>`;
  const href = `https://app.slack.com/archives/${channelId}`;
  return `<a class="item-channel" data-channel="${channelId}" href="${href}" target="_blank">${label}</a>`;
}

function itemLeftLink(innerHtml, href) {
  if (!href) return innerHtml;
  return `<a class="item-left-link" href="${href}" target="_blank">${innerHtml}<span class="open-slack-label">open in Slack ↗</span></a>`;
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

function renderFwd(fwd, users, max = 300) {
  if (!fwd) return '';
  const label = fwd.author ? `fwd from ${escapeHtml(fwd.author)}` : 'fwd';
  const cleaned = cleanSlackText(fwd.text, users);
  if (cleaned.length <= max) {
    const body = formatSlackHtml(fwd.text, users);
    return `<blockquote class="fwd-quote"><span class="fwd-label">${label}</span>${body}</blockquote>`;
  }
  const id = `trunc_${++truncateId}`;
  const short = applyEmoji(applyMrkdwn(escapeHtml(cleaned.replace(/\n+/g, ' ').slice(0, max))), customEmojiMap);
  const full = formatSlackHtml(fwd.text, users);
  return `<blockquote class="fwd-quote"><span class="fwd-label">${label}</span><span id="${id}-short">${short}... <span class="see-more" data-trunc-id="${id}">See more</span></span><span id="${id}-full" style="display:none">${full} <span class="see-less" data-trunc-id="${id}">See less</span></span></blockquote>`;
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
  const outerTruncId = truncateId;
  const fwdHtml = renderFwd(m.fwd, users);
  const filesHtml = renderFiles(m.files);
  const extras = fwdHtml + filesHtml;
  const timeHtml = badge ? '' : msgTime(m.ts, channel);
  if (wasTruncated && extras) {
    return textHtml + `<span id="trunc_${outerTruncId}-files" style="display:none">${extras}</span>` + badge + timeHtml;
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
  // Always summarize threads where the user was @mentioned (explains why they were tagged)
  if (t._isMentioned) return true;
  const replies = t.unread_replies || [];
  const totalChars = replies.reduce((sum, r) => sum + (r.text || '').length, 0);
  return totalChars >= 300;
}

// threadTs = root ts for reply context. isDm = true sends reply as top-level DM (no thread).
function msgActions(channel, ts, { showReply = true } = {}) {
  const saved = savedMsgKeys.has(`${channel}:${ts}`);
  const saveClass = saved ? ' saved' : '';
  const fill = saved ? 'currentColor' : 'none';
  const myReactions = myReactionsMap[`${channel}:${ts}`] || [];
  const likeClass = myReactions.includes('+1') ? ' reacted' : '';
  const heartClass = myReactions.includes('yellow_heart') ? ' reacted' : '';
  const bookmarkSvg = `<svg class="action-icon" viewBox="0 0 16 16" width="14" height="14" fill="${fill}" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2.5h9v12l-4.5-3-4.5 3z"/></svg>`;
  const replySvg = `<svg class="action-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5L1.5 8.5L5 12"/><path d="M1.5 8.5h7c3 0 5 1.5 5 4.5"/></svg>`;
  const replyBtn = showReply
    ? `<span class="action-btn action-msg-reply" data-channel="${channel}" data-ts="${ts}" title="Reply in thread">${replySvg}<kbd>R</kbd></span>`
    : '';
  return `<div class="msg-actions"><span class="action-btn action-react${likeClass}" data-channel="${channel}" data-ts="${ts}" data-emoji="+1" title="+1">👍<kbd>L</kbd></span><span class="action-btn action-react${heartClass}" data-channel="${channel}" data-ts="${ts}" data-emoji="yellow_heart" title="Heart">💛<kbd>H</kbd></span><span class="action-btn action-save${saveClass}" data-channel="${channel}" data-ts="${ts}" title="Save">${bookmarkSvg}<kbd>S</kbd></span>${replyBtn}</div>`;
}

function slackPermalink(channel, ts, threadTs) {
  if (!channel || !ts) return '';
  let url = `https://app.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
  if (threadTs && threadTs !== ts) url += `?thread_ts=${threadTs}&cid=${channel}`;
  return url;
}

function msgTime(ts, channel, threadTs) {
  const t = formatTimeTooltip(ts);
  if (!t) return '';
  const attrs = channel && ts ? ` data-channel="${channel}" data-ts="${ts}"` : '';
  const href = slackPermalink(channel, ts, threadTs);
  if (href) return `<a class="msg-time"${attrs} href="${href}" target="_blank">${t}</a>`;
  return `<span class="msg-time"${attrs}>${t}</span>`;
}

function itemTime(ts, channel) {
  const attrs = channel && ts ? ` data-channel="${channel}" data-ts="${ts}"` : '';
  const href = slackPermalink(channel, ts);
  if (href) return `<a class="item-time"${attrs} href="${href}" target="_blank">${formatTime(ts)}</a>`;
  return `<span class="item-time"${attrs}>${formatTime(ts)}</span>`;
}

function itemActions(channel, markTs, threadTs, isDm, channelName = '', _unused = false, hasMention = false) {
  return `<div class="item-actions">
    <span class="mark-all-read" data-channel="${channel}" data-ts="${markTs}"${threadTs ? ` data-thread-ts="${threadTs}"` : ''}${hasMention ? ' data-has-mention="1"' : ''}><kbd>M</kbd> mark read</span>
    ${threadTs || isDm ? `<span class="action-reply" data-channel="${channel}" data-ts="${threadTs || markTs}"${isDm ? ' data-dm="true"' : ''}>${isDm ? 'send a DM' : 'reply'}</span>` : ''}
    ${threadTs ? `<span class="action-mute" data-channel="${channel}" data-thread-ts="${threadTs}"><kbd>T</kbd> mute thread</span>` : ''}
    ${!threadTs && !isDm ? `<span class="action-mute-channel" data-channel="${channel}"><kbd>T</kbd> mute channel</span>` : ''}
    <span class="mark-above-read">mark above read</span>
  </div>`;
}

function reasonBadge(item, cssClass) {
  if (!item._reason) return '';
  const cls = cssClass === 'act-now' ? 'reason-act-now' : 'reason-priority';
  return `<div class="item-reason item-reason-toggle ${cls}">${escapeHtml(item._reason)} ↓</div>`;
}

// Shared toggle structure: bullet summary (clickable) → hidden messages
// Parse channel summary bullet, extracting optional [ts] prefix for linking
function renderChannelSummaryBullet(bullet, channelId) {
  const stripped = bullet.replace(/^-\s*/, '');
  const tsMatch = stripped.match(/^\[(\d+\.\d+)\]\s*/);
  if (tsMatch && channelId) {
    const ts = tsMatch[1];
    const text = stripped.slice(tsMatch[0].length);
    const href = slackPermalink(channelId, ts);
    return `<li><a class="summary-bullet-link" href="${href}" target="_blank" data-channel="${channelId}" data-ts="${ts}">${escapeHtml(text)}</a></li>`;
  }
  return `<li>${escapeHtml(stripped)}</li>`;
}

function renderChannelSummaryBullets(summary, channelId) {
  return summary.split('\n').filter(b => b.trim()).map(b => renderChannelSummaryBullet(b, channelId)).join('');
}

function summaryToggleHtml(targetId, bulletsHtml, messagesHtml, extraContent) {
  return `<div class="summary-toggle-group" data-target="${targetId}">`
    + `<div class="deep-summary-wrap">${extraContent || ''}<ul class="deep-summary">${bulletsHtml}</ul></div>`
    + `</div>`
    + `<div class="deep-messages" id="${targetId}">${messagesHtml}</div>`;
}

// Header expand link for item-left: "N msgs ↓"
function headerExpandHtml(targetId, count, unit) {
  if (!unit) unit = count === 1 ? 'msg' : 'msgs';
  return `<span class="header-expand summary-toggle" data-target="${targetId}"><span class="summary-reply-count"><span class="collapse-label">collapse </span>${count} ${unit} ↓</span></span>`;
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
  const isRootFromSelf = t.root_user === data.selfId;
  const shouldSummarize = threadNeedsSummary(t);
  const threadKey = shouldSummarize ? `thread-summary-${t.channel_id}-${(t.ts || '').replace('.', '_')}` : '';
  const repliesMsgId = shouldSummarize ? `${threadKey}-replies` : '';
  const collapsible = cssClass === 'act-now' || cssClass === 'priority-item';
  let html = `<div class="item ${cssClass}">`;
  html += reasonBadge(t, cssClass);
  if (collapsible) html += '<div class="item-details">';
  const threadOpenHref = slackPermalink(t.channel_id, t.ts) || `https://app.slack.com/archives/${t.channel_id}`;
  if (shouldSummarize) {
    html += `<div class="item-left">`;
    html += `<a class="item-channel-link" href="${threadOpenHref}" target="_blank"><span class="item-channel">${channelLabel}</span><span class="open-in-slack"> open in Slack ↗</span></a>`;
    html += ` <span class="item-sep">·</span> <span class="item-time">${formatTime(markAllTs)}</span>`;
    if (!t._mentionInReplies && t.mention_count > 0) {
      html += ` <span class="item-sep">·</span> <span class="item-mention">@mentioned</span>`;
    }
    html += ` <span class="item-sep">·</span> ${headerExpandHtml(repliesMsgId, unread.length, unread.length === 1 ? 'new reply' : 'new replies')}`;
    html += `</div>`;
  } else {
    let leftInner = `<span class="item-channel">${channelLabel}</span> <span class="item-sep">·</span> <span class="item-time">${formatTime(markAllTs)}</span>`;
    if (!t._mentionInReplies && t.mention_count > 0) {
      leftInner += ` <span class="item-sep">·</span> <span class="item-mention">@mentioned</span>`;
    }
    html += `<div class="item-left">${itemLeftLink(leftInner, threadOpenHref)}</div>`;
  }

  // When full-thread summary is active, replace root content with bullet summary
  let rootContentHtml;
  let rootSeenClass = '';
  if (shouldSummarize && t._fullThreadSummary) {
    const bullets = t._fullThreadSummary.split('\n').filter(b => b.trim()).map(b => b.replace(/^-\s*/, ''));
    const selfName = (data.users?.[data.selfId] || '').toLowerCase();
    const rootBullet = bullets[0] || '';
    const rootNamePart = rootBullet.split(/\s/)[0].toLowerCase();
    const rootIsSelf = selfName && rootNamePart === selfName;
    const rootHtml = `<div class="deep-summary${rootIsSelf ? ' self-bullet' : ''}" style="margin:2px 0">${escapeHtml(rootBullet)}</div>`;
    let repliesHtml = '';
    if (bullets.length > 1) {
      const replyLis = bullets.slice(1).map(b => {
        const namePart = b.split(/\s/)[0].toLowerCase();
        const isSelf = selfName && namePart === selfName;
        return `<li${isSelf ? ' class="self-bullet"' : ''}>${escapeHtml(b)}</li>`;
      }).join('');
      repliesHtml = `<ul class="deep-summary deep-replies">${replyLis}</ul>`;
    }
    rootContentHtml = `${rootHtml}${repliesHtml}`;
  } else if (shouldSummarize && !t._fullThreadSummary) {
    rootContentHtml = `<div id="${threadKey}-loading" style="color:#555;font-size:12px;font-style:italic;margin:2px 0">Summarizing thread...</div>`;
  } else {
    rootSeenClass = (seenCount > 0 || isRootFromSelf) ? ' root-seen' : '';
    const needsRootSummary = (seenCount > 0 || isRootFromSelf) && (t.root_text || '').length > 300;
    if (needsRootSummary && t._rootSummary) {
      rootContentHtml = `${userLink(uname(t.root_user, data.users), t.channel_id, t.ts)} <span class="root-summary">${escapeHtml(t._rootSummary)}</span>${msgTime(t.ts, t.channel_id)}`;
    } else if (needsRootSummary) {
      const rootSummaryKey = `root-summary-${t.channel_id}-${(t.ts || '').replace('.', '_')}`;
      const _rtid = truncateId;
      const rootTextHtml = truncate(t.root_text, 400, data.users);
      const rootExtras = wrapFilesIfTruncated(_rtid, renderFwd(t.root_fwd, data.users), renderFiles(t.root_files));
      rootContentHtml = `${userLink(uname(t.root_user, data.users), t.channel_id, t.ts)} <span id="${rootSummaryKey}" class="root-summary-pending">${rootTextHtml}${rootExtras}</span>${msgTime(t.ts, t.channel_id)}`;
    } else {
      const _rtid = truncateId;
      const rootTextHtml = truncate(t.root_text, 400, data.users);
      const rootExtras = wrapFilesIfTruncated(_rtid, renderFwd(t.root_fwd, data.users), renderFiles(t.root_files));
      rootContentHtml = `${userLink(uname(t.root_user, data.users), t.channel_id, t.ts)} ${rootTextHtml}${rootExtras}${msgTime(t.ts, t.channel_id)}`;
    }
  }
  let origRootHtml = '';
  if (shouldSummarize) {
    const _ortid = truncateId;
    const origText = truncate(t.root_text, 400, data.users);
    const origExtras = wrapFilesIfTruncated(_ortid, renderFwd(t.root_fwd, data.users), renderFiles(t.root_files));
    origRootHtml = `<div class="msg-content item-text thread-orig-root" style="display:none">${userLink(uname(t.root_user, data.users), t.channel_id, t.ts)} ${origText}${origExtras}${msgTime(t.ts, t.channel_id)}</div>`;
  }
  const sumClass = shouldSummarize ? ' summarized' : '';
  html += `<div class="item-right">`;
  const msgContentClass = `msg-content item-text${rootSeenClass}${shouldSummarize ? ' summary-toggle' : ''}`;
  const msgContentTarget = shouldSummarize ? ` data-target="${repliesMsgId}"` : '';
  html += `<div class="msg-row${sumClass}"><div class="${msgContentClass}"${msgContentTarget}>${rootContentHtml}</div>${origRootHtml}${msgActions(t.channel_id, t.ts)}</div>`;

  html += '<div class="thread-replies-container">';
  if (shouldSummarize) {
    html += `<div class="deep-messages" id="${repliesMsgId}">`;
  }
  if (seenCount > 0) {
    const unreadTs = unread.map((r) => r.ts).join(',');
    html += `<div class="seen-replies-toggle" data-channel="${t.channel_id}" data-ts="${t.ts}" data-unread-ts="${unreadTs}">${seenCount} earlier ${seenCount === 1 ? 'reply' : 'replies'}</div>`;
    html += `<div class="seen-replies-container" data-for="${t.channel_id}-${t.ts}"></div>`;
  }

  for (const r of unread) {
    const _urtid = truncateId;
    const rTextHtml = truncate(r.text, 1000, data.users);
    const rExtras = wrapFilesIfTruncated(_urtid, renderFwd(r.fwd, data.users), renderFiles(r.files));
    html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(uname(r.user, data.users), t.channel_id, r.ts, t.ts)} ${rTextHtml}${rExtras}${msgTime(r.ts, t.channel_id, t.ts)}</div>${msgActions(t.channel_id, r.ts)}</div>`;
  }

  if (shouldSummarize) {
    html += '</div>';
  }

  html += '</div>';
  html += itemActions(t.channel_id, markAllTs, t.ts, t._isDmThread, '', false, t._isMentioned || t.mention_count > 0);
  html += '</div>' + (collapsible ? '</div>' : '') + '</div>';
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
  const collapsible = cssClass === 'act-now' || cssClass === 'priority-item';
  let html = `<div class="item ${cssClass}">${reasonBadge(dm, cssClass)}
    ${collapsible ? '<div class="item-details">' : ''}
    <div class="item-left">
      ${itemLeftLink(`<span class="item-channel">${escapeHtml(partner)}</span> <span class="item-sep">·</span> <span class="item-time">${formatTime(latest.ts)}</span>`, slackPermalink(dm.channel_id, latest.ts) || `https://app.slack.com/archives/${dm.channel_id}`)}
    </div>
    <div class="item-right">`;
  const dmReversed = [...dm.messages].reverse();
  for (let i = 0; i < dmReversed.length; i++) {
    const m = dmReversed[i];
    const nextM = dmReversed[i + 1];
    const isLastInRun = !nextM || nextM.user !== m.user;
    const sender = dm.isGroup ? `${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), dm.channel_id, m.ts)} ` : '';
    const _dtid = truncateId;
    const dmTextHtml = truncate(m.text, 1000, data.users);
    const dmExtras = wrapFilesIfTruncated(_dtid, renderFwd(m.fwd, data.users), renderFiles(m.files));
    const timeHtml = isLastInRun ? msgTime(m.ts, dm.channel_id) : '';
    html += `<div class="msg-row"><div class="msg-content item-text">${sender}${dmTextHtml}${dmExtras}${timeHtml}</div>${msgActions(dm.channel_id, m.ts, { showReply: false })}</div>`;
  }
  html += itemActions(dm.channel_id, latest.ts, null, true);
  html += '</div>' + (collapsible ? '</div>' : '') + '</div>';
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
  const ch = (cp._isAllBot ? '🤖 ' : '') + (data.channels[cp.channel_id] || cp.channel_id);
  const latest = cp.messages[0];
  const collapsible = cssClass === 'act-now' || cssClass === 'priority-item';
  const needsChannelSummary = cssClass === 'when-free' && cp.messages.length >= 1 && !cp._isBotThread;
  const csKeyAttr = needsChannelSummary ? ` data-channel-summary-key="ch-post-summary-${cp.channel_id}-${(cp.sort_ts || '').replace('.', '_')}"` : '';
  const csKey = needsChannelSummary ? `ch-post-summary-${cp.channel_id}-${(cp.sort_ts || '').replace('.', '_')}` : '';
  const csMsgId = csKey ? `${csKey}-msgs` : '';
  let html = `<div class="item ${cssClass}"${csKeyAttr}>`;
  html += reasonBadge(cp, cssClass);
  if (collapsible) html += '<div class="item-details">';
  const chOpenHref = slackPermalink(cp.channel_id, latest?.ts) || `https://app.slack.com/archives/${cp.channel_id}`;
  if (needsChannelSummary || cssClass === 'noise-item') {
    // Split header: channel link + metadata + expand toggle
    html += `<div class="item-left">`;
    html += `<a class="item-channel-link" href="${chOpenHref}" target="_blank"><span class="item-channel">#${escapeHtml(ch)}</span><span class="open-in-slack"> open in Slack ↗</span></a>`;
    html += ` <span class="item-sep">·</span> <span class="item-time">${formatTime(latest?.ts)}</span>`;
    if (cp._repliers?.length) {
      const names = cp._repliers.map(escapeHtml).join(', ');
      const overflow = cp._replierOverflow > 0 ? ` +${cp._replierOverflow}` : '';
      html += ` <span class="item-sep">·</span> <span class="item-replied">${names}${overflow} replied</span>`;
    }
    if (csMsgId) html += ` <span class="item-sep">·</span> ${headerExpandHtml(csMsgId, cp.messages.length)}`;
    html += `</div>`;
  } else {
    let chLeftInner = `<span class="item-channel">#${escapeHtml(ch)}</span> <span class="item-sep">·</span> <span class="item-time">${formatTime(latest?.ts)}</span>`;
    if (cp._repliers?.length) {
      const names = cp._repliers.map(escapeHtml).join(', ');
      const overflow = cp._replierOverflow > 0 ? ` +${cp._replierOverflow}` : '';
      chLeftInner += ` <span class="item-sep">·</span> <span class="item-replied">${names}${overflow} replied</span>`;
    }
    html += `<div class="item-left">${itemLeftLink(chLeftInner, chOpenHref)}</div>`;
  }
  html += `<div class="item-right">`;
  if (cp._summary) {
    const zendesk = extractZendeskSummary(cp._summary);
    const summaryMsg = cp.messages[0];
    const senderName = summaryMsg ? (summaryMsg.subtype === 'bot_message' ? 'Bot' : uname(summaryMsg.user, data.users)) : 'Bot';
    html += `<div class="msg-row"><div class="msg-content item-text">${userLink(senderName, cp.channel_id, summaryMsg?.ts)} ${escapeHtml(zendesk || cp._summary)}</div>${summaryMsg ? msgActions(cp.channel_id, summaryMsg.ts) : ''}</div>`;
  } else if (cssClass === 'when-free' && cp.messages.length >= 1 && !cp._isBotThread) {
    // When-free channel items: show summary or loading state
    let messagesHtml = '';
    for (const m of cp.messages.slice(0, 10).reverse()) {
      const threadUi = buildThreadUiMeta(data, cp.channel_id, m);
      if (cp._summarizeThreads && (m.reply_count || 0) >= 5) {
        const threadTs = threadUi?.threadTs || m.ts;
        const containerId = threadUi?.containerId || `thread-${cp.channel_id}-${(threadTs || '').replace(/\./g, '_')}-${(m.ts || '').replace(/\./g, '_')}`;
        const modeAttr = threadUi?.mode ? ` data-mode="${threadUi.mode}"` : '';
        const afterAttr = threadUi?.afterTs ? ` data-after-ts="${threadUi.afterTs}"` : '';
        const tKey = `ch-thread-summary-${cp.channel_id}-${(m.ts || '').replace('.', '_')}`;
        const repliesId = `${tKey}-replies`;
        const summaryHtml = m._chThreadSummary
          ? `<div class="deep-summary" style="margin:6px 0 2px">${escapeHtml(m._chThreadSummary)}</div>`
          : `<div id="${tKey}-loading" style="color:#555;font-size:12px;font-style:italic;margin:6px 0 2px">Summarizing replies…</div>`;
        messagesHtml += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users, 400, threadUi, { skipBadge: true })}`
          + `<div class="thread-replies-container" data-channel="${cp.channel_id}" data-ts="${threadTs}" data-container-id="${containerId}"${modeAttr}${afterAttr}>`
          + summaryHtml
          + `<span class="show-messages-link" data-target="${repliesId}" data-fetch-replies="1" data-channel="${cp.channel_id}" data-ts="${threadTs}" style="margin-top:2px">show ${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'} ↓</span>`
          + `<div class="deep-messages" id="${repliesId}"></div>`
          + `</div></div>${msgActions(cp.channel_id, m.ts)}</div>`;
      } else {
        messagesHtml += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users, 400, threadUi)}${threadRepliesContainer(m, cp.channel_id, threadUi)}</div>${msgActions(cp.channel_id, m.ts)}</div>`;
      }
    }
    if (cp.messages.length > 10) {
      html += `<div class="item-text" style="color:#888;font-size:0.85em">+${cp.messages.length - 10} more messages</div>`;
    }
    if (cp._channelSummary) {
      const bullets = renderChannelSummaryBullets(cp._channelSummary, cp.channel_id);
      html += summaryToggleHtml(csMsgId, bullets, messagesHtml);
    } else {
      html += `<div class="msg-row"><div class="msg-content">
        <div id="${csKey}-loading" style="color:#555;font-size:12px;font-style:italic;margin-bottom:4px">Summarizing...</div>
      </div></div>
      <div class="deep-messages" style="display:block" id="${csMsgId}">${messagesHtml}</div>`;
    }
  } else {
    const visibleMsgs = cp.messages.slice(0, 10).reverse();
    for (const m of visibleMsgs) {
      const threadUi = buildThreadUiMeta(data, cp.channel_id, m);
      if (cp._summarizeThreads && (m.reply_count || 0) >= 5) {
        // Render message without thread badge; badge moves below summary
        const threadTs = threadUi?.threadTs || m.ts;
        const containerId = threadUi?.containerId || `thread-${cp.channel_id}-${(threadTs || '').replace(/\./g, '_')}-${(m.ts || '').replace(/\./g, '_')}`;
        const modeAttr = threadUi?.mode ? ` data-mode="${threadUi.mode}"` : '';
        const afterAttr = threadUi?.afterTs ? ` data-after-ts="${threadUi.afterTs}"` : '';
        const key = `ch-thread-summary-${cp.channel_id}-${(m.ts || '').replace('.', '_')}`;
        const repliesId = `${key}-replies`;
        const summaryHtml = m._chThreadSummary
          ? `<div class="deep-summary" style="margin:6px 0 2px">${escapeHtml(m._chThreadSummary)}</div>`
          : `<div id="${key}-loading" style="color:#555;font-size:12px;font-style:italic;margin:6px 0 2px">Summarizing replies…</div>`;
        html += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users, 400, threadUi, { skipBadge: true })}`
          + `<div class="thread-replies-container" data-channel="${cp.channel_id}" data-ts="${threadTs}" data-container-id="${containerId}"${modeAttr}${afterAttr}>`
          + summaryHtml
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
  html += '</div>' + (collapsible ? '</div>' : '') + '</div>';
  return html;
}

function renderDeepSummarizedItem(cp, data) {
  const ch = data.channels[cp.channel_id] || cp.channel_id;
  const latest = cp.messages[0];
  const msgs = cp.fullMessages?.history || cp.messages;
  const oldestTs = msgs[msgs.length - 1]?.ts;
  const newestTs = msgs[0]?.ts;
  const timeDisplay = oldestTs && newestTs && formatTime(oldestTs) !== formatTime(newestTs)
    ? `${formatTime(oldestTs)} → ${formatTime(newestTs)}`
    : formatTime(newestTs);
  let messagesHtml = '';
  for (const m of [...msgs].reverse()) {
    const threadUi = buildThreadUiMeta(data, cp.channel_id, m);
    messagesHtml += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users, 400, threadUi)}${threadRepliesContainer(m, cp.channel_id, threadUi)}</div>${msgActions(cp.channel_id, m.ts)}</div>`;
  }
  const deepMsgId = `deep-msgs-${cp.channel_id}`;
  const deepBullets = renderChannelSummaryBullets(cp._deepSummary || '', cp.channel_id);
  const deepOpenHref = slackPermalink(cp.channel_id, newestTs) || `https://app.slack.com/archives/${cp.channel_id}`;
  return `<div class="item noise-item">
    <div class="item-left">
      <a class="item-channel-link" href="${deepOpenHref}" target="_blank"><span class="item-channel">#${escapeHtml(ch)}</span><span class="open-in-slack"> open in Slack ↗</span></a>
      <span class="item-sep">·</span> <span class="item-time">${timeDisplay}</span>
      <span class="item-sep">·</span> ${headerExpandHtml(deepMsgId, msgs.length)}
    </div>
    <div class="item-right">
      ${summaryToggleHtml(deepMsgId, deepBullets, messagesHtml, cp._deepFetchFailed ? `<div><span class="error" style="font-size:11px;">⚠ fetch failed, limited context</span></div>` : '')}
      <div class="noise-inline-actions" style="display:flex;gap:12px;margin-top:6px;">
        <span class="show-messages-link mark-all-read" data-channel="${cp.channel_id}" data-ts="${latest?.ts}" style="margin-top:0">mark as read</span>
        <span class="show-messages-link action-mute-channel" data-channel="${cp.channel_id}" style="margin-top:0">mute channel</span>
      </div>
    </div>
  </div>`;
}

function renderSavedItem(item, data) {
  const channel = item.item_id;
  const ts = item.ts;
  const chName = data.channels?.[channel];
  const msg = item.message || {};
  const user = msg.user;
  const isDm = channel.startsWith('D');
  const channelLabel = chName ? '#' + escapeHtml(chName) : isDm && user ? escapeHtml(uname(user, data.users)) : escapeHtml(channel);
  const _stid = truncateId;
  const textHtml = msg.text ? truncate(msg.text, 400, data.users) : '';
  const savedExtras = wrapFilesIfTruncated(_stid, renderFwd(msg.fwd, data.users), renderFiles(msg.files));
  const savedOpenHref = slackPermalink(channel, ts) || `https://app.slack.com/archives/${channel}`;
  return `<div class="item saved-item" data-complete-request-id="">
    <div class="item-left">
      ${itemLeftLink(`<span class="item-channel">${channelLabel}</span> <span class="item-sep">·</span> <span class="item-time">${formatTime(ts)}</span>`, savedOpenHref)}
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

  const botOpenTs = allMsgs[allMsgs.length - 1]?.ts;
  const botOpenHref = slackPermalink(cp.channel_id, botOpenTs) || `https://app.slack.com/archives/${cp.channel_id}`;
  return `<div class="item ${cssClass}" data-bot-thread-key="${key}">
    <div class="item-left">
      ${itemLeftLink(`<span class="item-channel">#${escapeHtml(ch)}</span> <span class="item-sep">·</span> <span class="item-time">${formatTime(botOpenTs)}</span>`, botOpenHref)}
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

// Build mention regex from Slack handle (set when data arrives from inject.js)
let _handleMentionRegex = null;

function containsSelfMention(text, selfId) {
  if (!text || !selfId) return false;
  // Slack encoded @-mention or raw @-mention
  if (text.includes(`<@${selfId}>`)) return true;
  if (text.includes(`@${selfId}`)) return true;
  // @channel / @here (Slack encodes as <!channel> / <!here>)
  if (text.includes('<!channel>') || text.includes('<!here>')) return true;
  // @handle mention (e.g. @gem_ray)
  return _handleMentionRegex ? _handleMentionRegex.test(text) : false;
}

// ── Deterministic pre-filters ──
// Hard-drops, bot→whenFree. Everything else goes to LLM for classification + ranking.
function applyPreFilters(data) {
  const { selfId, threads, dms, channelPosts, channels, users } = data;
  const meta = data.channelMeta || {};
  window._preFilterLog = {}; // debug: track routing decisions

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
  for (const t of filteredThreads) {
    t._userReplied = (t.reply_users || []).includes(selfId);
    t._type = 'thread';
    t._isDmThread = t.channel_id?.startsWith('D') || false;
    t._sidebarSection = sidebarSections[t.channel_id] || null;

    // Check unread replies for direct @-mentions (drives floor rule → forced priority)
    const unreadTexts = (t.unread_replies || []).map((r) => r.text).join(' ');
    t._mentionInReplies = containsSelfMention(unreadTexts, selfId);
    t._isMentioned = t._mentionInReplies;
    // Check root for @-mention — doesn't force priority but makes thread "qualified"
    // so the LLM CAN classify it as priority/act_now if warranted
    t._mentionInRoot = containsSelfMention(t.root_text || '', selfId);

    // High-volume channels: only surface if 10+ replies, rest → noise
    const isOwnThread = t.root_user === selfId;
    if (t._sidebarSection === 'high_volume' && !isOwnThread) {
      if ((t.reply_count || 0) >= 5) {
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
    cp._sidebarSection = sidebarSections[cp.channel_id] || null;

    const allCpTexts = cp.messages.map((m) => m.text || '').join(' ');
    cp._isMentioned = containsSelfMention(allCpTexts, selfId);

    // Debug: log routing for every channel post
    const _dbgCh = channels[cp.channel_id] || cp.channel_id;
    const _dbgLog = (route) => { window._preFilterLog[cp.channel_id] = { channel: _dbgCh, route, _isMentioned: cp._isMentioned, mention_count: cp.mention_count, msgCount: cp.messages.length, selfId, sidebarSection: cp._sidebarSection, textSnippet: allCpTexts.slice(0, 200) }; };

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
      _dbgLog('dedup-to-thread');
      continue;
    }

    // High-volume channels: split — individual posts with 10+ replies → whenFree, rest → noise
    if (cp._sidebarSection === 'high_volume') {
      const hotMsgs = cp.messages.filter((m) => (m.reply_count || 0) >= 5);
      const coldMsgs = cp.messages.filter((m) => (m.reply_count || 0) < 5);
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
      _dbgLog('high_volume');
      continue;
    }

    // Hard noise rule → bypass LLM, straight to noise
    if (cp._sidebarSection === 'hard_noise') {
      _dbgLog('hard_noise');
      noise.push(cp);
      continue;
    }

    // Skip rule → don't process at all
    if (cp._sidebarSection === 'skip') {
      _dbgLog('skip');
      continue;
    }

    // All-bot messages — apply configurable bot-only rule (default: high_volume)
    // @mentions always go to LLM regardless of bot rule
    if (cp.messages.every(isBot) && !cp._isMentioned) {
      cp._isAllBot = true;
      const botRule = sidebarSections['__bot_only'] || 'high_volume';
      if (botRule === 'skip') { _dbgLog('allBot-skip'); continue; }
      if (botRule === 'hard_noise') { _dbgLog('allBot-noise'); noise.push(cp); continue; }
      if (botRule === 'high_volume') {
        const hotMsgs = cp.messages.filter((m) => (m.reply_count || 0) >= 5);
        const coldMsgs = cp.messages.filter((m) => (m.reply_count || 0) < 5);
        if (hotMsgs.length > 0) {
          const hotCp = { ...cp, messages: hotMsgs, _isAllBot: true };
          const replierIds = [...new Set(hotMsgs.flatMap((m) => m.reply_users || []))];
          hotCp._repliers = replierIds.slice(0, 3).map((uid) => uname(uid, users));
          hotCp._replierOverflow = Math.max(0, replierIds.length - 3);
          whenFree.push(hotCp);
        }
        if (coldMsgs.length > 0) noise.push({ ...cp, messages: coldMsgs, _isAllBot: true });
        _dbgLog('allBot-highvol');
        continue;
      }
      // floor_priority, floor_whenfree, normal → send to LLM
      if (cp.messages.length >= 4) cp._deepAnalysis = true;
      _dbgLog('allBot-llm');
      forLlm.channelPosts.push(cp);
      continue;
    }

    _dbgLog('forLlm');
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
    const item = {
      id: `thread_${i}`,
      type: t._isDmThread ? 'dm_thread' : 'thread',
      channel: ch,
      isPrivate: meta[t.channel_id]?.isPrivate || false,
      isMentioned: t._isMentioned || false,
      sidebarSection: t._sidebarSection || undefined,
      rootUser: fullName(t.root_user, data.fullNames),
      rootText: plainTruncate(textWithFwd(t.root_text, t.root_fwd), 1000, data.users),
      userReplied: t._userReplied,
      newReplies: t.unread_replies.map((r) => ({
        user: fullName(r.user, data.fullNames),
        text: plainTruncate(textWithFwd(r.text, r.fwd), 1000, data.users),
      })),
    };
    if (t.full_replies?.length) {
      const readReplies = t.full_replies.filter((r) => !r.is_unread);
      if (readReplies.length > 0) {
        item.recentContext = readReplies.map((r) => ({
          user: fullName(r.user, data.fullNames),
          text: plainTruncate(r.text, 500, data.users),
        }));
      }
    }
    items.push(item);
  }

  for (let i = 0; i < forLlm.dms.length; i++) {
    const dm = forLlm.dms[i];
    const participantIds = (dm.members || []).filter((uid) => uid && uid !== data.selfId);
    const participantNames = [...new Set(participantIds.map((uid) => fullName(uid, data.fullNames)))].filter(Boolean);
    const dmItem = {
      id: `dm_${i}`,
      type: 'dm',
      isGroup: !!dm.isGroup,
      participants: participantNames,
      messages: dm.messages.map((m) => ({
        user: m.subtype === 'bot_message' ? 'Bot' : fullName(m.user, data.fullNames),
        text: plainTruncate(textWithFwd(m.text, m.fwd), 1000, data.users),
      })),
    };
    if (dm.recentContext?.length) {
      dmItem.recentContext = dm.recentContext.map((m) => ({
        user: fullName(m.user, data.fullNames),
        text: plainTruncate(m.text, 500, data.users),
      }));
    }
    items.push(dmItem);
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
      sidebarSection: cp._sidebarSection || undefined,
      mentionCount: cp.mention_count || 0,
      messages: cp.messages.map((m) => ({
        user: m.subtype === 'bot_message' ? 'Bot' : fullName(m.user, data.fullNames),
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
    const mentionInRoot = item._mentionInRoot || false;
    const isImportantChannel = item._sidebarSection === 'floor_priority' || item._sidebarSection === 'floor_whenfree';
    const isQualified = isDm || isPrivate || isMentioned || mentionInRoot;
    const userReplied = item._userReplied || false;
    const llmCat = cat; // original LLM classification before overrides
    const chLabel = data.channels?.[item.channel_id] || item.channel_id;

    // DM overrides: VIP DMs → act_now, all other DMs → at least priority
    if (isDm) {
      const vipSet = new Set(data.vipUserIds || []);
      const senderIds = (item.messages || item.unread_replies || []).map((m) => m.user).filter(Boolean);
      const isVipDm = senderIds.some((uid) => vipSet.has(uid));
      if (isVipDm) cat = 'act_now';
      else if (cat !== 'act_now') cat = 'priority';
    }

    // Floor: direct @mentions are at least priority (LLM can upgrade to act_now but not below priority)
    if (isMentioned && cat !== 'act_now') cat = 'priority';

    // Hard gate: only DMs, private channels, @mentions, or important sidebar channels can reach act_now/priority
    if (!isQualified && !isImportantChannel && (cat === 'act_now' || cat === 'priority')) cat = 'when_free';

    // Floor rules from sidebar section config
    if (item._sidebarSection === 'floor_priority' && cat !== 'act_now') cat = 'priority';
    if (item._sidebarSection === 'floor_whenfree' && (cat === 'noise' || cat === 'drop')) cat = 'when_free';

    if (cat === 'act_now' || cat === 'priority') {
      item._reason = reasons[item._llmId] || undefined;
      item._reasonWhy = reasons[item._llmId + '_why'] || undefined;
      // Fallback reason when mention floor-rule elevated the item but LLM didn't supply a reason
      if (!item._reason && isMentioned) item._reason = item._mentionInReplies && !item._mentionInRoot ? 'You were mentioned in a reply' : 'You were mentioned';
      // Fallback: truncate most substantive message text
      if (!item._reason) {
        let raw = '';
        if (item._type === 'thread') {
          const replies = item.unread_replies || [];
          raw = replies.reduce((best, r) => (r.text || '').length > best.length ? r.text : best, '') || item.root_text || '';
        } else {
          const msgs = item.messages || [];
          raw = msgs.reduce((best, m) => (m.text || '').length > best.length ? m.text : best, '') || '';
        }
        // Strip Slack markup (<@U..>, <http...|label>, etc.)
        raw = raw.replace(/<@[A-Z0-9]+>/g, '').replace(/<[^|>]+\|([^>]+)>/g, '$1').replace(/<[^>]+>/g, '').trim();
        if (isDm) {
          // DMs: "Name: [100 char preview]"
          const partner = dmPartnerName(item, data);
          let preview = raw.length > 100 ? raw.slice(0, 100) + '...' : raw;
          item._reason = preview ? `${partner}: ${preview}` : `${partner} DM'd you`;
        } else {
          const words = raw.split(/\s+/).filter(Boolean);
          item._reason = words.length > 10 ? words.slice(0, 10).join(' ') + '...' : words.join(' ') || 'new message';
        }
      }
    }

    if (cat !== llmCat || cat === 'act_now' || cat === 'priority') {
      console.log(`[fslack] ${item._llmId} (${item._type}, #${chLabel}): LLM="${llmCat}" → final="${cat}" | isDm=${isDm} isPrivate=${isPrivate} isMentioned=${isMentioned} isImportant=${isImportantChannel} reason="${item._reason || ''}" why="${item._reasonWhy || ''}"`);
    }

    if (cat === 'act_now') { actNow.push(item); return; }
    if (cat === 'priority') { priority.push(item); return; }

    // Public channel posts without @mention go to noise — unless in Top/Daily sidebar section
    if (item._type === 'channel' && !isPrivate && !isMentioned && !isImportantChannel) { noise.push(item); return; }

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


function renderPrioritized(prioritized, data, popular, loading = false, deepNoiseLoading = false, savedItems = [], _unused = false, cachedTs = null) {
  const { actNow, priority, whenFree, noise } = prioritized;

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

  // Act Now + Priority
  if (actNow.length > 0 || (priority && priority.length > 0)) {
    html += '<section class="priority-section">';
    html += '<h2 class="priority-header">Priority</h2>';
    for (const item of actNow) html += renderAnyItem(item, data, 'act-now');
    for (const item of (priority || [])) html += renderAnyItem(item, data, 'priority-item');
    if (priority && priority.length > 0) {
      html += `<div class="noise-section-footer"><button id="priority-mark-read-btn">Mark all priority as read</button></div>`;
    }
    html += '</section>';
  }

  // Channels header (combines cache-age + refresh into one line)
  if (whenFree.length > 0 || (!loading && (noise.length > 0 || deepNoiseLoading))) {
    html += '<div class="channels-header">';
    html += '<span class="channels-header-label">Channels</span>';
    if (cachedTs) {
      const mins = Math.floor((Date.now() - cachedTs) / 60000);
      const agoLabel = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
      html += `<span class="channels-header-age">cached ${agoLabel}</span>`;
    }
    html += '<span class="channels-header-refresh" id="cache-divider-refresh">refresh</span>';
    html += '</div>';
  }

  // Relevant (collapsed by default)
  if (whenFree.length > 0) {
    html += '<section class="priority-section">';
    html += `<div class="section-toggle" id="when-free-toggle">Relevant · ${whenFree.length} ↓</div>`;
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
      const popHref = slackPermalink(p.channel_id, p.ts) || `https://app.slack.com/archives/${p.channel_id}`;
      html += `<div class="item interesting">
        <div class="item-left">
          ${itemLeftLink(`<span class="item-channel">#${escapeHtml(p.channel_name || p.channel_id)}</span> <span class="item-sep">·</span> <span class="item-time">${formatTime(p.ts)}</span>`, popHref)}
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

  // Channel Messages (noise)
  const hasChannelMessages = !loading && (noise.length > 0 || deepNoiseLoading);
  if (hasChannelMessages) {
    html += '<section class="priority-section">';

    // Recent (last 24h)
    if (noise.length > 0 || deepNoiseLoading) {
      const noiseCutoff = Date.now() / 1000 - 86400;
      const noiseRecent = noise.filter((item) => getItemSortTs(item) >= noiseCutoff);
      const noiseOlder = noise.filter((item) => getItemSortTs(item) < noiseCutoff);
      if (noiseRecent.length > 0 || deepNoiseLoading) {
        html += `<div class="section-toggle" id="noise-recent-toggle">Recent noise · ${noiseRecent.length} ↓</div>`;
        html += '<div class="noise-items" id="noise-recent-items">';
        for (const item of noiseRecent) html += renderAnyItem(item, data, 'noise-item');
        if (deepNoiseLoading) {
          html += '<div id="deep-noise-area" style="padding:8px 24px;font-size:12px;color:#3d3f42">Analyzing busy channels...</div>';
        }
        html += `<div class="noise-section-footer"><button id="noise-mark-recent-btn">Mark all recent as read</button></div>`;
        html += '</div>';
      }
      // Older
      if (noiseOlder.length > 0 || deepNoiseLoading) {
        const olderHidden = noiseOlder.length === 0;
        html += `<div class="section-toggle" id="noise-older-toggle"${olderHidden ? ' style="display:none"' : ''}>Older noise · ${noiseOlder.length} ↓</div>`;
        html += '<div class="noise-items" id="noise-older-items">';
        for (const item of noiseOlder) html += renderAnyItem(item, data, 'noise-item');
        html += `<div class="noise-section-footer" id="noise-older-footer"${olderHidden ? ' style="display:none"' : ''}><button id="noise-mark-older-btn">Mark all older as read</button></div>`;
        html += '</div>';
      }
    }

    html += '</section>';
  }

  // All clear
  if (!loading && !deepNoiseLoading && actNow.length === 0 && (!priority || priority.length === 0) && whenFree.length === 0 && (!popular || popular.length === 0) && noise.length === 0) {
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

  // Schedule background poll to check for new data without disrupting UI
  if (!loading) scheduleBackgroundPoll();

  // Wire up noise toggles
  function wireNoiseToggle(toggleId, itemsId, label) {
    const toggle = document.getElementById(toggleId);
    const items = document.getElementById(itemsId);
    if (toggle && items) {
      toggle.addEventListener('click', () => {
        const expanded = items.classList.toggle('expanded');
        const count = items.querySelectorAll('.item:not(.read-done)').length;
        toggle.textContent = `${label} · ${count} ${expanded ? '↑' : '↓'}`;
      });
    }
  }
  wireNoiseToggle('when-free-toggle', 'when-free-items', 'Relevant');
  wireNoiseToggle('noise-recent-toggle', 'noise-recent-items', 'Recent noise');
  wireNoiseToggle('noise-older-toggle', 'noise-older-items', 'Older noise');
  wireNoiseToggle('saved-items-toggle', 'saved-items-list', 'Saved');

  // Wire cache divider refresh button
  const cacheDivRefresh = document.getElementById('cache-divider-refresh');
  if (cacheDivRefresh) cacheDivRefresh.addEventListener('click', startFullFetch);
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
    sendToInject({
      type: `${FSLACK}:pollNewDms`,
      knownChannelIds: [...knownDmChannelIds],
      cachedUsers: { ...cachedUserMap, ...(lastRenderData?.users || {}) },
      requestId: `dmpoll_${Date.now()}`,
    });
  }, DM_POLL_INTERVAL_MS);
}

function insertNewDm(dm, data) {
  dm._type = 'dm';
  knownDmChannelIds.add(dm.channel_id);

  // Skip all-bot DMs — they'd go to whenFree in a full fetch
  if (dm.messages.every((m) => m.bot_id || m.subtype === 'bot_message')) return;

  // Ensure a reason badge so the collapsed item isn't invisible
  if (!dm._reason) {
    const partner = dmPartnerName(dm, data);
    const latest = (dm.messages || [])[0];
    let preview = (latest?.text || '').replace(/<@[A-Z0-9]+>/g, '').replace(/<[^|>]+\|([^>]+)>/g, '$1').replace(/<[^>]+>/g, '').trim();
    if (preview.length > 100) preview = preview.slice(0, 100) + '...';
    dm._reason = preview ? `${partner}: ${preview}` : `${partner} DM'd you`;
  }

  // All live DMs go into the Priority section at the top
  const itemHtml = renderDmItem(dm, data, 'priority-item');
  if (!itemHtml) return;

  const wrapper = document.createElement('div');
  wrapper.classList.add('dm-watch-new');
  wrapper.innerHTML = itemHtml;

  // Find existing Priority section, or create one
  let sectionEl = document.querySelector('h2.priority-header')?.closest('.priority-section');
  if (!sectionEl) {
    sectionEl = document.createElement('section');
    sectionEl.className = 'priority-section';
    const h2 = document.createElement('h2');
    h2.className = 'priority-header';
    h2.textContent = 'Priority';
    sectionEl.appendChild(h2);
    // Insert after saved section if present, otherwise at top
    const savedSection = document.querySelector('#saved-items-toggle')?.closest('.priority-section');
    if (savedSection) savedSection.after(sectionEl);
    else bodyEl.insertBefore(sectionEl, bodyEl.firstChild);
  }

  // Insert right after the h2 header (top of section)
  const h2 = sectionEl.querySelector('h2');
  if (h2 && h2.nextSibling) h2.after(wrapper);
  else sectionEl.appendChild(wrapper);

  // Update the cached view so mark-read etc. works
  if (cachedView?.prioritized) {
    cachedView.prioritized.priority.unshift(dm);
  }

  console.log(`[fslack] New DM detected: ${dmPartnerName(dm, data)} → Priority`);
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

function mergeCachedFullNames(names) {
  if (!names) return;
  for (const [uid, name] of Object.entries(names)) {
    if (uid && name) cachedFullNameMap[uid] = name;
  }
}

function fullName(uid, fullNames) {
  return fullNames?.[uid] || cachedFullNameMap[uid] || cachedUserMap[uid] || uid;
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
  // Reason-badge toggle for collapsible priority items
  const reasonToggle = e.target.closest('.item-reason-toggle');
  if (reasonToggle) {
    const details = reasonToggle.nextElementSibling;
    if (!details?.classList.contains('item-details')) return;
    const expanded = details.classList.toggle('expanded');
    reasonToggle.textContent = reasonToggle.textContent.replace(/[↓↑]$/, expanded ? '↑' : '↓');
    return;
  }

  // Inline refresh link (e.g. "No Slack tab found" message)
  if (e.target.closest('.inline-refresh')) { startFetch(); return; }

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
    sendToInject({ type: `${FSLACK}:completeSaved`, item_id: itemId, ts, requestId });
    if (itemEl) { itemEl.style.transition = 'opacity 0.3s'; itemEl.style.opacity = '0.3'; }
    return;
  }


  // VIP section lazy-load toggle
  const vipToggle = e.target.closest('#vip-toggle');
  if (vipToggle) {
    const vipItems = document.getElementById('vip-items');
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
        pendingVips = null; // reset so kickoff waits for fresh data
        sendToInject({ type: `${FSLACK}:fetchVips`, cachedUsers: { ...cachedUserMap, ...(lastRenderData?.users || {}) } });
        kickoffVipSection(lastRenderData);
      }
    }
    return;
  }

  // Thread badge: expand replies inline (shift/meta-click opens in new tab)
  const threadBadgeEl = e.target.closest('.msg-thread-badge');
  if (threadBadgeEl) {
    const { channel, ts, truncId, containerId } = threadBadgeEl.dataset;

    // Modifier click → open permalink in new tab
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.button === 1) {
      const href = slackPermalink(channel, ts) || `https://app.slack.com/archives/${channel}`;
      window.open(href, '_blank');
      return;
    }

    const container = findThreadContainer(channel, ts, containerId);
    if (!container) return;

    // Already loaded → toggle visibility (including truncated text)
    if (threadBadgeEl.classList.contains('expanded')) {
      const isVisible = container.style.display !== 'none';
      container.style.display = isVisible ? 'none' : '';
      if (truncId) {
        const shortEl = document.getElementById(`${truncId}-short`);
        const fullEl = document.getElementById(`${truncId}-full`);
        const filesEl = document.getElementById(`${truncId}-files`);
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
      const shortEl = document.getElementById(`${truncId}-short`);
      const fullEl = document.getElementById(`${truncId}-full`);
      const filesEl = document.getElementById(`${truncId}-files`);
      if (shortEl && fullEl) { shortEl.style.display = 'none'; fullEl.style.display = ''; }
      if (filesEl) filesEl.style.display = '';
    }
    threadBadgeEl.classList.add('loading');
    threadBadgeEl.textContent = 'Loading...';
    const reqId = `thread_${++replyRequestId}`;
    threadBadgeEl.dataset.requestId = reqId;
    sendToInject({ type: `${FSLACK}:fetchReplies`, channel, ts, requestId: reqId });
    return;
  }

  // See more / See less toggle
  const seeMore = e.target.closest('.see-more');
  if (seeMore) {
    const id = seeMore.dataset.truncId;
    const shortEl = document.getElementById(`${id}-short`);
    const fullEl = document.getElementById(`${id}-full`);
    const filesEl = document.getElementById(`${id}-files`);
    if (shortEl && fullEl) { shortEl.style.display = 'none'; fullEl.style.display = ''; }
    if (filesEl) filesEl.style.display = '';
    return;
  }
  const seeLess = e.target.closest('.see-less');
  if (seeLess) {
    const id = seeLess.dataset.truncId;
    const shortEl = document.getElementById(`${id}-short`);
    const fullEl = document.getElementById(`${id}-full`);
    const filesEl = document.getElementById(`${id}-files`);
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
      sendToInject({ type: `${FSLACK}:markUnread`, channel, ts, thread_ts: threadTs, requestId: `unread_${Date.now()}` });
      markAll.dataset.pending = 'true';
    } else if (!markAll.dataset.pending) {
      const { channel, ts, threadTs, hasMention } = markAll.dataset;
      markAll.textContent = '...';
      sendToInject({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, has_mention: hasMention === '1', requestId: `readall_${Date.now()}` });
      markAll.dataset.pending = 'true';
    }
    return;
  }

  // Mark all above read
  const markAbove = e.target.closest('.mark-above-read');
  if (markAbove) {
    const thisItem = markAbove.closest('.item');
    if (!thisItem) return;
    // Walk backward through preceding .item siblings in the same section
    let sibling = thisItem.previousElementSibling;
    let count = 0;
    while (sibling) {
      if (sibling.classList.contains('section-toggle') || sibling.classList.contains('noise-section-footer')) break;
      if (sibling.classList.contains('item')) {
        const markBtn = sibling.querySelector('.mark-all-read:not(.done):not([data-pending])');
        if (markBtn) {
          const { channel, ts, threadTs, hasMention } = markBtn.dataset;
          markBtn.textContent = '...';
          markBtn.dataset.pending = 'true';
          sendToInject({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, has_mention: hasMention === '1', requestId: `readall_${Date.now()}_above_${++count}` });
        }
      }
      sibling = sibling.previousElementSibling;
    }
    if (count > 0) markAbove.textContent = `✓ ${count} marked`;
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
      sendToInject({ type: `${FSLACK}:removeReaction`, channel, ts, emoji, requestId });
      reactBtn.dataset.pending = requestId;
      reactBtn.dataset.pendingKind = 'unreact';
    } else {
      reactBtn.style.opacity = '0.4';
      const requestId = `react_${Date.now()}_${++reactionRequestCounter}`;
      pendingReactButtons[requestId] = reactBtn;
      sendToInject({ type: `${FSLACK}:addReaction`, channel, ts, emoji, requestId });
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
      sendToInject({ type: `${FSLACK}:unsaveMessage`, channel, ts, requestId: `unsave_${Date.now()}` });
    } else {
      // Save
      saveBtn.classList.add('saved');
      saveBtn.title = 'Saved';
      if (svgPath) svgPath.setAttribute('fill', 'currentColor');
      savedMsgKeys.add(key);
      chrome.storage.local.set({ fslackSavedMsgs: [...savedMsgKeys] });
      sendToInject({ type: `${FSLACK}:saveMessage`, channel, ts, requestId: `save_${Date.now()}` });
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
    form.innerHTML = `<div class="reply-image-preview"><img class="reply-image-thumb"><button class="reply-image-remove">\u00d7</button></div><div class="reply-form-row"><textarea class="reply-input" rows="1" placeholder="Reply in thread... (⌘Enter to send)"></textarea><span class="draft-saved">saved</span><button class="reply-send">Send</button></div>`;
    msgRow.insertAdjacentElement('afterend', form);
    const input = form.querySelector('.reply-input');
    for (const evt of ['keydown', 'keyup', 'keypress', 'copy', 'cut', 'input']) {
      input.addEventListener(evt, (ev) => ev.stopPropagation());
    }
    setupImagePaste(form, input);
    loadDraftIntoForm(form, input, channel, ts);
    input.focus();
    function autoResize() {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    }
    input.addEventListener('input', autoResize);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && (input.value.trim() || form._pastedImageData)) {
        ev.preventDefault();
        sendReply(form, channel, ts, input.value.trim());
      }
      if (ev.key === 'Escape') form.remove();
    });
    form.querySelector('.reply-send').addEventListener('click', () => {
      if (input.value.trim() || form._pastedImageData) sendReply(form, channel, ts, input.value.trim());
    });
    return;
  }

  // Reply action (in item-actions)
  const replyBtn = e.target.closest('.action-reply');
  if (replyBtn) {
    const itemActions = replyBtn.closest('.item-actions');
    if (!itemActions || itemActions.previousElementSibling?.classList.contains('reply-form')) return;
    const { channel, ts, dm } = replyBtn.dataset;
    const isDm = dm === 'true';
    const form = document.createElement('div');
    form.className = 'reply-form';
    const placeholder = isDm ? 'Send a DM... (⌘Enter to send)' : 'Reply... (⌘Enter to send)';
    form.innerHTML = `<div class="reply-image-preview"><img class="reply-image-thumb"><button class="reply-image-remove">\u00d7</button></div><div class="reply-form-row"><textarea class="reply-input" rows="1" placeholder="${placeholder}"></textarea><span class="draft-saved">saved</span><button class="reply-send">Send</button></div>`;
    itemActions.insertAdjacentElement('beforebegin', form);
    const input = form.querySelector('.reply-input');
    for (const evt of ['keydown', 'keyup', 'keypress', 'copy', 'cut', 'input']) {
      input.addEventListener(evt, (ev) => ev.stopPropagation());
    }
    setupImagePaste(form, input);
    loadDraftIntoForm(form, input, channel, isDm ? null : ts);
    input.focus();
    function autoResize() {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    }
    input.addEventListener('input', autoResize);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && (input.value.trim() || form._pastedImageData)) {
        ev.preventDefault();
        sendReply(form, channel, isDm ? null : ts, input.value.trim());
      }
      if (ev.key === 'Escape') form.remove();
    });
    form.querySelector('.reply-send').addEventListener('click', () => {
      if (input.value.trim() || form._pastedImageData) sendReply(form, channel, isDm ? null : ts, input.value.trim());
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
      const { ts, threadTs: tTs, hasMention } = markAllBtn.dataset;
      markAllBtn.textContent = '...';
      markAllBtn.dataset.pending = 'true';
      sendToInject({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: tTs, has_mention: hasMention === '1', requestId: `readall_${Date.now()}` });
    }
    muteThreadLocally(channel, threadTs);
    const itemEl = muteBtn.closest('.item');
    if (itemEl) itemEl.classList.add('muted-pending');
    muteBtn.textContent = 'undo mute';
    muteBtn.classList.add('undo-mute');
    sendToInject({ type: `${FSLACK}:muteThread`, channel, thread_ts: threadTs, requestId: `mute_${Date.now()}` });
    return;
  }

  // Undo mute thread
  const undoMuteBtn = e.target.closest('.undo-mute');
  if (undoMuteBtn) {
    const { channel, threadTs } = undoMuteBtn.dataset;
    const key = threadKey(channel, threadTs);
    if (key) {
      mutedThreadKeys.delete(key);
      persistMutedThreads();
    }
    const itemEl = undoMuteBtn.closest('.item');
    if (itemEl) itemEl.classList.remove('muted-pending');
    undoMuteBtn.textContent = 'mute thread';
    undoMuteBtn.classList.remove('undo-mute');
    undoMuteBtn.dataset.pending = '';
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
      const { ts, threadTs, hasMention } = markAllBtn.dataset;
      markAllBtn.textContent = '...';
      markAllBtn.dataset.pending = 'true';
      sendToInject({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, has_mention: hasMention === '1', requestId: `readall_${Date.now()}` });
    }
    sendToInject({ type: `${FSLACK}:muteChannel`, channel, requestId: `mutech_${Date.now()}` });
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

  // Toggle summarized thread/noise via header or toggle-row click
  const summaryToggle = e.target.closest('.summary-toggle');
  if (summaryToggle) {
    const targetId = summaryToggle.dataset.target;
    const msgsDiv = document.getElementById(targetId);
    if (!msgsDiv) return;
    const item = summaryToggle.closest('.item');
    const itemRight = item?.querySelector('.item-right');
    const msgRow = itemRight?.querySelector('.msg-row.summarized');
    const summaryWrap = itemRight?.querySelector('.deep-summary-wrap');
    const countSpan = item?.querySelector('.summary-reply-count');

    if (msgsDiv.style.display === 'block') {
      msgsDiv.style.display = 'none';
      if (msgRow) msgRow.classList.remove('expanded');
      if (summaryWrap) summaryWrap.style.display = '';
      if (countSpan) {
        const headerExp = countSpan.closest('.header-expand');
        if (headerExp) headerExp.classList.remove('is-expanded');
        const lastText = countSpan.lastChild;
        if (lastText?.nodeType === 3) lastText.textContent = lastText.textContent.replace('↑', '↓');
      }
    } else {
      msgsDiv.style.display = 'block';
      if (msgRow) msgRow.classList.add('expanded');
      if (summaryWrap) summaryWrap.style.display = 'none';
      if (countSpan) {
        const headerExp = countSpan.closest('.header-expand');
        if (headerExp) headerExp.classList.add('is-expanded');
        const lastText = countSpan.lastChild;
        if (lastText?.nodeType === 3) lastText.textContent = lastText.textContent.replace('↓', '↑');
      }
    }
    return;
  }

  // Show/hide full messages for deep-summarized items
  const showMsgsLink = e.target.closest('.show-messages-link[data-target]');
  if (showMsgsLink) {
    const targetId = showMsgsLink.dataset.target;
    const msgsDiv = document.getElementById(targetId);
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
        pendingOneShot[reqId] = (msg) => {
          const replies = (msg.replies || []).filter((r) => r.ts !== ts);
          let html = '';
          const rd = lastRenderData;
          for (const r of replies) {
            const userName = rd ? uname(r.user, rd.users) : r.user;
            const _lrtid = truncateId;
            const lrTextHtml = truncate(r.text, 400, rd?.users);
            const lrExtras = wrapFilesIfTruncated(_lrtid, renderFwd(r.fwd, rd?.users), renderFiles(r.files));
            html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(userName, channel, r.ts, ts)} ${lrTextHtml}${lrExtras}${msgTime(r.ts, channel, ts)}</div>${msgActions(channel, r.ts)}</div>`;
          }
          msgsDiv.innerHTML = html;
          msgsDiv.style.display = 'block';
          showMsgsLink.classList.remove('loading');
          showMsgsLink.textContent = showMsgsLink.dataset.showText.replace('show', 'hide').replace('↓', '↑');
          const msgRowFetch = showMsgsLink.closest('.item-right')?.querySelector('.msg-row.summarized');
          if (msgRowFetch) msgRowFetch.classList.add('expanded');
        };
        sendToInject({ type: `${FSLACK}:fetchReplies`, channel, ts, requestId: reqId });
        return;
      }
      if (!showMsgsLink.dataset.showText) showMsgsLink.dataset.showText = showMsgsLink.textContent;
      const msgRowToggle = showMsgsLink.closest('.item-right')?.querySelector('.msg-row.summarized');
      if (msgsDiv.style.display === 'block') {
        msgsDiv.style.display = 'none';
        showMsgsLink.textContent = showMsgsLink.dataset.showText;
        if (msgRowToggle) msgRowToggle.classList.remove('expanded');
      } else {
        msgsDiv.style.display = 'block';
        showMsgsLink.textContent = showMsgsLink.dataset.showText.replace('show', 'hide').replace('↓', '↑');
        if (msgRowToggle) msgRowToggle.classList.add('expanded');
      }
    }
    return;
  }

  // Mark all priority as read
  const priorityMarkRead = e.target.closest('#priority-mark-read-btn');
  if (priorityMarkRead && !priorityMarkRead.disabled) {
    const priorityItemEls = bodyEl.querySelectorAll('.item.priority-item:not(.read-done), .item.act-now:not(.read-done)');
    let count = 0;
    for (const item of priorityItemEls) {
      const markAll = item.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (!markAll) continue;
      const { channel, ts, threadTs, hasMention } = markAll.dataset;
      markAll.textContent = '...';
      markAll.dataset.pending = 'true';
      sendToInject({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, has_mention: hasMention === '1', requestId: `readall_${Date.now()}_${count}` });
      count++;
    }
    priorityMarkRead.textContent = count > 0 ? `Marked ${count} as read` : 'Nothing to mark';
    priorityMarkRead.disabled = true;
    return;
  }

  // Mark all when-free as read
  const whenfreeMarkRead = e.target.closest('#whenfree-mark-read-btn');
  if (whenfreeMarkRead && !whenfreeMarkRead.disabled) {
    const section = document.getElementById('when-free-items');
    const whenfreeItemEls = section ? section.querySelectorAll('.item.when-free:not(.read-done)') : [];
    let count = 0;
    for (const item of whenfreeItemEls) {
      const markAll = item.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (!markAll) continue;
      const { channel, ts, threadTs, hasMention } = markAll.dataset;
      markAll.textContent = '...';
      markAll.dataset.pending = 'true';
      sendToInject({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, has_mention: hasMention === '1', requestId: `readall_${Date.now()}_${count}` });
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



  // Mark recent noise as read
  const noiseMarkRecent = e.target.closest('#noise-mark-recent-btn');
  if (noiseMarkRecent && !noiseMarkRecent.disabled) {
    const section = document.getElementById('noise-recent-items');
    const noiseItemEls = section ? section.querySelectorAll('.item.noise-item:not(.read-done)') : [];
    let count = 0;
    for (const item of noiseItemEls) {
      const markAll = item.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (!markAll) continue;
      const { channel, ts, threadTs, hasMention } = markAll.dataset;
      markAll.textContent = '...';
      markAll.dataset.pending = 'true';
      sendToInject({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, has_mention: hasMention === '1', requestId: `readall_${Date.now()}_${count}` });
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
    const section = document.getElementById('noise-older-items');
    const noiseItemEls = section ? section.querySelectorAll('.item.noise-item:not(.read-done)') : [];
    let count = 0;
    for (const item of noiseItemEls) {
      const markAll = item.querySelector('.mark-all-read:not(.done):not([data-pending])');
      if (!markAll) continue;
      const { channel, ts, threadTs, hasMention } = markAll.dataset;
      markAll.textContent = '...';
      markAll.dataset.pending = 'true';
      sendToInject({ type: `${FSLACK}:markRead`, channel, ts, thread_ts: threadTs, has_mention: hasMention === '1', requestId: `readall_${Date.now()}_${count}` });
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


  // Seen replies lazy load / chunked expansion
  const toggle = e.target.closest('.seen-replies-toggle');
  if (toggle) {
    handleSeenRepliesToggleClick(toggle);
    return;
  }
});

// Click-to-focus: track position for keyboard nav without showing highlight
bodyEl.addEventListener('click', (e) => {
  const nav = e.target.closest('.msg-row, .item, .section-toggle');
  if (!nav) return;
  const target = nav.classList.contains('item')
    ? (nav.querySelector('.msg-row') ? e.target.closest('.msg-row') || nav : nav)
    : nav;
  const els = getNavigableElements();
  const idx = els.indexOf(target);
  if (idx >= 0) {
    unfocusItem();
    focusedItemIndex = idx;
  }
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
    html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(userName, toggle.dataset.channel, r.ts, toggle.dataset.ts)} ${srTextHtml}${srExtras}${msgTime(r.ts, toggle.dataset.channel, toggle.dataset.ts)}</div>${msgActions(toggle.dataset.channel, r.ts)}</div>`;
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
  sendToInject({ type: `${FSLACK}:fetchReplies`, channel, ts, requestId: reqId });
}
// ── Send reply helper ──
function autoMarkItemRead(item, { requireThread = false, overrideTs } = {}) {
  if (!item) return;
  const markAll = item.querySelector('.mark-all-read');
  if (!markAll) return;
  if (requireThread && !markAll.dataset.threadTs) return;
  if (markAll.classList.contains('done') || markAll.dataset.pending) return;
  const { channel, ts, threadTs, hasMention } = markAll.dataset;
  const markTs = overrideTs || ts;
  if (overrideTs) markAll.dataset.ts = markTs;
  markAll.textContent = '...';
  markAll.dataset.pending = 'true';
  sendToInject({ type: `${FSLACK}:markRead`, channel, ts: markTs, thread_ts: threadTs, has_mention: hasMention === '1', requestId: `readall_${Date.now()}` });
}

function setupImagePaste(form, input) {
  const preview = form.querySelector('.reply-image-preview');
  const thumb = form.querySelector('.reply-image-thumb');
  const removeBtn = form.querySelector('.reply-image-remove');
  function clearImage() {
    delete form._pastedImageData;
    delete form._pastedImageMime;
    preview.classList.remove('visible');
    thumb.src = '';
  }
  removeBtn.addEventListener('click', () => { clearImage(); input.focus(); });
  input.addEventListener('paste', (ev) => {
    ev.stopPropagation();
    const items = ev.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      ev.preventDefault();
      const file = item.getAsFile();
      if (file.size > 10 * 1024 * 1024) { alert('Image too large (10MB limit)'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        form._pastedImageData = reader.result;
        form._pastedImageMime = item.type;
        thumb.src = reader.result;
        preview.classList.add('visible');
      };
      reader.readAsDataURL(file);
      return;
    }
  });
}

function sendReply(form, channel, threadTs, text) {
  const input = form.querySelector('.reply-input');
  const btn = form.querySelector('.reply-send');
  const finalText = text ? convertUserMentions(text) : '';
  input.value = finalText;
  input.disabled = true;
  btn.disabled = true;
  const reqId = `post_${Date.now()}`;
  form.dataset.requestId = reqId;
  form._draftChannel = channel;
  form._draftThreadTs = threadTs;
  if (form._pastedImageData) {
    btn.textContent = 'Uploading...';
    sendToInject({ type: `${FSLACK}:uploadAndPost`, channel, thread_ts: threadTs, text: finalText, imageData: form._pastedImageData, imageMime: form._pastedImageMime, requestId: reqId });
  } else {
    btn.textContent = '...';
    sendToInject({ type: `${FSLACK}:postReply`, channel, thread_ts: threadTs, text: finalText, requestId: reqId });
  }
}

// ── API key prompt — directs user to options page ──
function showApiKeyPrompt(rawData) {
  bodyEl.innerHTML = `
    <div class="api-key-form">
      <div style="color: #fff; font-size: 16px; margin-bottom: 12px;">Claude API Key Required</div>
      <div style="color: #ababad; font-size: 13px; margin-bottom: 16px;">
        Set your Anthropic API key in the extension settings to enable smart prioritization.
      </div>
      <div style="margin-top: 12px; display: flex; gap: 8px; justify-content: center;">
        <button id="open-settings-btn">Open Settings</button>
        <button id="skip-key-btn" class="secondary">Skip</button>
      </div>
    </div>`;

  document.getElementById('open-settings-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('skip-key-btn').addEventListener('click', () => {
    render(rawData);
  });
}
// ── Async VIP section: wait for data, summarize, render ──
async function kickoffVipSection(data) {
  // Wait up to 10s for pendingVips to arrive from inject.js (VIP fetch involves user resolution + search API calls)
  let vips = pendingVips;
  if (vips === null) {
    await new Promise((resolve) => {
      const deadline = Date.now() + 10000;
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

  const vipArea = document.getElementById('vip-items');
  if (!vipArea) return;

  // Filter out messages the user has manually dismissed (per-VIP seen timestamp)
  // Note: we intentionally do NOT filter by channel lastRead — the point of "Creep on VIPs"
  // is to see what they've been saying even in channels you've already read
  const filteredVips = vips.map((v) => {
    const seenTs = vipSeenTimestamps[v.name];
    const msgs = v.messages.filter((m) => {
      if (seenTs && parseFloat(m.ts) <= parseFloat(seenTs)) return false;
      return true;
    });
    return { ...v, messages: msgs };
  });

  const relevantVips = filteredVips.filter((v) => v.messages.length > 0);
  if (relevantVips.length === 0) {
    vipArea.innerHTML = '';
    vipArea.dataset.loaded = '1';
    return;
  }

  // Summarize each VIP in parallel with a byte cap (#10: cache by vipName:latestTs)
  const MAX_PAYLOAD_BYTES = 2000;
  const summaries = await Promise.all(relevantVips.map(async (vip) => {
    const latestTs = vip.messages[0]?.ts || '';
    const cacheKey = `${vip.name}:${latestTs}`;
    if (_vipSummaryCache[cacheKey]) {
      console.log(`[fslack] VIP summary cache HIT: ${cacheKey}`);
      return { vip, result: _vipSummaryCache[cacheKey] };
    }
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
    if (response?.summary?.bullets) {
      _vipSummaryCache[cacheKey] = response.summary;
      chrome.storage.local.set({ fslackVipSummaryCache: _vipSummaryCache });
    }
    return { vip, result: response?.summary };
  }));

  let vipHtml = '';
  for (let i = 0; i < summaries.length; i++) {
    const { vip, result } = summaries[i];
    const latestTs = vip.messages[0]?.ts;
    const msgId = `vip-msgs-${i}`;
    const byChannel = new Map();
    for (const m of vip.messages) {
      const key = m.channel_id || m.channel_name || '?';
      if (!byChannel.has(key)) byChannel.set(key, { name: m.channel_name || '?', permalink: m.permalink, messages: [] });
      byChannel.get(key).messages.push(m);
    }
    let messagesHtml = '';
    for (const [chId, ch] of byChannel) {
      const chHref = ch.permalink ? escapeHtml(ch.permalink.replace(/\/p\d+$/, '')) : '#';
      const channelLabel = `<a class="item-channel-link vip-channel-link" href="${chHref}" target="_blank"><span class="item-channel">#${escapeHtml(ch.name)}</span><span class="open-in-slack"> open in Slack ↗</span></a>`;
      messagesHtml += `<div class="vip-channel-group">${channelLabel}<ul class="vip-msg-list">`;
      for (const m of ch.messages) {
        const msgLink = m.permalink ? `<a class="vip-msg-slack-link" href="${escapeHtml(m.permalink)}" target="_blank">open in Slack ↗</a>` : '';
        messagesHtml += `<li class="item-text vip-msg-row">${formatSlackHtml(m.text || '', data?.users)}${renderFiles(m.files)}${msgLink}</li>`;
      }
      messagesHtml += '</ul></div>';
    }
    const vipHref = vip.messages[0]?.permalink || '#';
    // Bullets prefixed with * are marked relevant — render with an indicator
    // Bullets may have [channel:ts] prefix for linking to specific messages
    const bullets = result?.bullets || [];
    const bulletsHtml = bullets.map((b) => {
      const isRelevant = b.startsWith('*');
      let text = isRelevant ? b.slice(1).trim() : b;
      const refMatch = text.match(/^\[([^:\]]+):(\d+\.\d+)\]\s*/);
      const liClass = isRelevant ? ' class="vip-bullet-relevant"' : '';
      if (refMatch) {
        const channel = refMatch[1];
        const ts = refMatch[2];
        text = text.slice(refMatch[0].length);
        // Resolve channel name to ID if needed (messages use name, permalink needs ID)
        const channelId = vip.messages.find(m => (m.channel_name === channel || m.channel_id === channel))?.channel_id || channel;
        const href = slackPermalink(channelId, ts);
        return `<li${liClass}><a class="summary-bullet-link" href="${href}" target="_blank" data-channel="${channelId}" data-ts="${ts}">${escapeHtml(text)}</a></li>`;
      }
      return `<li${liClass}>${escapeHtml(text)}</li>`;
    }).join('');
    vipHtml += `<div class="item vip-item">
      <div class="item-left">
        <a class="item-channel-link" href="${vipHref}" target="_blank"><span class="item-channel">${escapeHtml(vip.name)}</span><span class="open-in-slack"> open in Slack ↗</span></a>
        <span class="item-sep">·</span> <span class="item-time">${formatTime(latestTs)}</span>
        <span class="item-sep">·</span> ${headerExpandHtml(msgId, vip.messages.length, vip.messages.length === 1 ? 'message' : 'messages')}
      </div>
      <div class="item-right">
        ${bulletsHtml ? summaryToggleHtml(msgId, bulletsHtml, messagesHtml) : messagesHtml}
        <div style="display:flex;gap:12px;margin-top:6px;">
          <span class="show-messages-link vip-mark-seen" data-vip-name="${escapeHtml(vip.name)}" data-max-ts="${escapeHtml(vip.messages[0]?.ts || '')}" style="margin-top:0">mark as seen</span>
        </div>
      </div>
    </div>`;
  }

  if (!vipHtml) {
    vipArea.innerHTML = '';
    vipArea.dataset.loaded = '1';
    return;
  }
  vipArea.innerHTML = vipHtml;
  vipArea.dataset.loaded = '1';
}
// ── Persist summary helper ──
function getCachedSummary(type, channelId, ts) {
  const key = `${type}:${channelId}:${ts}`;
  return _allSummaryCache[key] || null;
}

function setCachedSummary(type, channelId, ts, summary) {
  const key = `${type}:${channelId}:${ts}`;
  _allSummaryCache[key] = summary;
  // Limit cache size to prevent storage bloat (keep most recent 200 entries)
  const keys = Object.keys(_allSummaryCache);
  if (keys.length > 200) {
    for (const k of keys.slice(0, keys.length - 200)) delete _allSummaryCache[k];
  }
  chrome.storage.local.set({ fslackAllSummaryCache: _allSummaryCache });
}

// ── Async bot thread summarization ──
function runBotThreadSummarization(whenFreeItems, data) {
  const botThreads = whenFreeItems.filter((item) => item._isBotThread && !item._botSummary);
  if (botThreads.length === 0) return;

  (async () => {
    for (const cp of botThreads) {
      // #11: Check persistent cache
      const cachedBot = getCachedSummary('bot', cp.channel_id, cp.sort_ts);
      if (cachedBot) {
        cp._botSummary = cachedBot;
        console.log(`[fslack] Bot summary cache HIT: ${cp.channel_id}:${cp.sort_ts}`);
      } else {
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
        setCachedSummary('bot', cp.channel_id, cp.sort_ts, cp._botSummary);
      }

      const key = `bot-thread-${cp.channel_id}-${(cp.sort_ts || '').replace('.', '_')}`;
      const itemEl = document.querySelector(`[data-bot-thread-key="${key}"]`);
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
            <span class="show-messages-link mark-all-read" data-channel="${cp.channel_id}" data-ts="${cp.messages[0]?.ts}" style="margin-top:0">mark as read</span>
          </div>
        </div></div>
        <div class="deep-messages" id="${deepMsgId}">${messagesHtml}</div>
        ${actionsHtml}`;
    }
  })();
}

// ── Async when-free channel post summarization ──
function runWhenFreeChannelSummarization(whenFreeItems, data) {
  const channels = whenFreeItems.filter((item) =>
    item._type === 'channel' && !item._isBotThread && !item._deepSummary && item.messages.length >= 1 && !item._channelSummary
  );
  if (channels.length === 0) return;

  (async () => {
    for (const cp of channels) {
      // #11: Check persistent cache
      const cachedChPost = getCachedSummary('chpost', cp.channel_id, cp.sort_ts);
      if (cachedChPost) {
        cp._channelSummary = cachedChPost;
        console.log(`[fslack] Channel post summary cache HIT: ${cp.channel_id}:${cp.sort_ts}`);
      } else {
        const ch = data.channels[cp.channel_id] || cp.channel_id;
        const messages = cp.messages.map((m) => ({
          user: m.subtype === 'bot_message' || !m.user ? 'Bot' : uname(m.user, data.users),
          text: plainTruncate(textWithFwd(m.text, m.fwd), 400, data.users),
          ts: m.ts,
        }));
        let response;
        try {
          response = await new Promise((resolve) =>
            chrome.runtime.sendMessage({ type: `${FSLACK}:summarizeChannelPost`, data: { channel: ch, channelId: cp.channel_id, messages } }, resolve)
          );
        } catch { continue; }
        if (!response?.summary?.summary) continue;
        cp._channelSummary = response.summary.summary;
        setCachedSummary('chpost', cp.channel_id, cp.sort_ts, cp._channelSummary);
      }

      const key = `ch-post-summary-${cp.channel_id}-${(cp.sort_ts || '').replace('.', '_')}`;
      const itemEl = document.querySelector(`[data-channel-summary-key="${key}"]`);
      if (!itemEl) continue;

      const csMsgId = `${key}-msgs`;
      let messagesHtml = '';
      for (const m of cp.messages.slice(0, 10).reverse()) {
        const threadUi = buildThreadUiMeta(data, cp.channel_id, m);
        messagesHtml += `<div class="msg-row"><div class="msg-content item-text">${userLink(m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users), cp.channel_id, m.ts)} ${renderMsgBody(m, cp.channel_id, data.users, 400, threadUi)}${threadRepliesContainer(m, cp.channel_id, threadUi)}</div>${msgActions(cp.channel_id, m.ts)}</div>`;
      }
      const rightEl = itemEl.querySelector('.item-right');
      const actionsEl = itemEl.querySelector('.item-actions');
      const actionsHtml = actionsEl ? actionsEl.outerHTML : '';
      const bullets = renderChannelSummaryBullets(cp._channelSummary, cp.channel_id);
      rightEl.innerHTML = summaryToggleHtml(csMsgId, bullets, messagesHtml) + actionsHtml;
    }
  })();
}

// ── Async thread reply summarization (non-DM threads meeting summary criteria) ──
function runThreadReplySummarization(allItems, data) {
  const threads = allItems.filter((item) => item._type === 'thread' && !item._fullThreadSummary && threadNeedsSummary(item));
  if (threads.length === 0) return;

  const MAX_PAYLOAD_BYTES = 3000;

  (async () => {
    for (const t of threads) {
      // #11: Check persistent cache (key by latest unread reply ts)
      const latestReplyTs = (t.unread_replies || []).slice(-1)[0]?.ts || t.ts;
      const cachedThread = getCachedSummary('fullthread', t.channel_id, latestReplyTs);
      if (cachedThread) {
        t._fullThreadSummary = cachedThread;
        console.log(`[fslack] Full thread summary cache HIT: ${t.channel_id}:${latestReplyTs}`);
      } else {
        const ch = data.channels[t.channel_id] || t.channel_id;
        const unread = t.unread_replies || [];
        const replies = [];
        let bytes = 0;
        for (const r of unread) {
          const entry = { user: fullName(r.user, data.fullNames), text: plainTruncate(textWithFwd(r.text, r.fwd), 400, data.users) };
          const s = JSON.stringify(entry);
          if (bytes + s.length > MAX_PAYLOAD_BYTES) break;
          bytes += s.length;
          replies.push(entry);
        }

        let response;
        try {
          response = await new Promise((resolve) =>
            chrome.runtime.sendMessage({
              type: `${FSLACK}:summarizeFullThread`,
              data: { channel: ch, rootUser: fullName(t.root_user, data.fullNames), rootText: plainTruncate(textWithFwd(t.root_text, t.root_fwd), 400, data.users), replies }
            }, resolve)
          );
        } catch { continue; }
        if (!response?.summary?.summary) continue;
        t._fullThreadSummary = response.summary.summary;
        setCachedSummary('fullthread', t.channel_id, latestReplyTs, t._fullThreadSummary);
      }

      const threadKey = `thread-summary-${t.channel_id}-${(t.ts || '').replace('.', '_')}`;
      const loadingEl = document.getElementById(`${threadKey}-loading`);
      if (!loadingEl) continue;

      // Replace loading text with bullet summary in the root content area
      const bullets = t._fullThreadSummary.split('\n').filter(b => b.trim()).map(b => b.replace(/^-\s*/, ''));
      const selfName = (data.users?.[data.selfId] || '').toLowerCase();
      const rootBullet = bullets[0] || '';
      const rootNamePart = rootBullet.split(/\s/)[0].toLowerCase();
      const rootIsSelf = selfName && rootNamePart === selfName;
      const wrapper = document.createDocumentFragment();
      const rootDiv = document.createElement('div');
      rootDiv.className = 'deep-summary' + (rootIsSelf ? ' self-bullet' : '');
      rootDiv.style.cssText = 'margin:2px 0';
      rootDiv.textContent = rootBullet;
      wrapper.appendChild(rootDiv);
      if (bullets.length > 1) {
        const ul = document.createElement('ul');
        ul.className = 'deep-summary deep-replies';
        ul.innerHTML = bullets.slice(1).map(b => {
          const namePart = b.split(/\s/)[0].toLowerCase();
          const isSelf = selfName && namePart === selfName;
          return `<li${isSelf ? ' class="self-bullet"' : ''}>${escapeHtml(b)}</li>`;
        }).join('');
        wrapper.appendChild(ul);
      }
      const msgRow = loadingEl.closest('.msg-row.summarized');
      loadingEl.replaceWith(wrapper);
      if (msgRow && !msgRow.querySelector('.thread-orig-root')) {
        const _ortid = truncateId;
        const origText = truncate(t.root_text, 400, data.users);
        const origExtras = wrapFilesIfTruncated(_ortid, renderFwd(t.root_fwd, data.users), renderFiles(t.root_files));
        const origDiv = document.createElement('div');
        origDiv.className = 'msg-content item-text thread-orig-root';
        origDiv.style.display = 'none';
        origDiv.innerHTML = `${userLink(uname(t.root_user, data.users), t.channel_id, t.ts)} ${origText}${origExtras}${msgTime(t.ts, t.channel_id)}`;
        const actionsEl = msgRow.querySelector('.msg-actions');
        if (actionsEl) msgRow.insertBefore(origDiv, actionsEl);
        else msgRow.appendChild(origDiv);
      }
    }
  })();
}
// ── Root message summarization (truncate long roots — no LLM call needed) ──
function runRootSummarization(allItems, data) {
  const threads = allItems.filter((item) => {
    if (item._type !== 'thread') return false;
    if (item._rootSummary) return false;
    if (threadNeedsSummary(item)) return false;
    const seenCount = Math.max(0, (item.reply_count || 0) - (item.unread_replies || []).length);
    return seenCount > 0 && (item.root_text || '').length > 300;
  });
  if (threads.length === 0) return;

  for (const t of threads) {
    // Simple truncation instead of LLM call
    const plain = plainTruncate(textWithFwd(t.root_text, t.root_fwd), 150, data.users);
    t._rootSummary = plain;

    const rootKey = `root-summary-${t.channel_id}-${(t.ts || '').replace('.', '_')}`;
    const pendingEl = document.getElementById(rootKey);
    if (!pendingEl) continue;

    const summarySpan = document.createElement('span');
    summarySpan.className = 'root-summary';
    summarySpan.textContent = t._rootSummary;
    pendingEl.replaceWith(summarySpan);
  }
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
        delete pendingOneShot[reqId];
        resolve([]);
      }, FETCH_TIMEOUT);
      pendingOneShot[reqId] = (msg) => {
        clearTimeout(timer);
        console.log(`[chThreadSumm] fetchReplies OK reqId=${reqId} replies=${(msg.replies || []).length}`);
        resolve(msg.replies || []);
      };
      sendToInject({ type: `${FSLACK}:fetchReplies`, channel, ts, requestId: reqId });
    });
  }

  // Collect all qualifying messages, skip already-summarized
  const tasks = [];
  for (const cp of items) {
    const ch = data.channels[cp.channel_id] || cp.channel_id;
    for (const m of cp.messages) {
      if ((m.reply_count || 0) < 5) continue;
      if (m._chThreadSummary) continue; // already summarized (from cache)
      const key = `ch-thread-summary-${cp.channel_id}-${(m.ts || '').replace('.', '_')}`;
      tasks.push({ cp, ch, m, key });
    }
  }
  if (tasks.length === 0) return;

  console.log(`[chThreadSumm] starting ${tasks.length} thread summarizations`);
  for (const { cp, ch, m, key } of tasks) {
    (async () => {
      const loadingEl = document.getElementById(`${key}-loading`);
      if (!loadingEl) { console.warn(`[chThreadSumm] no loadingEl for key=${key}`); return; }

      // #11: Check persistent cache
      const cachedChThread = getCachedSummary('chthread', cp.channel_id, m.ts);
      if (cachedChThread) {
        m._chThreadSummary = cachedChThread;
        console.log(`[chThreadSumm] cache HIT for key=${key}`);
        const summaryEl = document.createElement('div');
        summaryEl.className = 'deep-summary';
        summaryEl.style.cssText = 'margin:6px 0 2px';
        summaryEl.textContent = cachedChThread;
        loadingEl.replaceWith(summaryEl);
        return;
      }

      console.log(`[chThreadSumm] fetching replies for key=${key} channel=${cp.channel_id} ts=${m.ts}`);
      const rawReplies = await fetchRepliesAsync(cp.channel_id, m.ts);
      if (rawReplies.length === 0) { console.warn(`[chThreadSumm] no replies for key=${key}`); loadingEl.remove(); return; }
      console.log(`[chThreadSumm] got ${rawReplies.length} raw replies for key=${key}, sending to LLM`);

      const replies = [];
      let bytes = 0;
      for (const r of rawReplies) {
        const entry = { user: fullName(r.user, data.fullNames), text: plainTruncate(textWithFwd(r.text, r.fwd), 400, data.users) };
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
            data: { channel: ch, rootUser: fullName(m.user, data.fullNames), rootText: plainTruncate(textWithFwd(m.text, m.fwd), 400, data.users), replies }
          }, resolve)
        );
      } catch (err) { console.error(`[chThreadSumm] sendMessage error for key=${key}`, err); return; }
      if (!response?.summary?.summary) { console.warn(`[chThreadSumm] no summary in response for key=${key}`, response); loadingEl.remove(); return; }

      // Cache summary on the message object so it persists across renders
      m._chThreadSummary = response.summary.summary;
      setCachedSummary('chthread', cp.channel_id, m.ts, m._chThreadSummary);

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

// Pre-warm the per-item summary cache in background (no DOM changes)
function warmSummaryCache(data) {
  const preFiltered = applyPreFilters(data);
  const { forLlm } = preFiltered;
  const totalItems = forLlm.threads.length + forLlm.dms.length + forLlm.channelPosts.length;
  if (totalItems === 0) return;

  const allItems = serializeForLlm(forLlm, data, 0);
  const ITEMS_PER_BATCH = 50;
  const now = Date.now();
  const uncachedItems = [];
  for (const item of allItems) {
    const itemHash = djb2Hash(JSON.stringify(item));
    item._hash = itemHash;
    const cached = _itemSummaryCache[itemHash];
    if (cached?.s) {
      cached.t = now;
    } else {
      uncachedItems.push(item);
    }
  }
  if (uncachedItems.length === 0) {
    console.log('[fslack] Summary cache warm: all items cached');
    return;
  }
  console.log(`[fslack] Warming summary cache: ${uncachedItems.length} uncached items`);
  const batches = [];
  for (let i = 0; i < uncachedItems.length; i += ITEMS_PER_BATCH) {
    batches.push(uncachedItems.slice(i, i + ITEMS_PER_BATCH));
  }
  function sendBatch(batch) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: `${FSLACK}:batchSummarize`, data: batch }, (resp) => {
        if (chrome.runtime.lastError) { resolve({}); return; }
        resolve(resp?.summaries || {});
      });
    });
  }
  Promise.all(batches.map(sendBatch)).then((results) => {
    const MAX_ITEM_SUMMARY_CACHE = 500;
    let updated = false;
    for (const summaries of results) {
      for (const item of uncachedItems) {
        if (summaries[item.id] && item._hash) {
          _itemSummaryCache[item._hash] = { s: summaries[item.id], t: now };
          updated = true;
        }
      }
    }
    if (updated) {
      const keys = Object.keys(_itemSummaryCache);
      if (keys.length > MAX_ITEM_SUMMARY_CACHE) {
        keys.sort((a, b) => (_itemSummaryCache[a].t || 0) - (_itemSummaryCache[b].t || 0));
        const toRemove = keys.length - MAX_ITEM_SUMMARY_CACHE;
        for (let i = 0; i < toRemove; i++) delete _itemSummaryCache[keys[i]];
      }
      chrome.storage.local.set({ fslackItemSummaryCache: _itemSummaryCache });
    }
    console.log(`[fslack] Summary cache warmed: ${uncachedItems.length} items pre-summarized`);
  });
}

function prioritizeAndRender(data) {
  // Build self-mention regex from Slack handle and cache handle for Claude prompts
  if (data.selfHandle) {
    const escaped = data.selfHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    _handleMentionRegex = new RegExp(`(?:^|[\\s"'([{<])@${escaped}(?=$|[\\s.,!?;:)\\]\\}>"'])`, 'i');
    chrome.storage.local.set({ selfHandle: data.selfHandle });
  }
  // Cache VIP names for Claude prompts (resolve IDs → display names)
  if (data.vipUserIds && data.users) {
    const vipNames = data.vipUserIds.map((uid) => data.users[uid]).filter(Boolean);
    chrome.storage.local.set({ vipNames });
  }
  // Cache sidebar section names for options page
  if (data.sidebarSectionNames && data.sidebarSectionNames.length) {
    chrome.storage.local.set({ sidebarSectionNames: data.sidebarSectionNames });
  }
  myReactionsMap = buildMyReactionsMap(data);
  const preFiltered = applyPreFilters(data);
  const { forLlm } = preFiltered;
  const totalItems = forLlm.threads.length + forLlm.dms.length + forLlm.channelPosts.length;

  if (totalItems === 0) {
    // Only noise/dropped/bot — render what we have
    const prioritized = { actNow: [], priority: [], whenFree: preFiltered.whenFree, noise: preFiltered.noise, digests: preFiltered.digests };
    // Fast fetch: merge cached channel items (excluding freshly fetched mention channels)
    if (isFastFetch && cachedView?.prioritized) {
      const cached = cachedView.prioritized;
      const freshChannelIds = new Set((data.channelPosts || []).map(cp => cp.channel_id));
      const isCachedChannel = (item) => item._type === 'channel' && !freshChannelIds.has(item.channel_id);
      prioritized.actNow.push(...(cached.actNow || []).filter(isCachedChannel));
      prioritized.priority.push(...(cached.priority || []).filter(isCachedChannel));
      prioritized.whenFree.push(...(cached.whenFree || []).filter(isCachedChannel));
      prioritized.noise.push(...(cached.noise || []).filter(isCachedChannel));
      prioritized.digests.push(...(cached.digests || []).filter(isCachedChannel));
      if (cachedView.data?.channels) data.channels = { ...cachedView.data.channels, ...data.channels };
      if (cachedView.data?.channelMeta) data.channelMeta = { ...cachedView.data.channelMeta, ...data.channelMeta };
      if (cachedView.data?.users) data.users = { ...cachedView.data.users, ...data.users };
    }
    renderPrioritized(prioritized, data, pendingPopular, false, false, pendingSaved || [], false, isFastFetch && cachedView ? cachedView.ts : null);
    runBotThreadSummarization(prioritized.whenFree, data);
    runWhenFreeChannelSummarization(prioritized.whenFree, data);
    const allElevatedEarly = [...prioritized.actNow, ...prioritized.priority, ...prioritized.whenFree];
    runThreadReplySummarization(allElevatedEarly, data);
    runChannelThreadSummarization(allElevatedEarly, data);
    runRootSummarization(allElevatedEarly, data);
    saveViewCache(data, pendingPopular, prioritized, pendingSaved || []);
    return;
  }

  // Show loading while LLM works
  bodyEl.innerHTML = '<div id="status"><div class="detail">Summarizing messages...</div></div>';

  const selfName = data.users?.[data.selfId] || '';

  // Serialize all items for batch summarization
  const allItems = serializeForLlm(forLlm, data, 0);

  // #7: Content-hash dedup — skip calls if payload unchanged
  const allHash = djb2Hash(JSON.stringify(allItems));

  // ── Batch summarize → lean prioritize pipeline ──
  const ITEMS_PER_BATCH = 50; // ~30 tokens output per summary, 50 * 30 = 1500 < 2048 limit

  function sendBatchSummarize(batch) {
    return new Promise((resolve) => {
      if (batch.length === 0) { resolve({ summaries: {} }); return; }
      chrome.runtime.sendMessage({ type: `${FSLACK}:batchSummarize`, data: batch }, (resp) => {
        if (chrome.runtime.lastError) { resolve({ error: 'extension_error' }); return; }
        resolve(resp);
      });
    });
  }

  function sendPrioritize(items) {
    return new Promise((resolve) => {
      if (items.length === 0) { resolve({ priorities: {}, noiseOrder: [] }); return; }
      chrome.runtime.sendMessage({ type: `${FSLACK}:prioritize`, data: items, selfName }, (resp) => {
        if (chrome.runtime.lastError) { resolve({ error: 'extension_error' }); return; }
        resolve(resp);
      });
    });
  }

  // Build lean items for prioritization (metadata + summary, no raw text)
  function buildLeanItems(items, summaries) {
    return items.map((item) => {
      const lean = {
        id: item.id,
        type: item.type,
        summary: summaries[item.id] || '(no summary)',
      };
      if (item.channel) lean.channel = item.channel;
      if (item.isPrivate) lean.isPrivate = true;
      if (item.isMentioned) lean.isMentioned = true;
      if (item.sidebarSection && item.sidebarSection !== 'normal') lean.sidebarSection = item.sidebarSection;
      if (item.userReplied) lean.userReplied = true;
      if (item.isGroup) lean.isGroup = true;
      if (item.participants) lean.participants = item.participants;
      if (item.mentionCount) lean.mentionCount = item.mentionCount;
      return lean;
    });
  }

  function handleLlmError(error, stage) {
    if (error === 'extension_error') { render(data); return; }
    if (error === 'no_api_key') { showApiKeyPrompt(data); return; }
    console.warn(`FSlack ${stage} error:`, error);
    if (cachedView?.prioritized) {
      renderPrioritized(cachedView.prioritized, cachedView.data, cachedView.popular, false, false, cachedView.saved || [], false, cachedView.ts);
      const banner = document.createElement('div');
      banner.className = 'warning-banner';
      banner.textContent = 'Showing cached results (API temporarily unavailable)';
      bodyEl.insertBefore(banner, bodyEl.firstChild);
    } else {
      render(data);
      const banner = document.createElement('div');
      banner.className = 'warning-banner';
      banner.textContent = `${stage} unavailable: ${error}`;
      bodyEl.insertBefore(banner, bodyEl.firstChild);
    }
  }

  // Check full pipeline cache
  if (_prioritizationCache && _prioritizationCache.allHash === allHash) {
    console.log('[fslack] Pipeline cache HIT — skipping summarize + prioritize');
    handlePrioritizeResult(_prioritizationCache.result);
    return;
  }

  // Per-item summary cache: hash each item, reuse cached summaries, only send uncached items
  // Cache entries: { hash: { s: summary, t: timestamp } }
  const cachedSummaries = {};
  const uncachedItems = [];
  const now = Date.now();
  for (const item of allItems) {
    const itemHash = djb2Hash(JSON.stringify(item));
    item._hash = itemHash; // store for later cache update
    const cached = _itemSummaryCache[itemHash];
    if (cached?.s) {
      cachedSummaries[item.id] = cached.s;
      cached.t = now; // touch for LRU
    } else {
      uncachedItems.push(item);
    }
  }
  console.log(`[fslack] Item summary cache: ${Object.keys(cachedSummaries).length} cached, ${uncachedItems.length} need summarization`);

  // Split uncached items into batches for parallel summarization
  const batches = [];
  for (let i = 0; i < uncachedItems.length; i += ITEMS_PER_BATCH) {
    batches.push(uncachedItems.slice(i, i + ITEMS_PER_BATCH));
  }

  // Step 1: Parallel batch summarize (only uncached items)
  const summarizePromise = batches.length > 0
    ? Promise.all(batches.map(sendBatchSummarize))
    : Promise.resolve([]);

  summarizePromise.then((batchResults) => {
    const firstError = batchResults.find((r) => r?.error);
    if (firstError) { handleLlmError(firstError.error, 'Summarization'); return; }

    // Merge cached + fresh summaries
    const summaries = { ...cachedSummaries };
    for (const r of batchResults) Object.assign(summaries, r.summaries || {});

    // Update per-item cache with fresh summaries
    const MAX_ITEM_SUMMARY_CACHE = 500;
    let cacheUpdated = false;
    for (const item of uncachedItems) {
      if (summaries[item.id] && item._hash) {
        _itemSummaryCache[item._hash] = { s: summaries[item.id], t: now };
        cacheUpdated = true;
      }
    }
    // Evict oldest entries if cache exceeds max size
    const keys = Object.keys(_itemSummaryCache);
    if (keys.length > MAX_ITEM_SUMMARY_CACHE) {
      keys.sort((a, b) => (_itemSummaryCache[a].t || 0) - (_itemSummaryCache[b].t || 0));
      const toRemove = keys.length - MAX_ITEM_SUMMARY_CACHE;
      for (let i = 0; i < toRemove; i++) delete _itemSummaryCache[keys[i]];
      cacheUpdated = true;
    }
    if (cacheUpdated) chrome.storage.local.set({ fslackItemSummaryCache: _itemSummaryCache });

    console.log(`[fslack] Got ${Object.keys(summaries).length} total summaries (${Object.keys(cachedSummaries).length} cached, ${uncachedItems.length} fresh)`);

    // Step 2: Single lean prioritize call
    bodyEl.innerHTML = '<div id="status"><div class="detail">Prioritizing...</div></div>';
    const leanItems = buildLeanItems(allItems, summaries);
    return sendPrioritize(leanItems).then((resp) => {
      if (resp?.error) { handleLlmError(resp.error, 'Prioritization'); return; }

      // Cache the full pipeline result
      _prioritizationCache = { allHash, result: resp };
      chrome.storage.local.set({ fslackPrioritizationCache: _prioritizationCache });
      handlePrioritizeResult(resp);
    });
  });

  function handlePrioritizeResult(resp) {
      const mergedPriorities = resp.priorities || {};
      const mergedNoiseOrder = resp.noiseOrder || [];
      const mergedReasons = resp.reasons || {};

      const prioritized = mapPriorities(mergedPriorities, forLlm, preFiltered.noise, preFiltered.whenFree, data, mergedReasons);
      prioritized.digests = preFiltered.digests;

      // Fast fetch: merge cached channel items from previous full fetch (excluding freshly fetched mention channels)
      if (isFastFetch && cachedView?.prioritized) {
        const cached = cachedView.prioritized;
        const freshChannelIds = new Set((data.channelPosts || []).map(cp => cp.channel_id));
        const isCachedChannel = (item) => item._type === 'channel' && !freshChannelIds.has(item.channel_id);
        prioritized.actNow.push(...(cached.actNow || []).filter(isCachedChannel));
        prioritized.priority.push(...(cached.priority || []).filter(isCachedChannel));
        prioritized.whenFree.push(...(cached.whenFree || []).filter(isCachedChannel));
        prioritized.noise.push(...(cached.noise || []).filter(isCachedChannel));
        prioritized.digests.push(...(cached.digests || []).filter(isCachedChannel));
        // Merge cached channel/user maps into data for rendering
        if (cachedView.data?.channels) data.channels = { ...cachedView.data.channels, ...data.channels };
        if (cachedView.data?.channelMeta) data.channelMeta = { ...cachedView.data.channelMeta, ...data.channelMeta };
        if (cachedView.data?.users) data.users = { ...cachedView.data.users, ...data.users };
        console.log('[fslack] Fast fetch: merged cached channel items into prioritized result');
      }

      prioritized.noise = sortNoiseItems(prioritized.noise, mergedNoiseOrder);
      // Split channel items by 24h at the data level so summarization only sees relevant messages
      const noiseSplitCutoff = Date.now() / 1000 - 86400;
      const splitNoise = [];
      for (const item of prioritized.noise) {
        if (item._type === 'channel' && item.messages && item.messages.length > 1) {
          const rMsgs = item.messages.filter(m => parseFloat(m.ts) >= noiseSplitCutoff);
          const oMsgs = item.messages.filter(m => parseFloat(m.ts) < noiseSplitCutoff);
          if (rMsgs.length > 0 && oMsgs.length > 0) {
            const rItem = { ...item, messages: rMsgs, sort_ts: rMsgs[0]?.ts || item.sort_ts };
            if (item.fullMessages) rItem.fullMessages = { ...item.fullMessages, history: rMsgs };
            splitNoise.push(rItem);
            const oItem = { ...item, messages: oMsgs, sort_ts: oMsgs[0]?.ts || item.sort_ts, _deepSummary: null, _channelSummary: null };
            if (item.fullMessages) oItem.fullMessages = { ...item.fullMessages, history: oMsgs };
            splitNoise.push(oItem);
            continue;
          }
        }
        splitNoise.push(item);
      }
      prioritized.noise = sortNoiseItems(splitNoise, mergedNoiseOrder);
      let deepNoise = prioritized.noise.filter((item) =>
        (item.fullMessages?.history || item.messages || []).length >= 1
      );
      let regularNoise = prioritized.noise.filter((item) =>
        (item.fullMessages?.history || item.messages || []).length < 1
      );
      const allElevated = [...prioritized.actNow, ...prioritized.priority, ...prioritized.whenFree];

      const MAX_PAYLOAD_BYTES = 3000;
      function buildSummarizePayload(cp) {
        const ch = data.channels[cp.channel_id] || cp.channel_id;
        const allMsgs = cp.fullMessages?.history || cp.messages || [];
        const messages = [];
        let bytes = 0;
        for (const m of allMsgs) {
          const entry = {
            user: m.subtype === 'bot_message' || !m.user ? 'Bot' : uname(m.user, data.users),
            text: plainTruncate(textWithFwd(m.text, m.fwd), 400, data.users),
            ts: m.ts,
          };
          const s = JSON.stringify(entry);
          if (bytes + s.length > MAX_PAYLOAD_BYTES) break;
          messages.push(entry);
          bytes += s.length;
        }
        return { channel: ch, channelId: cp.channel_id, messages };
      }

      // #8: Cached summarize — reuse if channelId:latestTs matches
      async function cachedSummarize(cp) {
        const allMsgs = cp.fullMessages?.history || cp.messages || [];
        const latestTs = allMsgs[0]?.ts || '';
        const cacheKey = `${cp.channel_id}:${latestTs}`;
        if (_summaryCache[cacheKey]) {
          console.log(`[fslack] Summary cache HIT: ${cacheKey}`);
          return { cp, result: _summaryCache[cacheKey] };
        }
        const payload = buildSummarizePayload(cp);
        let response;
        try {
          response = await new Promise((resolve) =>
            chrome.runtime.sendMessage({ type: `${FSLACK}:summarize`, data: payload }, resolve)
          );
        } catch { return { cp, result: null }; }
        if (response?.summary) {
          _summaryCache[cacheKey] = response.summary;
          chrome.storage.local.set({ fslackSummaryCache: _summaryCache });
        }
        return { cp, result: response?.summary };
      }

      // Fast fetch: render from cache, then summarize any unsummarized noise items in-place
      if (isFastFetch) {
        const unsummarizedNoise = prioritized.noise.filter((item) =>
          !item._deepSummary && (item.fullMessages?.history || item.messages || []).length >= 1
        );
        renderPrioritized(prioritized, data, pendingPopular, false, false, pendingSaved || [], false, cachedView ? cachedView.ts : null);
        runBotThreadSummarization(prioritized.whenFree, data);
        runWhenFreeChannelSummarization(prioritized.whenFree, data);
        runThreadReplySummarization(allElevated, data);
        runChannelThreadSummarization(allElevated, data);
        runRootSummarization(allElevated, data);
        if (unsummarizedNoise.length === 0) {
          saveViewCache(data, pendingPopular, prioritized, pendingSaved || []);
          return;
        }
        // Summarize unsummarized noise items in-place without re-rendering
        (async () => {
          const noiseRecentEl = document.getElementById('noise-recent-items');
          const noiseOlderEl = document.getElementById('noise-older-items');
          const noiseRecentToggleEl = document.getElementById('noise-recent-toggle');
          const noiseOlderToggleEl = document.getElementById('noise-older-toggle');

          const results = await Promise.all(unsummarizedNoise.map(cachedSummarize));

          for (const { cp, result } of results) {
            if (result?.bullets?.length) {
              cp._deepSummary = result.bullets.join('\n');
            } else if (result?.summary) {
              cp._deepSummary = result.summary;
            }
            if (!cp._deepSummary) {
              // Fallback: use first message text truncated
              const msgs = cp.fullMessages?.history || cp.messages || [];
              const first = msgs[0];
              if (first) {
                const name = first.subtype === 'bot_message' || !first.user ? 'Bot' : uname(first.user, data.users);
                cp._deepSummary = `${name}: ${plainTruncate(first.text || '', 200, data.users)}`;
              }
            }
          }

          // Re-render noise sections in-place
          const allNoise = sortNoiseItems(prioritized.noise, mergedNoiseOrder);
          const noiseCutoff = Date.now() / 1000 - 86400;
          const allNoiseRecent = allNoise.filter((item) => getItemSortTs(item) >= noiseCutoff);
          const allNoiseOlder = allNoise.filter((item) => getItemSortTs(item) < noiseCutoff);

          if (noiseRecentEl) {
            let recentHtml = '';
            for (const item of allNoiseRecent) recentHtml += renderAnyItem(item, data, 'noise-item');
            recentHtml += `<div class="noise-section-footer"><button id="noise-mark-recent-btn">Mark all recent as read</button></div>`;
            noiseRecentEl.innerHTML = recentHtml;
            if (noiseRecentToggleEl) {
              const expanded = noiseRecentEl.classList.contains('expanded');
              noiseRecentToggleEl.textContent = `Recent noise · ${allNoiseRecent.length} ${expanded ? '↑' : '↓'}`;
            }
          }
          if (noiseOlderEl) {
            let olderHtml = '';
            for (const item of allNoiseOlder) olderHtml += renderAnyItem(item, data, 'noise-item');
            olderHtml += `<div class="noise-section-footer" id="noise-older-footer"${allNoiseOlder.length === 0 ? ' style="display:none"' : ''}><button id="noise-mark-older-btn">Mark all older as read</button></div>`;
            noiseOlderEl.innerHTML = olderHtml;
            if (allNoiseOlder.length > 0 && noiseOlderToggleEl) noiseOlderToggleEl.style.display = '';
            if (noiseOlderToggleEl) {
              const expanded = noiseOlderEl.classList.contains('expanded');
              noiseOlderToggleEl.textContent = `Older noise · ${allNoiseOlder.length} ${expanded ? '↑' : '↓'}`;
            }
          }

          saveViewCache(data, pendingPopular, { ...prioritized, noise: allNoise }, pendingSaved || []);
        })();
        return;
      }

      if (deepNoise.length === 0) {
        renderPrioritized(prioritized, data, pendingPopular, false, false, pendingSaved || []);
        runBotThreadSummarization(prioritized.whenFree, data);
        runWhenFreeChannelSummarization(prioritized.whenFree, data);
        runThreadReplySummarization(allElevated, data);
        runChannelThreadSummarization(allElevated, data);
        runRootSummarization(allElevated, data);
        saveViewCache(data, pendingPopular, prioritized, pendingSaved || []);
        return;
      }

      // Render main sections; loading indicators show for each type
      renderPrioritized({ ...prioritized, noise: regularNoise }, data, pendingPopular, false, deepNoise.length > 0, pendingSaved || [], false);
      runBotThreadSummarization(prioritized.whenFree, data);
      runWhenFreeChannelSummarization(prioritized.whenFree, data);
      runThreadReplySummarization(allElevated, data);
      runChannelThreadSummarization(allElevated, data);
      runRootSummarization(allElevated, data);
      saveViewCache(data, pendingPopular, { ...prioritized, noise: regularNoise }, pendingSaved || []);

      // Summarize each deep-noise and digest channel individually
      (async () => {
        const deepNoiseArea = document.getElementById('deep-noise-area');
        const noiseRecentEl = document.getElementById('noise-recent-items');
        const noiseOlderEl = document.getElementById('noise-older-items');
        const noiseRecentToggleEl = document.getElementById('noise-recent-toggle');
        const noiseOlderToggleEl = document.getElementById('noise-older-toggle');
        let noiseDone = 0;
        if (deepNoiseArea && deepNoise.length > 0) deepNoiseArea.textContent = `Summarizing channels... 0/${deepNoise.length}`;

        const results = await Promise.all(deepNoise.map(async (cp) => {
          const { result } = await cachedSummarize(cp);
          noiseDone++;
          if (deepNoiseArea) deepNoiseArea.textContent = `Summarizing channels... ${noiseDone}/${deepNoise.length}`;
          return { cp, result };
        }));

        if (deepNoiseArea) deepNoiseArea.textContent = '';

        for (const { cp, result } of results) {
          if (result?.bullets?.length) {
            cp._deepSummary = result.bullets.join('\n');
          } else if (result?.summary) {
            cp._deepSummary = result.summary;
          }
          if (!cp._deepSummary) {
            // Fallback: use first message text truncated
            const msgs = cp.fullMessages?.history || cp.messages || [];
            const first = msgs[0];
            if (first) {
              const name = first.subtype === 'bot_message' || !first.user ? 'Bot' : uname(first.user, data.users);
              cp._deepSummary = `${name}: ${plainTruncate(first.text || '', 200, data.users)}`;
            }
          }
        }

        // Sort ALL noise items by message count desc, then recency desc
        const allNoise = sortNoiseItems([...regularNoise, ...deepNoise], mergedNoiseOrder);
        const noiseCutoff = Date.now() / 1000 - 86400;
        const allNoiseRecent = allNoise.filter((item) => getItemSortTs(item) >= noiseCutoff);
        const allNoiseOlder = allNoise.filter((item) => getItemSortTs(item) < noiseCutoff);

        if (noiseRecentEl) {
          let recentHtml = '';
          for (const item of allNoiseRecent) recentHtml += renderAnyItem(item, data, 'noise-item');
          recentHtml += `<div class="noise-section-footer"><button id="noise-mark-recent-btn">Mark all recent as read</button></div>`;
          noiseRecentEl.innerHTML = recentHtml;
          if (noiseRecentToggleEl) {
            const count = allNoiseRecent.length;
            const expanded = noiseRecentEl.classList.contains('expanded');
            noiseRecentToggleEl.textContent = `Recent noise · ${count} ${expanded ? '↑' : '↓'}`;
          }
        }
        if (noiseOlderEl) {
          let olderHtml = '';
          for (const item of allNoiseOlder) olderHtml += renderAnyItem(item, data, 'noise-item');
          olderHtml += `<div class="noise-section-footer" id="noise-older-footer"${allNoiseOlder.length === 0 ? ' style="display:none"' : ''}><button id="noise-mark-older-btn">Mark all older as read</button></div>`;
          noiseOlderEl.innerHTML = olderHtml;
          if (allNoiseOlder.length > 0) {
            if (noiseOlderToggleEl) noiseOlderToggleEl.style.display = '';
          }
          if (noiseOlderToggleEl) {
            const count = allNoiseOlder.length;
            const expanded = noiseOlderEl.classList.contains('expanded');
            noiseOlderToggleEl.textContent = `Older noise · ${count} ${expanded ? '↑' : '↓'}`;
          }
        }

        saveViewCache(data, pendingPopular, { ...prioritized, noise: allNoise }, pendingSaved || []);
      })();
  }
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
      const fbThreadTs = lastUnread?.ts || t.ts;
      const fbThreadHref = slackPermalink(t.channel_id, t.ts) || `https://app.slack.com/archives/${t.channel_id}`;
      html += `<div class="item">
        <div class="item-left">
          ${itemLeftLink(`<span class="item-channel">#${ch}</span> <span class="item-sep">·</span> <span class="item-time">${formatTime(fbThreadTs)}</span>`, fbThreadHref)}
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
        html += `<div class="item-reply">${userLink(uname(r.user, users), t.channel_id, r.ts, t.ts)} ${frTextHtml}${frExtras}</div>`;
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
      const fbDmHref = slackPermalink(dm.channel_id, lastMsg.ts) || `https://app.slack.com/archives/${dm.channel_id}`;
      html += `<div class="item">
        <div class="item-left">
          ${itemLeftLink(`<span class="item-channel">DM</span> <span class="item-sep">·</span> <span class="item-time">${formatTime(lastMsg.ts)}</span>`, fbDmHref)}
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
      const fbChHref = slackPermalink(cp.channel_id, latest?.ts) || `https://app.slack.com/archives/${cp.channel_id}`;
      html += `<div class="item">
        <div class="item-left">
          ${itemLeftLink(`<span class="item-channel">#${ch}</span> <span class="item-sep">·</span> <span class="item-time">${formatTime(latest?.ts)}</span>`, fbChHref)}`;
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

// ── Listen for messages from inject.js ──
let pendingUnreads = null;
let gotUnreads = false;
let gotPopular = false;
let isFastFetch = false;

function resetFetchState() {
  pendingUnreads = null;
  pendingPopular = null;
  pendingVips = null;
  pendingSaved = null;
  gotUnreads = false;
  gotPopular = false;
  gotSaved = false;
  isFastFetch = false;
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

  if (isBackgroundFetch) {
    isBackgroundFetch = false;

    // Auto-refresh if user hasn't scrolled or expanded anything
    const hasExpanded = bodyEl.querySelector('.expanded, .is-expanded, .reply-form');
    const atTop = bodyEl.scrollTop === 0 && document.documentElement.scrollTop === 0;
    if (atTop && !hasExpanded) {
      console.log('[fslack] Auto-refresh: scroll at top, nothing expanded');
      refreshLink.textContent = 'refresh now';
      refreshLink.style.display = '';
      lastFetchTime = Date.now();
      updateLastUpdated();
      if (lastUpdatedTimer) clearInterval(lastUpdatedTimer);
      lastUpdatedTimer = setInterval(updateLastUpdated, 1000);
      fetchBtn.textContent = 'Fetch Unreads';
      prioritizeAndRender(data);
      scheduleBackgroundPoll();
      return;
    }

    // Pre-warm summary cache in background so click is fast
    stagedRenderData = data;
    warmSummaryCache(data);
    refreshLink.textContent = 'new update available';
    refreshLink.classList.add('has-update');
    refreshLink.style.display = '';
    scheduleBackgroundPoll();
    return;
  }

  refreshLink.textContent = 'refresh now';
  refreshLink.style.display = '';
  fetchBtn.textContent = 'Fetch Unreads';
  lastFetchTime = Date.now();
  updateLastUpdated();
  if (lastUpdatedTimer) clearInterval(lastUpdatedTimer);
  lastUpdatedTimer = setInterval(updateLastUpdated, 1000);
  prioritizeAndRender(data);
}

// ── Replies result handler (called from port message dispatch) ──
function handleRepliesResult(msg) {
  const { requestId, replies } = msg;

  // Check one-shot handlers first (e.g. fetchRepliesAsync in channel thread summarization)
  if (requestId && pendingOneShot[requestId]) {
    pendingOneShot[requestId](msg);
    delete pendingOneShot[requestId];
    return;
  }

  // Populate reaction map for dynamically fetched replies
  for (const r of replies || []) {
    if (r.my_reactions?.length) {
      const el = bodyEl.querySelector(`[data-request-id="${requestId}"]`);
      const ch = el?.dataset.channel;
      if (ch) myReactionsMap[`${ch}:${r.ts}`] = r.my_reactions;
    }
  }

  // Seen-replies toggle (thread items)
  const toggle = bodyEl.querySelector(`.seen-replies-toggle[data-request-id="${requestId}"]`);
  if (toggle) {
    const channel = toggle.dataset.channel;
    const ts = toggle.dataset.ts;
    const container = bodyEl.querySelector(`.seen-replies-container[data-for="${channel}-${ts}"]`);
    if (!container) return;

    const data = lastRenderData;
    const unreadTs = new Set((toggle.dataset.unreadTs || '').split(',').filter(Boolean));
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

  // Thread badge inline expand (channel posts)
  const badge = bodyEl.querySelector(`.msg-thread-badge[data-request-id="${requestId}"]`);
  if (badge) {
    const channel = badge.dataset.channel;
    const ts = badge.dataset.ts;
    const container = findThreadContainer(channel, ts, badge.dataset.containerId);
    if (!container) return;

    const data = lastRenderData;
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
      html += `<div class="msg-row"><div class="msg-content item-reply">${userLink(userName, channel, r.ts, ts)} ${trTextHtml}${trExtras}${msgTime(r.ts, channel, ts)}</div>${msgActions(channel, r.ts)}</div>`;
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
}

// ── Action result handlers (called from port message dispatch) ──
function handleReactResult(msg) {
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

function handleUnreactResult(msg) {
  const btn = (msg.requestId && pendingUnreactButtons[msg.requestId])
    || bodyEl.querySelector('.action-react[data-pending-kind="unreact"]');
  if (msg.requestId) delete pendingUnreactButtons[msg.requestId];
  if (btn) {
    delete btn.dataset.pending;
    delete btn.dataset.pendingKind;
    btn.style.opacity = '';
    if (!msg.ok) btn.classList.add('reacted');
  }
}

function handleCompleteSavedResult(msg) {
  const { requestId, ok } = msg;
  const itemEl = document.querySelector(`.saved-item[data-complete-request-id="${requestId}"]`);
  if (ok) {
    if (itemEl) itemEl.remove();
    const toggle = document.getElementById('saved-items-toggle');
    const list = document.getElementById('saved-items-list');
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

function updateSectionToggleCount(itemEl) {
  if (!itemEl) return;
  const sections = [
    ['when-free-items', 'when-free-toggle', 'Relevant'],
    ['noise-recent-items', 'noise-recent-toggle', 'Recent noise'],
    ['noise-older-items', 'noise-older-toggle', 'Older noise'],
    ['saved-items-list', 'saved-items-toggle', 'Saved'],
  ];
  for (const [itemsId, toggleId, label] of sections) {
    const container = document.getElementById(itemsId);
    if (container && container.contains(itemEl)) {
      const toggle = document.getElementById(toggleId);
      if (!toggle) return;
      const count = container.querySelectorAll('.item:not(.read-done)').length;
      const expanded = container.classList.contains('expanded');
      toggle.textContent = `${label} · ${count} ${expanded ? '↑' : '↓'}`;
      return;
    }
  }
}

function handleMarkReadResult(msg) {
  if (msg.ok) { removeCachedItem(msg.channel, msg.thread_ts); }
  const markAll = bodyEl.querySelector('.mark-all-read[data-pending="true"]');
  if (markAll) {
    delete markAll.dataset.pending;
    if (msg.ok) {
      markAll.textContent = 'undo';
      markAll.classList.add('done');
      const item = markAll.closest('.item');
      if (item) { item.classList.add('read-done'); updateSectionToggleCount(item); }
    } else { markAll.textContent = 'mark read'; }
  }
}

function handleMarkUnreadResult(msg) {
  const markAll = bodyEl.querySelector('.mark-all-read[data-pending="true"]');
  if (markAll) {
    delete markAll.dataset.pending;
    if (msg.ok) {
      markAll.textContent = 'mark read';
      const item = markAll.closest('.item');
      if (item) { item.classList.remove('read-done'); updateSectionToggleCount(item); }
    } else {
      markAll.textContent = 'undo';
      markAll.classList.add('done');
    }
  }
}

function handleMuteThreadResult(msg) {
  const muteBtn = bodyEl.querySelector('.action-mute[data-pending="true"]');
  if (muteBtn) delete muteBtn.dataset.pending;
  if (!msg.ok) console.warn('[fslack] Slack muteThread failed; keeping local mute only');
}

function handleMuteChannelResult(msg) {
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

function handlePostReplyResult(msg) {
  const form = bodyEl.querySelector(`.reply-form[data-request-id="${msg.requestId}"]`);
  if (!form) return;
  if (msg.ok) {
    clearDraft(form._draftChannel, form._draftThreadTs);
    const text = form.querySelector('.reply-input').value;
    const item = form.closest('.item');
    const isMsgLevel = form.previousElementSibling?.classList.contains('msg-row');
    const replyHtml = isMsgLevel
      ? `<div class="msg-row"><div class="msg-content item-reply" style="color:#1d9bd1"><span class="item-user">You:</span> ${escapeHtml(text)}</div></div>`
      : `<div class="item-reply" style="color:#1d9bd1"><span class="item-user">You:</span> ${escapeHtml(text)}</div>`;
    form.insertAdjacentHTML('beforebegin', replyHtml);
    const inp = form.querySelector('.reply-input');
    const btn = form.querySelector('.reply-send');
    inp.value = '';
    inp.disabled = false;
    inp.style.height = 'auto';
    btn.disabled = false;
    btn.textContent = 'Send';
    inp.focus();
    autoMarkItemRead(item, { overrideTs: msg.ts });
  } else {
    const btn = form.querySelector('.reply-send');
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Send'; btn.disabled = false; form.querySelector('.reply-input').disabled = false; }, 2000);
  }
}

function handleUploadAndPostResult(msg) {
  const form = bodyEl.querySelector(`.reply-form[data-request-id="${msg.requestId}"]`);
  if (!form) return;
  if (msg.ok) {
    clearDraft(form._draftChannel, form._draftThreadTs);
    const text = form.querySelector('.reply-input').value;
    const item = form.closest('.item');
    const isMsgLevel = form.previousElementSibling?.classList.contains('msg-row');
    const label = text ? `${escapeHtml(text)} [image]` : '[image]';
    const replyHtml = isMsgLevel
      ? `<div class="msg-row"><div class="msg-content item-reply" style="color:#1d9bd1"><span class="item-user">You:</span> ${label}</div></div>`
      : `<div class="item-reply" style="color:#1d9bd1"><span class="item-user">You:</span> ${label}</div>`;
    form.insertAdjacentHTML('beforebegin', replyHtml);
    const inp = form.querySelector('.reply-input');
    const btn = form.querySelector('.reply-send');
    const preview = form.querySelector('.reply-image-preview');
    inp.value = '';
    inp.disabled = false;
    inp.style.height = 'auto';
    btn.disabled = false;
    btn.textContent = 'Send';
    delete form._pastedImageData;
    delete form._pastedImageMime;
    preview.classList.remove('visible');
    preview.querySelector('.reply-image-thumb').src = '';
    inp.focus();
    autoMarkItemRead(item, { overrideTs: msg.ts });
  } else {
    const btn = form.querySelector('.reply-send');
    btn.textContent = 'Upload failed';
    setTimeout(() => { btn.textContent = 'Send'; btn.disabled = false; form.querySelector('.reply-input').disabled = false; }, 2000);
  }
}

// ── Port message dispatch ──
function handlePortMessage(msg) {
  if (!msg?.type?.startsWith(`${FSLACK}:`)) return;

  if (msg.type === `${FSLACK}:ready`) {
    // If the view is already rendered (reconnect after service worker idle),
    // don't re-render and blow away the user's scroll/expand state.
    if (bodyEl.querySelector('.item')) return;
    if (showFromCache()) return;
    startFetch();
    return;
  }

  if (msg.type === `${FSLACK}:progress`) {
    clearFetchTimeout(); // got a response, fetch is alive — restart timeout
    startFetchTimeout(30000); // allow more time for in-progress fetches
    if (!isBackgroundFetch) {
      bodyEl.innerHTML = `<div id="status">
        <div class="detail">${msg.detail || ''}</div>
      </div>`;
    }
    return;
  }

  if (msg.type === `${FSLACK}:result`) {
    clearFetchTimeout();
    pendingUnreads = msg.data;
    gotUnreads = true;
    if (msg.data) {
      if (msg.data.sidebarSections) sidebarSections = msg.data.sidebarSections;
      const toStore = {};
      if (msg.data.users) {
        mergeCachedUsers(msg.data.users);
        toStore.fslackUsers = cachedUserMap;
      }
      if (msg.data.fullNames) {
        mergeCachedFullNames(msg.data.fullNames);
        toStore.fslackFullNames = cachedFullNameMap;
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
    return;
  }

  if (msg.type === `${FSLACK}:fastResult`) {
    clearFetchTimeout();
    pendingUnreads = msg.data;
    gotUnreads = true;
    if (msg.data) {
      if (msg.data.sidebarSections) sidebarSections = msg.data.sidebarSections;
      const toStore = {};
      if (msg.data.users) {
        mergeCachedUsers(msg.data.users);
        toStore.fslackUsers = cachedUserMap;
      }
      if (msg.data.fullNames) {
        mergeCachedFullNames(msg.data.fullNames);
        toStore.fslackFullNames = cachedFullNameMap;
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
    return;
  }

  if (msg.type === `${FSLACK}:popularResult`) {
    pendingPopular = msg.data || [];
    gotPopular = true;
    tryPrioritize();
    return;
  }

  if (msg.type === `${FSLACK}:savedResult`) {
    pendingSaved = msg.items || [];
    gotSaved = true;
    console.log('[fslack] savedResult received, items:', pendingSaved.length);
    tryPrioritize();
    return;
  }

  if (msg.type === `${FSLACK}:vipResult`) {
    pendingVips = msg.data || [];
    return;
  }

  if (msg.type === `${FSLACK}:newDmsResult`) {
    const { newDms, resolvedUsers } = msg;
    if (newDms && newDms.length > 0 && lastRenderData) {
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
    return;
  }

  if (msg.type === `${FSLACK}:error`) {
    clearFetchTimeout();
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch Unreads';
    if (isBackgroundFetch) {
      // Silently fail — don't wipe the UI
      console.warn('[fslack] Background fetch error:', msg.error);
      isBackgroundFetch = false;
      scheduleBackgroundPoll();
    } else {
      refreshLink.textContent = 'refresh now';
      refreshLink.style.display = '';
      bodyEl.innerHTML = `<div id="status" class="error">${msg.error}</div>`;
    }
    resetFetchState();
    return;
  }

  if (msg.type === `${FSLACK}:repliesResult`) {
    handleRepliesResult(msg);
    return;
  }

  if (msg.type === `${FSLACK}:reactResult`) { handleReactResult(msg); return; }
  if (msg.type === `${FSLACK}:unreactResult`) { handleUnreactResult(msg); return; }
  if (msg.type === `${FSLACK}:saveResult`) { /* DOM already updated on click */ return; }
  if (msg.type === `${FSLACK}:completeSavedResult`) { handleCompleteSavedResult(msg); return; }
  if (msg.type === `${FSLACK}:markReadResult`) { handleMarkReadResult(msg); return; }
  if (msg.type === `${FSLACK}:markUnreadResult`) { handleMarkUnreadResult(msg); return; }
  if (msg.type === `${FSLACK}:muteThreadResult`) { handleMuteThreadResult(msg); return; }
  if (msg.type === `${FSLACK}:muteChannelResult`) { handleMuteChannelResult(msg); return; }
  if (msg.type === `${FSLACK}:postReplyResult`) { handlePostReplyResult(msg); return; }
  if (msg.type === `${FSLACK}:uploadAndPostResult`) { handleUploadAndPostResult(msg); return; }
}

// ── Initialization ──
// Load persisted cache, then connect port
chrome.storage.local.get(['fslackViewCache', 'fslackSavedMsgs', 'fslackLastFetchTs', 'fslackVipSeen', 'fslackMutedThreads', DRAFT_KEY], (result) => {
  _drafts = result[DRAFT_KEY] || {};
  if (result.fslackViewCache && !cachedView) {
    cachedView = result.fslackViewCache;
  }
  persistedFetchTs = result.fslackLastFetchTs || 0;
  savedMsgKeys = new Set(result.fslackSavedMsgs || []);
  vipSeenTimestamps = result.fslackVipSeen || {};
  mutedThreadKeys = new Set(result.fslackMutedThreads || []);

  // Show cached view immediately — panel is usable even without a Slack connection
  const hadCache = showFromCache();
  if (!hadCache) {
    bodyEl.innerHTML = '<div id="status">Waiting for Slack tab...</div>';
  }

  // Connect port to background.js (which relays to content.js → inject.js)
  connectPort();

  // ── Demo mode checkbox ──
  const demoCheckbox = document.getElementById('demo-checkbox');
  if (demoCheckbox) {
    demoCheckbox.addEventListener('change', () => {
      if (demoCheckbox.checked) {
        runDemoAnonymize();
      } else {
        // Re-render with real data
        if (cachedView) {
          renderPrioritized(cachedView.prioritized, cachedView.data, cachedView.popular, false, false, cachedView.saved || [], false, cachedView.ts);
        }
      }
    });
  }
});
