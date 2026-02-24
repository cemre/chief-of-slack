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

  async function resolveUsers(userIds, cachedUsers = {}, onProgress) {
    const users = { ...cachedUsers };
    const unique = [...new Set(userIds)].filter(Boolean);
    const uncached = unique.filter((uid) => !users[uid]);
    // Batch in parallel, max 50
    const batch = uncached.slice(0, 50);
    if (batch.length > 0) {
      let done = 0;
      const results = await Promise.all(
        batch.map(async (uid) => {
          try {
            const data = await slackApi('users.info', { user: uid });
            if (onProgress) onProgress(++done, batch.length);
            return [uid, data.user.real_name || data.user.name];
          } catch {
            if (onProgress) onProgress(++done, batch.length);
            return [uid, uid];
          }
        })
      );
      for (const [id, name] of results) users[id] = name;
    }
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
      // title/text are more meaningful than fallback (which is often "[no preview available]")
      const candidate = att.title || att.text || att.pretext;
      if (candidate) return candidate;
      // structured fields (e.g. Zendesk ticket metadata)
      if (att.fields?.length) return att.fields.map((f) => `${f.title}: ${f.value}`).join(' · ');
      // blocks inside the attachment
      if (att.blocks?.length) {
        for (const block of att.blocks) {
          if (block.text?.text) return block.text.text;
          if (block.elements?.length) {
            for (const el of block.elements) {
              if (el.text) return typeof el.text === 'string' ? el.text : el.text.text || '';
            }
          }
        }
      }
      if (att.fallback && att.fallback !== '[no preview available]') return att.fallback;
    }
    // Top-level blocks
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

  async function fetchUnreads({ cachedUsers = {}, cachedChannels = {}, cachedChannelMeta = {} } = {}) {
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
          bot_id: r.bot_id,
          subtype: r.subtype,
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
    const unreadIms = (counts.ims || []).filter((c) => c.has_unreads);
    const dms = [];
    let dmsDone = 0;
    const dmsTotal = unreadIms.length;
    progress(3, dmsTotal > 0 ? `Fetching DMs... 0/${dmsTotal}` : 'Fetching DMs...');
    for (const im of unreadIms) {
      try {
        const hist = await slackApi('conversations.history', {
          channel: im.id,
          oldest: im.last_read || '0',
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
      progress(3, `Fetching DMs... ${++dmsDone}/${dmsTotal}`);
    }

    progress(3, `Done. ${dms.length} DMs.`);

    // 4. Get unread channel messages — most recent channels first
    progress(4, 'Fetching channel messages...');
    const unreadChannels = (counts.channels || [])
      .filter((c) => c.has_unreads)
      .sort((a, b) => parseFloat(b.latest) - parseFloat(a.latest));

    const channelPosts = [];
    let channelsDone = 0;
    const channelsTotal = unreadChannels.length;
    progress(4, `Fetching channels... 0/${channelsTotal}`);
    await Promise.all(
      unreadChannels.map(async (ch) => {
        try {
          const hist = await slackApi('conversations.history', {
            channel: ch.id,
            oldest: ch.last_read,
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
              reply_users: m.reply_users || [],
            }));
          if (msgs.length > 0) {
            const channelPost = {
              channel_id: ch.id,
              mention_count: ch.mention_count,
              messages: msgs,
              sort_ts: msgs[0]?.ts || '0',
            };
            channelPost._deepAnalysis = true;
            if (msgs.length >= 4) {
              try {
                const deepHist = await slackApi('conversations.history', {
                  channel: ch.id, oldest: ch.last_read, limit: '20',
                });
                const deepMsgs = (deepHist.messages || [])
                  .filter((m) => !m.subtype || m.subtype === 'bot_message')
                  .filter((m) => m.user !== selfId)
                  .map((m) => ({
                    user: m.user,
                    text: extractText(m),
                    ts: m.ts,
                    subtype: m.subtype,
                    bot_id: m.bot_id,
                    reply_count: m.reply_count || 0,
                    reply_users: m.reply_users || [],
                  }));
                const threadRoots = deepMsgs.filter((m) => m.reply_count > 0).slice(0, 5);
                const deepThreads = await Promise.all(
                  threadRoots.map(async (m) => {
                    try {
                      const r = await slackApi('conversations.replies', { channel: ch.id, ts: m.ts, limit: '30' });
                      return {
                        rootTs: m.ts,
                        messages: (r.messages || []).slice(1).map((reply) => ({
                          user: reply.user,
                          text: extractText(reply),
                          ts: reply.ts,
                        })),
                      };
                    } catch { return null; }
                  })
                );
                channelPost.fullMessages = { history: deepMsgs, threads: deepThreads.filter(Boolean) };
              } catch {
                // Deep fetch failed — fullMessages unavailable, summarization falls back to cp.messages
                channelPost._deepFetchFailed = true;
              }
            }
            channelPosts.push(channelPost);
          }
        } catch {
          // skip failed channels
        }
        progress(4, `Fetching channels... ${++channelsDone}/${channelsTotal}`);
      })
    );
    channelPosts.sort((a, b) => parseFloat(b.sort_ts) - parseFloat(a.sort_ts));

    progress(4, `Done. ${channelPosts.length} channels with new posts.`);

    // 5. Collect all user IDs and resolve names
    const allUserIds = [];
    function collectMentions(text) {
      if (!text) return;
      const matches = text.matchAll(/<@(U[A-Z0-9]+)>/g);
      for (const m of matches) allUserIds.push(m[1]);
    }
    threads.forEach((t) => {
      if (t.root_user) allUserIds.push(t.root_user);
      collectMentions(t.root_text);
      t.unread_replies.forEach((r) => {
        if (r.user) allUserIds.push(r.user);
        collectMentions(r.text);
      });
    });
    dms.forEach((dm) => {
      dm.messages.forEach((m) => {
        if (m.user) allUserIds.push(m.user);
        collectMentions(m.text);
      });
    });
    channelPosts.forEach((cp) => {
      cp.messages.forEach((m) => {
        if (m.user) allUserIds.push(m.user);
        collectMentions(m.text);
        (m.reply_users || []).forEach((uid) => allUserIds.push(uid));
      });
      if (cp.fullMessages) {
        cp.fullMessages.history.forEach((m) => {
          if (m.user) allUserIds.push(m.user);
          collectMentions(m.text);
        });
        cp.fullMessages.threads.forEach((t) => {
          t.messages.forEach((r) => { if (r.user) allUserIds.push(r.user); });
        });
      }
    });
    const uniqueUserIds = [...new Set(allUserIds)].filter(Boolean);
    const uncachedUserCount = uniqueUserIds.filter((uid) => !cachedUsers[uid]).length;
    progress(5, `Resolving ${uncachedUserCount} user names (${uniqueUserIds.length - uncachedUserCount} cached)...`);
    const users = await resolveUsers(allUserIds, cachedUsers, (done, total) => {
      progress(5, `Resolving users... ${done}/${total}`);
    });
    progress(5, `Done. ${Object.keys(users).length} users resolved.`);

    // 6. Get channel names for threads + channel posts
    const allChannelIds = [
      ...threads.map((t) => t.channel_id),
      ...channelPosts.map((cp) => cp.channel_id),
    ];
    const channelIds = [...new Set(allChannelIds.filter(Boolean))];
    const channels = { ...cachedChannels };
    const channelMeta = { ...cachedChannelMeta };
    const uncachedChannelIds = channelIds.filter((cid) => !channels[cid]);
    let channelNamesDone = 0;
    const channelNamesTotal = uncachedChannelIds.length;
    progress(6, channelNamesTotal > 0
      ? `Resolving channel names... 0/${channelNamesTotal} (${channelIds.length - channelNamesTotal} cached)`
      : `Resolving channel names (${channelIds.length} cached)...`);
    await Promise.all(
      uncachedChannelIds.map(async (cid) => {
        try {
          const info = await slackApi('conversations.info', { channel: cid });
          channels[cid] = info.channel.name;
          channelMeta[cid] = { isPrivate: info.channel.is_private || info.channel.is_im || info.channel.is_mpim || false };
        } catch {
          channels[cid] = cid;
          channelMeta[cid] = { isPrivate: false };
        }
        progress(6, `Resolving channel names... ${++channelNamesDone}/${channelNamesTotal}`);
      })
    );

    // Build last_read map for VIP message filtering
    const lastRead = {};
    for (const ch of (counts.channels || [])) {
      if (ch.last_read) lastRead[ch.id] = ch.last_read;
    }
    for (const im of (counts.ims || [])) {
      if (im.last_read) lastRead[im.id] = im.last_read;
    }

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
      lastRead,
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

  const VIP_QUERIES = [
    { name: 'JM',     query: 'from:@jm' },
    { name: 'Josh',   query: 'from:@josh' },
    { name: 'Samir',  query: 'from:@samir' },
    { name: 'Ori',    query: 'from:@Ori' },
    { name: 'Leith',  query: 'from:@leith' },
    { name: 'Jane',   query: 'from:@jane' },
    { name: 'Dustin', query: 'from:@dustin' },
    { name: 'Tara',   query: 'from:@Tara' },
  ];

  async function fetchVipActivity() {
    const results = [];
    for (const vip of VIP_QUERIES) {
      try {
        const res = await slackApi('search.messages', {
          query: vip.query,
          sort: 'timestamp',
          count: '10',
        });
        const messages = (res.messages?.matches || []).slice(0, 10).map((m) => ({
          user: m.user || m.username,
          text: m.text || '',
          ts: m.ts,
          channel_id: m.channel?.id,
          channel_name: m.channel?.name,
          permalink: m.permalink,
        }));
        results.push({ name: vip.name, messages });
      } catch {
        results.push({ name: vip.name, messages: [] });
      }
    }
    return results;
  }

  // Listen for requests from content script
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msgType = event.data?.type;

    if (msgType === `${FSLACK}:fetch`) {
      try {
        const cached = {
          cachedUsers: event.data.cachedUsers || {},
          cachedChannels: event.data.cachedChannels || {},
          cachedChannelMeta: event.data.cachedChannelMeta || {},
        };
        const result = await fetchUnreads(cached);
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

    if (msgType === `${FSLACK}:addReaction`) {
      const { channel, ts, emoji, requestId } = event.data;
      try {
        await slackApi('reactions.add', { channel, timestamp: ts, name: emoji });
        window.postMessage({ type: `${FSLACK}:reactResult`, requestId, ok: true }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:reactResult`, requestId, ok: false }, '*');
      }
    }

    if (msgType === `${FSLACK}:saveMessage`) {
      const { channel, ts, requestId } = event.data;
      try {
        await slackApi('stars.add', { channel, timestamp: ts });
        window.postMessage({ type: `${FSLACK}:saveResult`, requestId, ok: true }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:saveResult`, requestId, ok: false }, '*');
      }
    }

    if (msgType === `${FSLACK}:markRead`) {
      const { channel, ts, thread_ts, requestId } = event.data;
      try {
        if (thread_ts) {
          await slackApi('subscriptions.thread.mark', { channel, thread_ts, ts });
        } else {
          await slackApi('conversations.mark', { channel, ts });
        }
        window.postMessage({ type: `${FSLACK}:markReadResult`, requestId, channel, thread_ts, ok: true }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:markReadResult`, requestId, channel, thread_ts, ok: false }, '*');
      }
    }

    if (msgType === `${FSLACK}:markUnread`) {
      const { channel, ts, thread_ts, requestId } = event.data;
      const prevTs = (parseFloat(ts) - 0.000001).toFixed(6);
      try {
        if (thread_ts) {
          await slackApi('subscriptions.thread.mark', { channel, thread_ts, ts: prevTs });
        } else {
          await slackApi('conversations.mark', { channel, ts: prevTs });
        }
        window.postMessage({ type: `${FSLACK}:markUnreadResult`, requestId, ok: true }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:markUnreadResult`, requestId, ok: false }, '*');
      }
    }

    if (msgType === `${FSLACK}:muteChannel`) {
      const { channel, requestId } = event.data;
      try {
        const boot = await slackApi('client.userBoot');
        const current = boot.prefs?.muted_channels || '';
        const muted = current ? current.split(',') : [];
        if (!muted.includes(channel)) muted.push(channel);
        await slackApi('users.prefs.set', {
          name: 'muted_channels',
          value: muted.join(','),
        });
        window.postMessage({ type: `${FSLACK}:muteChannelResult`, requestId, ok: true }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:muteChannelResult`, requestId, ok: false }, '*');
      }
    }

    if (msgType === `${FSLACK}:muteThread`) {
      const { channel, thread_ts, requestId } = event.data;
      try {
        await slackApi('subscriptions.thread.remove', { channel, thread_ts });
        window.postMessage({ type: `${FSLACK}:muteThreadResult`, requestId, ok: true }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:muteThreadResult`, requestId, ok: false }, '*');
      }
    }

    if (msgType === `${FSLACK}:postReply`) {
      const { channel, thread_ts, text, requestId } = event.data;
      try {
        const params = { channel, text };
        if (thread_ts) params.thread_ts = thread_ts;
        await slackApi('chat.postMessage', params);
        window.postMessage({ type: `${FSLACK}:postReplyResult`, requestId, ok: true }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:postReplyResult`, requestId, ok: false }, '*');
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

    if (msgType === `${FSLACK}:fetchVips`) {
      try {
        const vips = await fetchVipActivity();
        window.postMessage({ type: `${FSLACK}:vipResult`, data: vips }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:vipResult`, data: [] }, '*');
      }
    }
  });

  // Signal ready
  window.postMessage({ type: `${FSLACK}:ready` }, '*');
})();
