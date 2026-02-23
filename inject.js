// inject.js — runs in Slack's page context
// Has access to localStorage and same-origin fetch with cookies

(function () {
  // Prevent duplicate injection after extension reload
  if (window.__fslack_injected) return;
  window.__fslack_injected = true;

  const FSLACK = 'fslack';

  function getToken() {
    try {
      const localConfig = JSON.parse(localStorage.getItem('localConfig_v2'));
      return localConfig.teams[localConfig.lastActiveTeamId].token;
    } catch {
      return null;
    }
  }

  async function slackApi(endpoint, params = {}) {
    const token = getToken();
    if (!token) throw new Error('No Slack token found');

    const formData = new FormData();
    formData.append('token', token);
    for (const [k, v] of Object.entries(params)) {
      formData.append(k, v);
    }

    const resp = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    return data;
  }

  async function resolveUsers(userIds) {
    const users = {};
    const unique = [...new Set(userIds)].filter(Boolean);
    // Batch in parallel, max 25
    const batch = unique.slice(0, 25);
    const results = await Promise.all(
      batch.map(async (uid) => {
        try {
          const data = await slackApi('users.info', { user: uid });
          return [uid, data.user.real_name || data.user.name];
        } catch {
          return [uid, uid];
        }
      })
    );
    for (const [id, name] of results) users[id] = name;
    return users;
  }

  async function getSelfId() {
    const boot = await slackApi('client.userBoot');
    return boot.self?.id;
  }

  // Extract text from message, falling back to attachments/blocks
  function extractText(m) {
    if (m.text) return m.text;
    // Bot messages often store content in attachments
    if (m.attachments?.length) {
      const att = m.attachments[0];
      return att.fallback || att.text || att.pretext || '';
    }
    // Or in blocks
    if (m.blocks?.length) {
      for (const block of m.blocks) {
        if (block.text?.text) return block.text.text;
        if (block.elements?.length) {
          for (const el of block.elements) {
            if (el.text) return typeof el.text === 'string' ? el.text : el.text.text || '';
          }
        }
      }
    }
    return '';
  }

  function progress(step, detail) {
    window.postMessage({ type: `${FSLACK}:progress`, step, detail }, '*');
  }

  async function fetchUnreads() {
    // 1. Get counts + self ID
    progress(1, 'Getting counts + user info...');
    const [counts, selfId] = await Promise.all([
      slackApi('client.counts'),
      getSelfId(),
    ]);
    progress(1, `Done. ${(counts.channels||[]).filter(c=>c.has_unreads).length} unread channels, self=${selfId}`);

    // 2. Get unread threads — use unread_replies, filter out self-only
    progress(2, 'Fetching threads...');
    const threadView = await slackApi('subscriptions.thread.getView');
    const threads = (threadView.threads || [])
      .map((t) => {
        const unread = (t.unread_replies || []).map((r) => ({
          user: r.user,
          text: extractText(r),
          ts: r.ts,
        }));
        // Filter: skip if all unread replies are from self
        const othersUnread = unread.filter((r) => r.user !== selfId);
        if (othersUnread.length === 0) return null;

        const lastUnread = othersUnread[othersUnread.length - 1];
        return {
          channel_id: t.root_msg?.channel,
          ts: t.root_msg?.ts,
          root_text: extractText(t.root_msg || {}),
          root_user: t.root_msg?.user,
          reply_count: t.root_msg?.reply_count || 0,
          reply_users: t.root_msg?.reply_users || [],
          unread_replies: othersUnread,
          sort_ts: lastUnread?.ts || t.root_msg?.ts || '0',
        };
      })
      .filter(Boolean)
      .sort((a, b) => parseFloat(b.sort_ts) - parseFloat(a.sort_ts));

    progress(2, `Done. ${threads.length} threads with unread replies from others.`);

    // 3. Get unread DMs — fetch history for each
    progress(3, 'Fetching DMs...');
    const unreadIms = (counts.ims || []).filter((c) => c.has_unreads);
    const dms = [];
    for (const im of unreadIms.slice(0, 10)) {
      try {
        const hist = await slackApi('conversations.history', {
          channel: im.id,
          oldest: im.last_read || '0',
          limit: '10',
        });
        const msgs = (hist.messages || [])
          .filter((m) => m.user !== selfId)
          .map((m) => ({
            user: m.user,
            text: extractText(m),
            ts: m.ts,
            subtype: m.subtype,
            bot_id: m.bot_id,
          }));
        if (msgs.length > 0) {
          dms.push({
            channel_id: im.id,
            messages: msgs,
          });
        }
      } catch {
        // skip failed DMs
      }
    }

    progress(3, `Done. ${dms.length} DMs.`);

    // 4. Get unread channel messages — most recent channels first, cap at 15
    progress(4, 'Fetching channel messages (15 most recent)...');
    const unreadChannels = (counts.channels || [])
      .filter((c) => c.has_unreads)
      .sort((a, b) => parseFloat(b.latest) - parseFloat(a.latest))
      .slice(0, 15);

    const channelPosts = [];
    await Promise.all(
      unreadChannels.map(async (ch) => {
        try {
          const hist = await slackApi('conversations.history', {
            channel: ch.id,
            oldest: ch.last_read,
            limit: '5',
          });
          const msgs = (hist.messages || [])
            .filter((m) => !m.subtype || m.subtype === 'bot_message')
            .filter((m) => m.user !== selfId)
            .map((m) => ({
              user: m.user,
              text: extractText(m),
              ts: m.ts,
              subtype: m.subtype,
              bot_id: m.bot_id,
              reply_count: m.reply_count || 0,
            }));
          if (msgs.length > 0) {
            channelPosts.push({
              channel_id: ch.id,
              mention_count: ch.mention_count,
              messages: msgs,
              sort_ts: msgs[0]?.ts || '0',
            });
          }
        } catch {
          // skip failed channels
        }
      })
    );
    channelPosts.sort((a, b) => parseFloat(b.sort_ts) - parseFloat(a.sort_ts));

    progress(4, `Done. ${channelPosts.length} channels with new posts.`);

    // 5. Collect all user IDs and resolve names
    const allUserIds = [];
    threads.forEach((t) => {
      if (t.root_user) allUserIds.push(t.root_user);
      t.unread_replies.forEach((r) => {
        if (r.user) allUserIds.push(r.user);
      });
    });
    dms.forEach((dm) => {
      dm.messages.forEach((m) => {
        if (m.user) allUserIds.push(m.user);
      });
    });
    channelPosts.forEach((cp) => {
      cp.messages.forEach((m) => {
        if (m.user) allUserIds.push(m.user);
      });
    });
    progress(5, `Resolving ${[...new Set(allUserIds)].length} user names...`);
    const users = await resolveUsers(allUserIds);
    progress(5, `Done. ${Object.keys(users).length} users resolved.`);

    // 6. Get channel names for threads + channel posts
    const allChannelIds = [
      ...threads.map((t) => t.channel_id),
      ...channelPosts.map((cp) => cp.channel_id),
    ];
    const channelIds = [...new Set(allChannelIds.filter(Boolean))];
    progress(6, `Resolving ${channelIds.length} channel names...`);
    const channels = {};
    const channelMeta = {};
    await Promise.all(
      channelIds.map(async (cid) => {
        try {
          const info = await slackApi('conversations.info', { channel: cid });
          channels[cid] = info.channel.name;
          channelMeta[cid] = { isPrivate: info.channel.is_private || info.channel.is_im || info.channel.is_mpim || false };
        } catch {
          channels[cid] = cid;
          channelMeta[cid] = { isPrivate: false };
        }
      })
    );

    return {
      selfId,
      badges: counts.channel_badges,
      threadUnreads: counts.threads,
      threads,
      dms,
      channelPosts,
      users,
      channels,
      channelMeta,
    };
  }

  async function fetchPopularMessages() {
    try {
      const yesterday = Math.floor(Date.now() / 1000) - 86400;
      const results = await slackApi('search.messages', {
        query: `has:reaction after:${yesterday}`,
        sort: 'timestamp',
        count: '20',
      });
      return (results.messages?.matches || [])
        .filter((m) => {
          const reactionCount = (m.reactions || []).reduce((s, r) => s + r.count, 0);
          const replyCount = m.reply_count || 0;
          return reactionCount >= 5 || replyCount >= 5;
        })
        .slice(0, 5)
        .map((m) => ({
          channel_id: m.channel?.id,
          channel_name: m.channel?.name,
          user: m.user || m.username,
          text: m.text || '',
          ts: m.ts,
          reaction_count: (m.reactions || []).reduce((s, r) => s + r.count, 0),
          reply_count: m.reply_count || 0,
          permalink: m.permalink,
        }));
    } catch {
      // search.messages may not be available — gracefully return empty
      return [];
    }
  }

  // Listen for requests from content script
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msgType = event.data?.type;

    if (msgType === `${FSLACK}:fetch`) {
      try {
        const result = await fetchUnreads();
        window.postMessage({ type: `${FSLACK}:result`, data: result }, '*');
      } catch (err) {
        window.postMessage(
          { type: `${FSLACK}:error`, error: err.message },
          '*'
        );
      }
    }

    if (msgType === `${FSLACK}:fetchReplies`) {
      const { channel, ts, requestId } = event.data;
      try {
        const data = await slackApi('conversations.replies', { channel, ts, limit: '50' });
        const replies = (data.messages || []).slice(1).map((m) => ({
          user: m.user,
          text: extractText(m),
          ts: m.ts,
        }));
        window.postMessage({ type: `${FSLACK}:repliesResult`, requestId, replies }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:repliesResult`, requestId, replies: [] }, '*');
      }
    }

    if (msgType === `${FSLACK}:fetchPopular`) {
      try {
        const popular = await fetchPopularMessages();
        window.postMessage({ type: `${FSLACK}:popularResult`, data: popular }, '*');
      } catch (err) {
        window.postMessage({ type: `${FSLACK}:popularResult`, data: [] }, '*');
      }
    }
  });

  // Signal ready
  window.postMessage({ type: `${FSLACK}:ready` }, '*');
})();
