// content.js — overlay UI on top of Slack + bridge to inject.js + LLM prioritization

const FSLACK = 'fslack';

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
<style>
  :host { all: initial; }
  #overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 999999;
    background: #1a1d21;
    color: #d1d2d3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    overflow-y: auto;
  }
  #overlay.visible { display: flex; flex-direction: column; }
  header {
    padding: 16px 24px;
    background: #1a1d21;
    border-bottom: 1px solid #363940;
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    top: 0;
    z-index: 1;
  }
  header h1 { font-size: 18px; font-weight: 800; color: #fff; margin: 0; }
  .header-actions { display: flex; gap: 8px; }
  button {
    background: #007a5a;
    color: #fff;
    border: none;
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: #148567; }
  button:disabled { opacity: 0.5; cursor: wait; }
  button.secondary {
    background: transparent;
    border: 1px solid #565856;
    color: #d1d2d3;
  }
  button.secondary:hover { background: #363940; }
  #body { flex: 1; padding: 0; }
  section { padding: 8px 0; }
  section h2 {
    padding: 8px 24px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    color: #ababad;
    letter-spacing: 0.5px;
    margin: 0;
  }
  .item {
    display: flex;
    padding: 10px 24px;
    border-bottom: 1px solid #2c2d30;
    cursor: default;
    gap: 16px;
  }
  .item:hover { background: #222529; }
  .item-left {
    flex: 0 0 140px;
    min-width: 0;
  }
  .item-channel {
    font-size: 13px;
    color: #ababad;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
  }
  .item-time { font-size: 11px; color: #616061; display: block; margin-top: 2px; }
  .item-mention {
    font-size: 11px;
    font-weight: 700;
    color: #e01e5a;
    margin-top: 2px;
  }
  .item-right {
    flex: 1;
    min-width: 0;
  }
  .item-user { font-weight: 700; color: #fff; }
  .item-text { color: #d1d2d3; line-height: 1.46; word-break: break-word; margin-top: 2px; }
  .item-text:first-child { margin-top: 0; }
  .item-reply-count {
    margin-top: 6px;
    font-size: 12px;
    color: #1d9bd1;
    font-weight: 600;
  }
  .item-reply {
    margin-top: 6px;
    padding-left: 12px;
    border-left: 2px solid #363940;
    color: #ababad;
    line-height: 1.46;
    word-break: break-word;
  }
  .item-reply .item-user { color: #d1d2d3; }
  #status {
    padding: 40px 24px;
    text-align: center;
    color: #ababad;
  }
  #status .step { font-size: 16px; color: #fff; }
  #status .detail { margin-top: 6px; font-size: 13px; color: #ababad; }
  .error { color: #e01e5a; }

  /* Priority section styles */
  .priority-section h2.act-now { color: #e01e5a; }
  .priority-section h2.priority-header { color: #e8912d; }
  .priority-section h2.when-free { color: #ecb22e; }
  .priority-section h2.interesting { color: #1d9bd1; }
  .priority-section h2.noise-header { color: #616061; }
  .item.act-now { border-left: 3px solid #e01e5a; }
  .item.priority-item { border-left: 3px solid #e8912d; }
  .item.when-free { border-left: 3px solid #ecb22e; }
  .item.interesting { border-left: 3px solid #1d9bd1; }
  .item.noise-item { border-left: 3px solid #616061; opacity: 0.7; }
  .noise-items { display: none; }
  .noise-items.expanded { display: block; }
  .section-toggle {
    padding: 6px 24px;
    font-size: 12px;
    color: #616061;
    cursor: pointer;
    user-select: none;
  }
  .section-toggle:hover { color: #ababad; }
  .priority-badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 8px;
    vertical-align: middle;
  }
  .priority-badge.act-now { background: #e01e5a; color: #fff; }
  .priority-badge.when-free { background: #ecb22e; color: #1a1d21; }
  .engagement-stats {
    font-size: 11px;
    color: #616061;
    margin-top: 4px;
  }
  .api-key-form {
    padding: 40px 24px;
    text-align: center;
  }
  .api-key-form input {
    width: 360px;
    padding: 8px 12px;
    border: 1px solid #565856;
    border-radius: 6px;
    background: #222529;
    color: #fff;
    font-size: 14px;
    margin-bottom: 12px;
    font-family: inherit;
  }
  .api-key-form input:focus {
    outline: none;
    border-color: #1d9bd1;
  }
  .see-more, .see-less {
    color: #1d9bd1;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }
  .see-more:hover, .see-less:hover { text-decoration: underline; }
  .seen-replies-toggle {
    margin-top: 6px;
    font-size: 12px;
    color: #616061;
    cursor: pointer;
    user-select: none;
  }
  .seen-replies-toggle:hover { color: #ababad; }
  .seen-replies-toggle.loading { color: #565856; cursor: wait; }
  .seen-replies-container .item-reply { color: #717274; }
  .warning-banner {
    padding: 8px 24px;
    background: #2c2d30;
    color: #ecb22e;
    font-size: 12px;
    border-bottom: 1px solid #363940;
  }
</style>
<div id="overlay">
  <header>
    <h1>FSlack</h1>
    <div class="header-actions">
      <button id="fetch-btn">Fetch Unreads</button>
      <button id="close-btn" class="secondary">Back to Slack</button>
    </div>
  </header>
  <div id="body">
    <div id="status">Press "Fetch Unreads" to scan.</div>
  </div>
</div>
`;

const overlay = shadow.getElementById('overlay');
const bodyEl = shadow.getElementById('body');
const fetchBtn = shadow.getElementById('fetch-btn');
const closeBtn = shadow.getElementById('close-btn');

// ── Toggle overlay ──
let visible = false;
function show() { visible = true; overlay.classList.add('visible'); }
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

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let truncateId = 0;

function cleanSlackText(text, users) {
  if (!text) return '';
  text = text.replace(/<@(U[A-Z0-9]+)>/g, (_, id) => `@${users?.[id] || id}`);
  text = text.replace(/<([^|>]+)\|([^>]+)>/g, (_, _url, label) => label);
  text = text.replace(/<([^>]+)>/g, (_, url) => url);
  return text;
}

function truncate(text, max = 200, users) {
  const cleaned = cleanSlackText(text, users);
  const escaped = escapeHtml(cleaned);
  if (cleaned.length <= max) return escaped;
  const id = `trunc_${++truncateId}`;
  const short = escapeHtml(cleaned.slice(0, max));
  const full = escaped.replace(/\n/g, '<br>');
  return `<span id="${id}-short">${short}... <span class="see-more" data-trunc-id="${id}">See more</span></span><span id="${id}-full" style="display:none">${full} <span class="see-less" data-trunc-id="${id}">See less</span></span>`;
}

function plainTruncate(text, max = 150, users) {
  const cleaned = cleanSlackText(text, users);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + '...';
}

function uname(uid, users) {
  if (!uid) return 'bot';
  return users[uid] || uid;
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

  let html = `<div class="item ${cssClass}">
    <div class="item-left">
      <span class="item-channel">${channelLabel}</span>
      <span class="item-time">${formatTime(lastUnread?.ts || t.ts)}</span>
    </div>
    <div class="item-right">
      <div class="item-text"><span class="item-user">${uname(t.root_user, data.users)}:</span> ${truncate(t.root_text, 200, data.users)}</div>`;
  if (seenCount > 0) {
    const unreadTs = unread.map((r) => r.ts).join(',');
    html += `<div class="seen-replies-toggle" data-channel="${t.channel_id}" data-ts="${t.ts}" data-unread-ts="${unreadTs}">${seenCount} earlier ${seenCount === 1 ? 'reply' : 'replies'}</div>`;
    html += `<div class="seen-replies-container" data-for="${t.channel_id}-${t.ts}"></div>`;
  }
  for (const r of unread) {
    html += `<div class="item-reply"><span class="item-user">${uname(r.user, data.users)}:</span> ${truncate(r.text, 1000, data.users)}</div>`;
  }
  html += '</div></div>';
  return html;
}

function dmPartnerName(dm, data) {
  // Find the most common non-bot user in the DM — that's who it's with
  for (const m of dm.messages) {
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
      <span class="item-channel">${escapeHtml(partner)}</span>
      <span class="item-time">${formatTime(latest.ts)}</span>
    </div>
    <div class="item-right">`;
  for (const m of dm.messages.slice(0, 5)) {
    html += `<div class="item-text">${truncate(m.text, 1000, data.users)}</div>`;
  }
  if (dm.messages.length > 5) {
    html += `<div class="item-reply-count">+${dm.messages.length - 5} more</div>`;
  }
  html += '</div></div>';
  return html;
}

function renderChannelItem(cp, data, cssClass) {
  const ch = data.channels[cp.channel_id] || cp.channel_id;
  const latest = cp.messages[0];
  let html = `<div class="item ${cssClass}">
    <div class="item-left">
      <span class="item-channel">#${ch}</span>
      <span class="item-time">${formatTime(latest?.ts)}</span>`;
  if (cp.mention_count > 0) {
    html += `<div class="item-mention">@${cp.mention_count}x</div>`;
  }
  html += `</div>
    <div class="item-right">`;
  for (const m of cp.messages.slice(0, 5)) {
    html += `<div class="item-text"><span class="item-user">${m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users)}:</span> ${truncate(m.text, 200, data.users)}</div>`;
  }
  if (cp.messages.length > 5) {
    html += `<div class="item-reply-count">+${cp.messages.length - 5} more</div>`;
  }
  html += '</div></div>';
  return html;
}

function renderAnyItem(item, data, cssClass) {
  if (item._type === 'thread') return renderThreadItem(item, data, cssClass);
  if (item._type === 'dm') return renderDmItem(item, data, cssClass);
  if (item._type === 'channel') return renderChannelItem(item, data, cssClass);
  return '';
}

// ── Deterministic pre-filters ──
// Only hard-drops and bot→noise. Everything else goes to LLM for classification + ranking.
function applyPreFilters(data) {
  const { selfId, threads, dms, channelPosts, channels } = data;
  const meta = data.channelMeta || {};

  const noise = [];
  const forLlm = { threads: [], dms: [], channelPosts: [] };

  // Threads: annotate metadata for LLM
  for (const t of threads) {
    t._userReplied = (t.reply_users || []).includes(selfId);
    t._type = 'thread';
    t._isDmThread = t.channel_id?.startsWith('D') || meta[t.channel_id]?.isPrivate || false;

    const allTexts = [t.root_text, ...(t.unread_replies || []).map((r) => r.text)].join(' ');
    const textsLower = allTexts.toLowerCase();
    t._isMentioned = allTexts.includes(`<@${selfId}>`) || allTexts.includes(`@${selfId}`)
      || textsLower.includes('@gem') || textsLower.includes('hey gem') || textsLower.includes('hi gem')
      || textsLower.includes('hey cemre') || textsLower.includes('hi cemre');

    forLlm.threads.push(t);
  }

  // Channel posts
  for (const cp of channelPosts) {
    cp._type = 'channel';
    const chName = channels[cp.channel_id] || '';

    // #help-dia without @mention → hard drop (no LLM needed)
    if (chName === 'help-dia' && (cp.mention_count || 0) === 0) continue;

    // All-bot messages → noise (but check for active threads first)
    if (cp.messages.every((m) => m.bot_id || m.subtype === 'bot_message')) {
      if (chName.includes('dia-reporter') || chName.includes('reporter-feedback')) {
        const hasActiveThread = cp.messages.some((m) => (m.reply_count || 0) >= 3);
        if (hasActiveThread) { forLlm.channelPosts.push(cp); continue; }
      }
      noise.push(cp);
      continue;
    }

    forLlm.channelPosts.push(cp);
  }

  // DMs
  for (const dm of dms) {
    dm._type = 'dm';
    if (dm.messages.every((m) => m.bot_id || m.subtype === 'bot_message')) {
      noise.push(dm);
      continue;
    }
    forLlm.dms.push(dm);
  }

  return { noise, forLlm };
}

// ── Serialize items for LLM ──
function serializeForLlm(forLlm, data) {
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
      rootText: plainTruncate(t.root_text, 150, data.users),
      userReplied: t._userReplied,
      newReplies: t.unread_replies.map((r) => ({
        user: uname(r.user, data.users),
        text: plainTruncate(r.text, 150, data.users),
      })),
    });
  }

  for (let i = 0; i < forLlm.dms.length; i++) {
    const dm = forLlm.dms[i];
    items.push({
      id: `dm_${i}`,
      type: 'dm',
      messages: dm.messages.map((m) => ({
        user: m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users),
        text: plainTruncate(m.text, 150, data.users),
      })),
    });
  }

  for (let i = 0; i < forLlm.channelPosts.length; i++) {
    const cp = forLlm.channelPosts[i];
    const ch = data.channels[cp.channel_id] || cp.channel_id;
    items.push({
      id: `channel_${i}`,
      type: 'channel',
      channel: ch,
      isPrivate: meta[cp.channel_id]?.isPrivate || false,
      mentionCount: cp.mention_count || 0,
      messages: cp.messages.map((m) => ({
        user: m.subtype === 'bot_message' ? 'Bot' : uname(m.user, data.users),
        text: plainTruncate(m.text, 150, data.users),
      })),
    });
  }

  return items;
}

// ── Map LLM priorities back to original data objects ──
function mapPriorities(priorities, forLlm, deterministicNoise, data) {
  const actNow = [];
  const priority = [];
  const whenFree = [];
  const noise = [...deterministicNoise];
  const meta = data?.channelMeta || {};

  function place(item, cat) {
    const isPrivate = meta[item.channel_id]?.isPrivate || item._type === 'dm' || item._isDmThread;
    const userReplied = item._userReplied || false;

    if (cat === 'act_now') { actNow.push(item); return; }
    if (cat === 'priority') { priority.push(item); return; }

    if (userReplied && (cat === 'noise' || cat === 'drop')) { whenFree.push(item); return; }
    if (cat === 'drop' && !isPrivate) return;
    if (cat === 'noise' && isPrivate) { whenFree.push(item); return; }
    if (cat === 'when_free') { whenFree.push(item); return; }
    if (cat === 'drop') { whenFree.push(item); return; }
    noise.push(item);
  }

  forLlm.threads.forEach((t, i) => place(t, priorities[`thread_${i}`]));
  forLlm.dms.forEach((dm, i) => place(dm, priorities[`dm_${i}`]));
  forLlm.channelPosts.forEach((cp, i) => place(cp, priorities[`channel_${i}`]));

  return { actNow, priority, whenFree, noise };
}

// ── Render prioritized view ──
function renderPrioritized(prioritized, data, popular, loading = false) {
  const { actNow, priority, whenFree, noise } = prioritized;
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
          <span class="item-channel">#${p.channel_name || p.channel_id}</span>
          <span class="item-time">${formatTime(p.ts)}</span>
          <div class="engagement-stats">${p.reaction_count} reactions · ${p.reply_count} replies</div>
        </div>
        <div class="item-right">
          <div class="item-text">${truncate(p.text, 200, data.users)}</div>
        </div>
      </div>`;
    }
    html += '</section>';
  }

  // Loading indicator while LLM is working
  if (loading) {
    html += '<div id="status"><div class="detail">Analyzing remaining messages with AI...</div></div>';
  }

  // Noise (collapsed by default) — only show when not loading
  if (!loading && noise.length > 0) {
    html += '<section class="priority-section">';
    html += `<div class="section-toggle" id="noise-toggle">Show ${noise.length} noise item${noise.length === 1 ? '' : 's'}</div>`;
    html += '<div class="noise-items" id="noise-items">';
    for (const item of noise) html += renderAnyItem(item, data, 'noise-item');
    html += '</div></section>';
  }

  // All clear
  if (!loading && actNow.length === 0 && (!priority || priority.length === 0) && whenFree.length === 0 && (!popular || popular.length === 0) && noise.length === 0) {
    html += '<div id="status">All clear — nothing needs your attention.</div>';
  }

  bodyEl.innerHTML = html;
  lastRenderData = data;

  // Wire up noise toggle
  const noiseToggle = shadow.getElementById('noise-toggle');
  const noiseItems = shadow.getElementById('noise-items');
  if (noiseToggle && noiseItems) {
    noiseToggle.addEventListener('click', () => {
      const expanded = noiseItems.classList.toggle('expanded');
      noiseToggle.textContent = expanded
        ? `Hide ${noise.length} noise item${noise.length === 1 ? '' : 's'}`
        : `Show ${noise.length} noise item${noise.length === 1 ? '' : 's'}`;
    });
  }
}

// ── Seen replies lazy loading ──
let lastRenderData = null;
let replyRequestId = 0;

bodyEl.addEventListener('click', (e) => {
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

  // Seen replies lazy load
  const toggle = e.target.closest('.seen-replies-toggle');
  if (!toggle || toggle.classList.contains('loading') || toggle.classList.contains('expanded')) return;

  const channel = toggle.dataset.channel;
  const ts = toggle.dataset.ts;
  if (!channel || !ts) return;

  toggle.classList.add('loading');
  toggle.textContent = 'Loading...';

  const reqId = `reply_${++replyRequestId}`;
  toggle.dataset.requestId = reqId;
  window.postMessage({ type: `${FSLACK}:fetchReplies`, channel, ts, requestId: reqId }, '*');
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== `${FSLACK}:repliesResult`) return;

  const { requestId, replies } = event.data;
  const toggle = bodyEl.querySelector(`.seen-replies-toggle[data-request-id="${requestId}"]`);
  if (!toggle) return;

  const channel = toggle.dataset.channel;
  const ts = toggle.dataset.ts;
  const container = bodyEl.querySelector(`.seen-replies-container[data-for="${channel}-${ts}"]`);
  if (!container) return;

  const data = lastRenderData;
  const unreadTs = new Set((toggle.dataset.unreadTs || '').split(',').filter(Boolean));

  // Show only seen replies (exclude unread ones already displayed below)
  const seenReplies = replies.filter((r) => !unreadTs.has(r.ts));

  let html = '';
  for (const r of seenReplies) {
    const userName = data ? uname(r.user, data.users) : r.user;
    html += `<div class="item-reply">
      <span class="item-user">${userName}:</span>
      ${truncate(r.text, 200, data?.users)}
    </div>`;
  }
  container.innerHTML = html;

  toggle.classList.remove('loading');
  toggle.classList.add('expanded');
  const count = seenReplies.length;
  toggle.textContent = count > 0
    ? `Hide ${count} earlier ${count === 1 ? 'reply' : 'replies'}`
    : 'No earlier replies';

  // Toggle collapse on re-click
  toggle.addEventListener('click', function collapseHandler() {
    const isVisible = container.style.display !== 'none';
    container.style.display = isVisible ? 'none' : '';
    toggle.textContent = isVisible
      ? `${count} earlier ${count === 1 ? 'reply' : 'replies'}`
      : `Hide ${count} earlier ${count === 1 ? 'reply' : 'replies'}`;
  });
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

// ── Main orchestration: pre-filter → LLM → render ──
let pendingPopular = null;

function prioritizeAndRender(data) {
  const preFiltered = applyPreFilters(data);
  const { forLlm } = preFiltered;
  const totalItems = forLlm.threads.length + forLlm.dms.length + forLlm.channelPosts.length;

  if (totalItems === 0) {
    // Only noise/dropped — render what we have
    renderPrioritized({ actNow: [], priority: [], whenFree: [], noise: preFiltered.noise }, data, pendingPopular);
    return;
  }

  // Show loading while LLM works
  bodyEl.innerHTML = '<div id="status"><div class="detail">Analyzing messages with AI...</div></div>';

  const llmItems = serializeForLlm(forLlm, data);
  const selfName = data.users?.[data.selfId] || '';

  chrome.runtime.sendMessage(
    { type: `${FSLACK}:prioritize`, data: llmItems, selfName },
    (response) => {
      if (chrome.runtime.lastError) {
        render(data);
        return;
      }

      if (response?.error === 'no_api_key') {
        showApiKeyPrompt(data);
        return;
      }

      if (response?.error) {
        console.warn('FSlack prioritization error:', response.error);
        render(data);
        const banner = document.createElement('div');
        banner.className = 'warning-banner';
        banner.textContent = `Prioritization unavailable: ${response.error}`;
        bodyEl.insertBefore(banner, bodyEl.firstChild);
        return;
      }

      const prioritized = mapPriorities(response.priorities, forLlm, preFiltered.noise, data);
      renderPrioritized(prioritized, data, pendingPopular);
    }
  );
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
          <span class="item-channel">#${ch}</span>
          <span class="item-time">${formatTime(lastUnread?.ts || t.ts)}</span>
        </div>
        <div class="item-right">
          <div class="item-text"><span class="item-user">${uname(t.root_user, users)}:</span> ${truncate(t.root_text, 200, users)}</div>`;
      if (t.reply_count > 0) {
        html += `<div class="item-reply-count">${t.reply_count} ${t.reply_count === 1 ? 'reply' : 'replies'} · ${unread.length} new</div>`;
      }
      for (const r of unread) {
        html += `<div class="item-reply"><span class="item-user">${uname(r.user, users)}:</span> ${truncate(r.text, 1000, users)}</div>`;
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
          <span class="item-channel">DM</span>
          <span class="item-time">${formatTime(lastMsg.ts)}</span>
        </div>
        <div class="item-right">
          <div class="item-text"><span class="item-user">${lastMsg.subtype === 'bot_message' ? 'Bot' : uname(lastMsg.user, users)}:</span> ${truncate(lastMsg.text, 1000, users)}</div>
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
          <span class="item-channel">#${ch}</span>
          <span class="item-time">${formatTime(latest?.ts)}</span>`;
      if (cp.mention_count > 0) {
        html += `<div class="item-mention">@${cp.mention_count}x</div>`;
      }
      html += `</div>
        <div class="item-right">`;
      for (const m of cp.messages.slice(0, 3)) {
        html += `<div class="item-text"><span class="item-user">${m.subtype === 'bot_message' ? 'Bot' : uname(m.user, users)}:</span> ${truncate(m.text, 200, users)}</div>`;
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
}

// ── Fetch button: fire both unreads + popular in parallel ──
fetchBtn.addEventListener('click', () => {
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Fetching...';
  bodyEl.innerHTML = '<div id="status">Starting fetch...</div>';
  pendingPopular = null;
  window.postMessage({ type: `${FSLACK}:fetch` }, '*');
  window.postMessage({ type: `${FSLACK}:fetchPopular` }, '*');
});

// ── Listen for messages from inject.js ──
let pendingUnreads = null;
let gotUnreads = false;
let gotPopular = false;

function resetFetchState() {
  pendingUnreads = null;
  pendingPopular = null;
  gotUnreads = false;
  gotPopular = false;
}

function tryPrioritize() {
  if (!gotUnreads) return;
  // Don't wait for popular — it may fail or be slow
  // But give it a short window if unreads arrive first
  if (!gotPopular) {
    setTimeout(() => {
      if (!gotPopular) {
        gotPopular = true;
        pendingPopular = [];
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
  prioritizeAndRender(data);
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data || {};

  if (msg.type === `${FSLACK}:progress`) {
    bodyEl.innerHTML = `<div id="status">
      <div class="step">Step ${msg.step}/6</div>
      <div class="detail">${msg.detail || ''}</div>
    </div>`;
  }

  if (msg.type === `${FSLACK}:result`) {
    pendingUnreads = msg.data;
    gotUnreads = true;
    tryPrioritize();
  }

  if (msg.type === `${FSLACK}:popularResult`) {
    pendingPopular = msg.data || [];
    gotPopular = true;
    tryPrioritize();
  }

  if (msg.type === `${FSLACK}:error`) {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch Unreads';
    bodyEl.innerHTML = `<div id="status" class="error">${msg.error}</div>`;
    resetFetchState();
  }
});

// Auto-show on load
show();
