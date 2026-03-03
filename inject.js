// inject.js — runs in Slack's page context
// Has access to localStorage and same-origin fetch with cookies

(function () {
  // Prevent duplicate injection after extension reload
  if (window.__fslack_injected) return;
  window.__fslack_injected = true;

  const FSLACK = 'fslack';
  let _selfId = null; // cached after first fetch for lightweight polls

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

  async function resolveUsers(userIds, cachedUsers = {}, cachedMentionHints = {}, onProgress) {
    const users = { ...cachedUsers };
    const mentionHints = { ...cachedMentionHints };
    const unique = [...new Set(userIds)].filter(Boolean);
    const idsToFetch = unique.filter((uid) => !users[uid] || !mentionHints[uid]);
    if (idsToFetch.length === 0) return { users, mentionHints };

    let done = 0;
    const total = idsToFetch.length;
    for (let i = 0; i < idsToFetch.length; i += 50) {
      const batch = idsToFetch.slice(i, i + 50);
      const results = await Promise.all(
        batch.map(async (uid) => {
          try {
            const data = await slackApi('users.info', { user: uid });
            return [uid, data.user];
          } catch {
            return [uid, null];
          } finally {
            if (onProgress) onProgress(++done, total);
          }
        })
      );
      for (const [id, user] of results) {
        if (user) {
          users[id] = user.real_name || user.profile?.real_name_normalized || user.name || id;
          mentionHints[id] = buildMentionHintsForUser(user);
        } else {
          if (!users[id]) users[id] = id;
          if (!mentionHints[id]) mentionHints[id] = [];
        }
      }
    }
    return { users, mentionHints };
  }

  function buildMentionHintsForUser(user = {}) {
    const hints = [];
    const profile = user.profile || {};
    const add = (value) => {
      if (typeof value === 'string' && value.trim()) hints.push(value.trim());
    };
    add(profile.display_name_normalized);
    add(profile.display_name);
    add(user.name);
    add(profile.real_name_normalized);
    add(user.real_name);
    add(profile.first_name);
    add(profile.last_name);
    return [...new Set(hints)];
  }

  async function getSelfIdAndMuted() {
    const boot = await slackApi('client.userBoot');
    const muted = new Set();
    // New-style: all_notifications_prefs.channels[id].muted (Slack moved away from muted_channels)
    try {
      const notifPrefs = JSON.parse(boot.prefs?.all_notifications_prefs || '{}');
      for (const [id, prefs] of Object.entries(notifPrefs.channels || {})) {
        if (prefs.muted === true) muted.add(id);
      }
    } catch {}
    // Legacy fallback: comma-separated muted_channels pref
    for (const id of (boot.prefs?.muted_channels || '').split(',')) {
      if (id) muted.add(id);
    }
    return { selfId: boot.self?.id, muted };
  }

  async function fetchEmojiList() {
    const data = await slackApi('emoji.list');
    return data.emoji || {};
  }

  const NOISE_SUBTYPES = new Set([
    'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
    'channel_name', 'channel_archive', 'channel_unarchive',
    'pinned_item', 'unpinned_item', 'group_join', 'group_leave',
  ]);

  // Extract text from message, falling back to attachments/blocks
  // Extract forwarded/shared message info as a separate object
  function extractFwd(m) {
    if (!m.attachments?.length) return null;
    const att = m.attachments[0];
    if (!(att.is_msg_unfurl || att.is_share)) return null;
    const text = att.text || att.fallback || '';
    if (!text) return null;
    const author = att.author_subname || att.author_name || '';
    return { author, text };
  }

  function extractText(m) {
    // For forwarded/shared messages, return only the outer text (fwd content handled separately)
    if (m.attachments?.length) {
      const att = m.attachments[0];
      if (att.is_msg_unfurl || att.is_share) {
        const shared = att.text || att.fallback || '';
        if (shared) return m.text || '';
      }
    }
    if (m.text) return m.text;
    // Bot messages often store content in attachments
    if (m.attachments?.length) {
      const att = m.attachments[0];
      // title/text are more meaningful than fallback (which is often "[no preview available]")
      const candidate = att.title || att.text || att.pretext;
      if (candidate) {
        if (att.fields?.length) return candidate + '\n' + att.fields.map((f) => `${f.title}: ${f.value}`).join('\n');
        return candidate;
      }
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

  // Extract file/image/video metadata from a message for inline rendering
  function extractFiles(m) {
    if (!m) return null;
    const files = [];

    // 1. m.files[] — uploaded files
    if (m.files?.length) {
      for (const f of m.files) {
        if (f.mode === 'tombstone') continue;
        const thumb = f.thumb_480 || f.thumb_360 || f.thumb_720 || f.thumb_video || null;
        const url = f.url_private || null;
        const isVoice = f.media_display_type === 'audio' || f.subtype === 'slack_audio';
        if (isVoice || thumb || url) {
          files.push({
            name: f.name || 'file', mimetype: f.mimetype || '', thumb, url,
            ...(isVoice && {
              voice: true,
              fileId: f.id,
              transcript: f.transcription?.status === 'complete' ? f.transcription.preview?.content : null,
              transcriptionStatus: f.transcription?.status || 'none',
              duration_ms: f.duration_ms || null,
            }),
          });
        }
      }
    }

    // 2. m.attachments[] — attachment images + forwarded message files
    if (m.attachments?.length) {
      for (const att of m.attachments) {
        // Forwarded/shared messages: skip image_url (it's the avatar), but extract att.files[]
        if (att.is_msg_unfurl || att.is_share) {
          if (att.files?.length) {
            for (const f of att.files) {
              if (f.mode === 'tombstone') continue;
              const thumb = f.thumb_480 || f.thumb_360 || f.thumb_720 || f.thumb_video || null;
              const url = f.url_private || null;
              if (thumb || url) {
                files.push({ name: f.name || 'file', mimetype: f.mimetype || '', thumb, url });
              }
            }
          }
          continue;
        }
        if (att.image_url) {
          files.push({ name: att.title || 'image', mimetype: 'image/', thumb: att.image_url, url: att.image_url });
        }
      }
    }

    // 3. m.blocks[] with type === 'image' — image blocks
    if (m.blocks?.length) {
      for (const block of m.blocks) {
        if (block.type === 'image' && block.image_url) {
          files.push({ name: block.alt_text || block.title?.text || 'image', mimetype: 'image/', thumb: block.image_url, url: block.image_url });
        }
      }
    }

    return files.length > 0 ? files : null;
  }

  // Trigger transcript generation for voice files that don't have one yet, then poll until ready
  async function ensureTranscripts(files) {
    if (!files) return files;
    const pending = files.filter(f => f.voice && !f.transcript && f.fileId);
    if (pending.length === 0) return files;

    // Trigger retranscription for each
    await Promise.all(pending.map(f =>
      slackApi('files.retranscribe', { file_id: f.fileId }).catch(() => {})
    ));

    // Poll files.info until transcripts are ready (max ~15s)
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      const results = await Promise.all(pending.map(f =>
        slackApi('files.info', { file: f.fileId }).catch(() => null)
      ));
      for (let i = 0; i < pending.length; i++) {
        const info = results[i]?.file;
        if (info?.transcription?.status === 'complete' && info.transcription.preview?.content) {
          pending[i].transcript = info.transcription.preview.content;
          pending[i].transcriptionStatus = 'complete';
        }
      }
      if (pending.every(f => f.transcript)) break;
    }
    return files;
  }

  function progress(step, detail) {
    window.postMessage({ type: `${FSLACK}:progress`, step, detail }, '*');
  }

  async function fetchUnreads({ cachedUsers = {}, cachedUserMentionHints = {}, cachedChannels = {}, cachedChannelMeta = {}, cachedEmoji = null } = {}) {
    // 1. Get counts + self ID
    progress(1, 'Getting counts + user info...');
    const [counts, { selfId, muted }] = await Promise.all([
      slackApi('client.counts'),
      getSelfIdAndMuted(),
    ]);
    _selfId = selfId;
    progress(1, `Done. ${(counts.channels||[]).filter(c=>c.has_unreads).length} unread channels, self=${selfId}`);

    // 2. Get unread threads — use unread_replies, filter out self-only
    progress(2, 'Fetching threads...');
    const threadView = await slackApi('subscriptions.thread.getView');
    const threads = (threadView.threads || [])
      .map((t) => {
        const unread = (t.unread_replies || []).map((r) => ({
          user: r.user,
          text: extractText(r),
          fwd: extractFwd(r),
          ts: r.ts,
          bot_id: r.bot_id,
          subtype: r.subtype,
          files: extractFiles(r),
        }));
        // Filter: skip if all unread replies are from self
        const othersUnread = unread.filter((r) => r.user !== selfId);
        if (othersUnread.length === 0) return null;

        const lastUnread = othersUnread[othersUnread.length - 1];
        return {
          channel_id: t.root_msg?.channel,
          ts: t.root_msg?.ts,
          root_text: extractText(t.root_msg || {}),
          root_fwd: extractFwd(t.root_msg || {}),
          root_files: extractFiles(t.root_msg || {}),
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

    // 2b. For threads where I replied, fetch full thread context (last 10 replies)
    const myRepliedThreads = threads.filter((t) => (t.reply_users || []).includes(selfId));
    if (myRepliedThreads.length > 0) {
      progress(2, `Fetching context for ${myRepliedThreads.length} threads I replied in...`);
      await Promise.all(myRepliedThreads.map(async (t) => {
        try {
          const r = await slackApi('conversations.replies', { channel: t.channel_id, ts: t.ts, limit: '12' });
          // Skip root (index 0), take last 10 replies
          const allReplies = (r.messages || []).slice(1).slice(-10);
          if (allReplies.length > 0) {
            const firstUnreadTs = t.unread_replies[0]?.ts;
            t.full_replies = allReplies.map((m) => ({
              user: m.user,
              text: extractText(m),
              ts: m.ts,
              is_unread: firstUnreadTs ? parseFloat(m.ts) >= parseFloat(firstUnreadTs) : false,
            }));
          }
        } catch { /* non-critical */ }
      }));
    }

    // 3. Get unread DMs — fetch history for each
    const unreadIms = (counts.ims || []).filter((c) => c.has_unreads).map((c) => ({ ...c, kind: 'im' }));
    const unreadMpims = (counts.mpims || []).filter((c) => c.has_unreads).map((c) => ({ ...c, kind: 'mpim' }));
    const unreadDirects = [...unreadIms, ...unreadMpims];
    const dms = [];
    let dmsDone = 0;
    const dmsTotal = unreadDirects.length;
    const dmFailures = [];
    progress(3, dmsTotal > 0 ? `Fetching DMs (incl. group DMs)... 0/${dmsTotal}` : 'Fetching DMs...');
    function normalizeTimestamp(ts) {
      if (!ts) return null;
      if (typeof ts === 'number') return ts > 0 ? ts.toString() : null;
      if (typeof ts === 'string' && /^\d+(?:\.\d+)?$/.test(ts)) return parseFloat(ts) > 0 ? ts : null;
      return null;
    }

    for (const conv of unreadDirects) {
      const kindLabel = conv.kind === 'mpim' ? 'group DM' : 'DM';
      let historyParams = null;
      try {
        const oldestTs = normalizeTimestamp(conv.last_read)
          || normalizeTimestamp(conv.last_read_ts)
          || (conv.kind === 'im' ? '0' : null);
        historyParams = { channel: conv.id };
        if (oldestTs) historyParams.oldest = oldestTs;
        const hist = await slackApi('conversations.history', historyParams);
        const msgs = (hist.messages || [])
          .filter((m) => m.user !== selfId)
          .map((m) => ({
            user: m.user,
            text: extractText(m),
            fwd: extractFwd(m),
            ts: m.ts,
            subtype: m.subtype,
            bot_id: m.bot_id,
            files: extractFiles(m),
          }));
        // Trigger transcript generation for voice messages without one
        for (const msg of msgs) {
          if (msg.files) await ensureTranscripts(msg.files);
        }
        if (msgs.length > 0) {
          const dmPayload = {
            channel_id: conv.id,
            messages: msgs,
          };
          if (conv.kind === 'mpim') {
            dmPayload.isGroup = true;
            let memberIds = (conv.members || []).filter((uid) => uid && uid !== selfId);
            if (memberIds.length === 0) {
              try {
                const info = await slackApi('conversations.info', { channel: conv.id });
                memberIds = (info.channel?.members || []).filter((uid) => uid && uid !== selfId);
              } catch {}
            }
            if (memberIds.length > 0) dmPayload.members = memberIds;
          }
          dms.push(dmPayload);
        }
      } catch (err) {
        console.error(`[${FSLACK}] Failed to fetch ${kindLabel} ${conv.id}`, err, {
          channel: conv.id,
          kind: conv.kind,
          historyParams,
          rawConversation: conv,
        });
        dmFailures.push({ id: conv.id, kind: conv.kind, error: err?.message || String(err) });
        progress(3, `Failed to fetch ${kindLabel} ${conv.id}: ${err?.message || 'unknown error'}`);
      }
      progress(3, `Fetching DMs (incl. group DMs)... ${++dmsDone}/${dmsTotal}`);
    }

    const dmDoneDetail = `Done. ${dms.length} direct conversations${unreadMpims.length > 0 ? ' (incl. group DMs)' : ''}.`;
    progress(3, dmFailures.length > 0
      ? `${dmDoneDetail} ${dmFailures.length} failed — see console.`
      : dmDoneDetail);

    // 4. Get unread channel messages — most recent channels first
    progress(4, 'Fetching channel messages...');
    const unreadChannels = (counts.channels || [])
      .filter((c) => c.has_unreads && !muted.has(c.id))
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
            .filter((m) => !m.subtype || !NOISE_SUBTYPES.has(m.subtype))
            .filter((m) => m.user !== selfId)
            .map((m) => ({
              user: m.user,
              text: extractText(m),
              fwd: extractFwd(m),
              ts: m.ts,
              thread_ts: m.thread_ts || null,
              subtype: m.subtype,
              bot_id: m.bot_id,
              reply_count: m.reply_count || 0,
              reply_users: m.reply_users || [],
              files: extractFiles(m),
            }));
          if (msgs.length > 0) {
            const channelPost = {
              channel_id: ch.id,
              mention_count: ch.mention_count,
              messages: msgs,
              sort_ts: msgs[0]?.ts || '0',
            };
            if (msgs.length >= 4) {
              try {
                const deepHist = await slackApi('conversations.history', {
                  channel: ch.id, oldest: ch.last_read, limit: '20',
                });
                const deepMsgs = (deepHist.messages || [])
                  .filter((m) => !m.subtype || !NOISE_SUBTYPES.has(m.subtype))
                  .filter((m) => m.user !== selfId)
                  .map((m) => ({
                    user: m.user,
                    text: extractText(m),
                    fwd: extractFwd(m),
                    ts: m.ts,
                    thread_ts: m.thread_ts || null,
                    subtype: m.subtype,
                    bot_id: m.bot_id,
                    reply_count: m.reply_count || 0,
                    reply_users: m.reply_users || [],
                    files: extractFiles(m),
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
                          fwd: extractFwd(reply),
                          ts: reply.ts,
                          files: extractFiles(reply),
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

    // 5. Collect all user IDs and channel mentions, then resolve names
    const allUserIds = [];
    const mentionedChannelIds = [];
    function collectMentions(text) {
      if (!text) return;
      for (const m of text.matchAll(/<@(U[A-Z0-9]+)>/g)) allUserIds.push(m[1]);
      for (const m of text.matchAll(/<#(C[A-Z0-9]+)(?:\|[^>]*)?>/g)) mentionedChannelIds.push(m[1]);
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
    const missingProfiles = uniqueUserIds.filter((uid) => !cachedUsers[uid] || !cachedUserMentionHints[uid]).length;
    progress(5, `Resolving ${missingProfiles} user profiles (${uniqueUserIds.length - missingProfiles} cached)...`);
    const { users, mentionHints } = await resolveUsers(
      allUserIds,
      cachedUsers,
      cachedUserMentionHints,
      (done, total) => {
        if (total > 0) progress(5, `Resolving users... ${done}/${total}`);
      }
    );
    progress(5, `Done. ${Object.keys(users).length} users resolved.`);

    // 6. Get channel names for threads + channel posts
    const allChannelIds = [
      ...threads.map((t) => t.channel_id),
      ...channelPosts.map((cp) => cp.channel_id),
      ...mentionedChannelIds,
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
    for (const mp of (counts.mpims || [])) {
      if (mp.last_read) lastRead[mp.id] = mp.last_read;
    }

    // 7. Custom emoji
    let emoji = cachedEmoji;
    if (!emoji) {
      try { emoji = await fetchEmojiList(); } catch { emoji = {}; }
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
      emoji,
      emojiFromCache: cachedEmoji !== null,
      userMentionHints: mentionHints,
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
          text: extractText(m),
          fwd: extractFwd(m),
          ts: m.ts,
          files: extractFiles(m),
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
    { name: 'JM',     query: 'from:<@U02KNNU0ZBN>' },
    { name: 'Josh',   query: 'from:@josh' },
    { name: 'Samir',  query: 'from:@samir' },
    { name: 'Ori',    query: 'from:<@U0ABNTRG4HJ>' },
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
          text: extractText(m),
          fwd: extractFwd(m),
          ts: m.ts,
          files: extractFiles(m),
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
          cachedUserMentionHints: event.data.cachedUserMentionHints || {},
          cachedChannels: event.data.cachedChannels || {},
          cachedChannelMeta: event.data.cachedChannelMeta || {},
          cachedEmoji: event.data.cachedEmoji || null,
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
          fwd: extractFwd(m),
          ts: m.ts,
          files: extractFiles(m),
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
        const now = Math.floor(Date.now() / 1000);
        await slackApi('saved.add', {
          channel,
          timestamp: ts,
          item_type: 'message',
          item_id: channel,
          date_created: now,
          date_due: 0,
          date_completed: 0,
          date_updated: now,
          is_archived: false,
          date_snoozed_until: 0,
          ts,
          state: 'in_progress',
        });
        window.postMessage({ type: `${FSLACK}:saveResult`, requestId, ok: true }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:saveResult`, requestId, ok: false }, '*');
      }
    }

    if (msgType === `${FSLACK}:unsaveMessage`) {
      const { channel, ts, requestId } = event.data;
      try {
        await slackApi('saved.delete', { channel, ts, item_type: 'message', item_id: channel });
        window.postMessage({ type: `${FSLACK}:unsaveResult`, requestId, ok: true }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:unsaveResult`, requestId, ok: false }, '*');
      }
    }

    if (msgType === `${FSLACK}:fetchSaved`) {
      const { requestId } = event.data;
      try {
        const result = await slackApi('saved.list', { limit: 25, filter: 'saved', include_tombstones: true });
        const cutoff = Math.floor(Date.now() / 1000) - 72 * 60 * 60;
        const items = (result.saved_items || []).filter(
          (item) => item.state !== 'completed' && (item.date_created || 0) >= cutoff
        );
        const itemsWithMessages = await Promise.all(
          items.map(async (item) => {
            try {
              // Try top-level history first
              const hist = await slackApi('conversations.history', {
                channel: item.item_id,
                latest: item.ts,
                oldest: item.ts,
                inclusive: true,
                limit: 1,
              });
              let message = hist.messages?.[0] || null;

              // Not in history — likely a thread reply; use reactions.get which resolves any message by channel+ts
              if (!message) {
                try {
                  const rxn = await slackApi('reactions.get', {
                    channel: item.item_id,
                    timestamp: item.ts,
                    full: true,
                  });
                  message = rxn.message || null;
                } catch {}
              }

              if (message) message = { ...message, text: extractText(message), fwd: extractFwd(message), files: extractFiles(message) };
              return { ...item, message };
            } catch {
              return item;
            }
          })
        );
        window.postMessage({ type: `${FSLACK}:savedResult`, requestId, items: itemsWithMessages }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:savedResult`, requestId, items: [] }, '*');
      }
    }

    if (msgType === `${FSLACK}:completeSaved`) {
      const { item_id, ts, requestId } = event.data;
      try {
        await slackApi('saved.update', {
          item_type: 'message',
          item_id,
          ts,
          date_due: 0,
          mark: 'completed',
          _x_reason: 'manually_mark_completed',
        });
        window.postMessage({ type: `${FSLACK}:completeSavedResult`, requestId, ok: true }, '*');
      } catch {
        window.postMessage({ type: `${FSLACK}:completeSavedResult`, requestId, ok: false }, '*');
      }
    }

    if (msgType === `${FSLACK}:markRead`) {
      const { channel, ts, thread_ts, has_mention, requestId } = event.data;
      try {
        if (thread_ts) {
          await slackApi('subscriptions.thread.mark', { channel, thread_ts, ts });
          // Also clear channel-level mention badge when thread had an @-mention
          if (has_mention) {
            await slackApi('conversations.mark', { channel, ts }).catch(() => {});
          }
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
        const resp = await slackApi('chat.postMessage', params);
        const postedTs = resp?.ts || resp?.message?.ts || '';
        window.postMessage({ type: `${FSLACK}:postReplyResult`, requestId, ok: true, ts: postedTs }, '*');
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

    if (msgType === `${FSLACK}:pollNewDms`) {
      const { knownChannelIds, requestId } = event.data;
      const known = new Set(knownChannelIds || []);
      try {
        const selfId = _selfId || (await getSelfIdAndMuted()).selfId;
        const counts = await slackApi('client.counts');
        const unreadIms = (counts.ims || []).filter((c) => c.has_unreads && !known.has(c.id)).map((c) => ({ ...c, kind: 'im' }));
        const unreadMpims = (counts.mpims || []).filter((c) => c.has_unreads && !known.has(c.id)).map((c) => ({ ...c, kind: 'mpim' }));
        const newDirects = [...unreadIms, ...unreadMpims];
        const newDms = [];
        for (const conv of newDirects) {
          try {
            const histParams = { channel: conv.id };
            const oldest = conv.last_read || conv.last_read_ts;
            if (oldest && parseFloat(oldest) > 0) histParams.oldest = String(oldest);
            const hist = await slackApi('conversations.history', histParams);
            const msgs = (hist.messages || [])
              .filter((m) => m.user !== selfId)
              .map((m) => ({
                user: m.user,
                text: extractText(m),
                fwd: extractFwd(m),
                ts: m.ts,
                subtype: m.subtype,
                bot_id: m.bot_id,
                files: extractFiles(m),
              }));
            if (msgs.length > 0) {
              const dmPayload = { channel_id: conv.id, messages: msgs };
              if (conv.kind === 'mpim') {
                dmPayload.isGroup = true;
                let memberIds = (conv.members || []).filter((uid) => uid && uid !== selfId);
                if (memberIds.length === 0) {
                  try {
                    const info = await slackApi('conversations.info', { channel: conv.id });
                    memberIds = (info.channel?.members || []).filter((uid) => uid && uid !== selfId);
                  } catch {}
                }
                if (memberIds.length > 0) dmPayload.members = memberIds;
              }
              newDms.push(dmPayload);
            }
          } catch {}
        }
        // Resolve any unknown user IDs in new DMs
        const userIds = new Set();
        for (const dm of newDms) {
          for (const m of dm.messages) { if (m.user) userIds.add(m.user); }
          if (dm.members) dm.members.forEach((uid) => userIds.add(uid));
        }
        const unknownIds = [...userIds].filter((uid) => !event.data.cachedUsers?.[uid]);
        let resolvedUsers = {};
        if (unknownIds.length > 0) {
          const resolved = await resolveUsers(unknownIds, {}, {});
          resolvedUsers = resolved.users;
        }
        window.postMessage({ type: `${FSLACK}:newDmsResult`, requestId, newDms, resolvedUsers }, '*');
      } catch (err) {
        window.postMessage({ type: `${FSLACK}:newDmsResult`, requestId, newDms: [], resolvedUsers: {} }, '*');
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

    if (msgType === `${FSLACK}:navigate`) {
      const { channel, ts } = event.data;
      if (channel) {
        // Try clicking the sidebar element for SPA navigation (no reload)
        if (!ts) {
          const sidebarEl = document.getElementById(channel);
          if (sidebarEl) {
            const clickTarget = sidebarEl.querySelector('[data-qa-channel-sidebar-channel="true"]') || sidebarEl;
            clickTarget.click();
            return;
          }
        }
        // Fallback: full page navigation via /archives/ permalink
        const url = ts
          ? `/archives/${channel}/p${ts.replace('.', '')}`
          : `/archives/${channel}`;
        window.location.assign(url);
      }
    }
  });

  // Signal ready
  window.postMessage({ type: `${FSLACK}:ready` }, '*');
})();
