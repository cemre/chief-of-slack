// popup.js — renders unread data in the popup

const FSLACK = 'fslack';
const content = document.getElementById('content');
const fetchBtn = document.getElementById('fetch-btn');

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(parseFloat(ts) * 1000);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

function truncate(text, max = 150) {
  if (!text) return '';
  // Replace user mentions <@U...> with placeholder
  text = text.replace(/<@(U[A-Z0-9]+)>/g, (_, id) => `@${id}`);
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function userName(uid, users) {
  if (!uid) return 'bot';
  return users[uid] || uid;
}

function render(data) {
  const { badges, threadUnreads, threads, dms, channelPosts, users, channels } = data;

  let html = '';

  // Badges bar
  html += `<div class="badges">
    <div class="badge">Threads <span class="count ${threadUnreads?.mention_count ? '' : 'zero'}">${threadUnreads?.mention_count || 0}</span></div>
    <div class="badge">DMs <span class="count ${badges?.dms ? '' : 'zero'}">${badges?.dms || 0}</span></div>
    <div class="badge">Channels <span class="count ${badges?.channels ? '' : 'zero'}">${badges?.channels || 0}</span></div>
  </div>`;

  // Threads
  if (threads && threads.length > 0) {
    html += '<section><h2>Unread Threads</h2>';
    for (const t of threads) {
      const ch = channels[t.channel_id] || t.channel_id;
      const unread = t.unread_replies || [];
      const lastUnread = unread[unread.length - 1];
      html += `<div class="item">
        <div class="item-header">
          <span class="item-channel">#${ch}</span>
          <span class="item-time">${formatTime(lastUnread?.ts || t.ts)}</span>
        </div>
        <div class="item-text">
          <span class="item-user">${userName(t.root_user, users)}:</span>
          ${truncate(t.root_text)}
        </div>`;
      if (t.reply_count > 0) {
        html += `<div class="item-reply-count">${t.reply_count} ${t.reply_count === 1 ? 'reply' : 'replies'} · ${unread.length} new</div>`;
      }
      for (const r of unread) {
        html += `<div class="item-reply">
          <span class="item-user">${userName(r.user, users)}:</span>
          ${truncate(r.text)}
        </div>`;
      }
      html += `</div>`;
    }
    html += '</section>';
  }

  // DMs
  if (dms && dms.length > 0) {
    html += '<section><h2>Unread DMs</h2>';
    for (const dm of dms) {
      const lastMsg = dm.messages[0]; // most recent
      if (!lastMsg) continue;
      html += `<div class="item">
        <div class="item-header">
          <span class="item-channel">DM</span>
          <span class="item-time">${formatTime(lastMsg.ts)}</span>
        </div>
        <div class="item-text">
          <span class="item-user">${lastMsg.subtype === 'bot_message' ? 'Bot' : userName(lastMsg.user, users)}:</span>
          ${truncate(lastMsg.text)}
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
        <div class="item-header">
          <span class="item-channel">#${ch}</span>
          <span class="item-time">${formatTime(latest?.ts)}</span>
        </div>`;
      if (cp.mention_count > 0) {
        html += `<div class="item-mention">@mentioned ${cp.mention_count}x</div>`;
      }
      for (const m of cp.messages.slice(0, 3)) {
        html += `<div class="item-text">
          <span class="item-user">${m.subtype === 'bot_message' ? 'Bot' : userName(m.user, users)}:</span>
          ${truncate(m.text)}
        </div>`;
      }
      if (cp.messages.length > 3) {
        html += `<div class="item-reply-count">+${cp.messages.length - 3} more</div>`;
      }
      html += `</div>`;
    }
    html += '</section>';
  }

  if ((!threads || threads.length === 0) && (!dms || dms.length === 0) && (!channelPosts || channelPosts.length === 0)) {
    html += '<div id="status">All clear — nothing needs your attention.</div>';
  }

  content.innerHTML = html;
}

// Listen for results from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === `${FSLACK}:progress`) {
    content.innerHTML = `<div id="status">
      <div>Step ${msg.step}/6</div>
      <div style="margin-top:4px;color:#616061;font-size:12px">${msg.detail || ''}</div>
    </div>`;
  }
  if (msg.type === `${FSLACK}:result`) {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch Unreads';
    render(msg.data);
  }
  if (msg.type === `${FSLACK}:error`) {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch Unreads';
    content.innerHTML = `<div id="status" class="error">${msg.error}</div>`;
  }
});

fetchBtn.addEventListener('click', () => {
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Fetching...';
  content.innerHTML = '<div id="status">Fetching unreads from Slack...</div>';

  // First check if background already has data
  chrome.runtime.sendMessage({ type: `${FSLACK}:fetch` });
});

// On open, check for cached data or in-flight progress
chrome.runtime.sendMessage({ type: `${FSLACK}:getData` }, (response) => {
  if (response?.data) {
    render(response.data);
  } else if (response?.progress) {
    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Fetching...';
    content.innerHTML = `<div id="status">
      <div>Step ${response.progress.step}/6</div>
      <div style="margin-top:4px;color:#616061;font-size:12px">${response.progress.detail || ''}</div>
    </div>`;
  } else if (response?.error) {
    content.innerHTML = `<div id="status" class="error">${response.error}</div>`;
  }
});
