(function initPrioritization(globalScope, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.FslackPrioritization = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildPrioritizationApi() {
  const CAT_RANK = { drop: 0, noise: 1, when_free: 2, priority: 3, act_now: 4 };
  const HOT_THRESHOLD = 5;
  function msgEngagement(m) { return (m.reply_count || 0) + (m.reaction_count || 0); }

  function containsSelfMention(text, selfId, options = {}) {
    if (!text || !selfId) return false;
    if (text.includes(`<@${selfId}>`)) return true;
    if (text.includes(`@${selfId}`)) return true;
    if (text.includes('<!channel>') || text.includes('<!here>')) return true;
    const handleMentionRegex = options.handleMentionRegex || null;
    return handleMentionRegex ? handleMentionRegex.test(text) : false;
  }

  function applyPreFilters(data, options = {}) {
    const {
      handleMentionRegex = null,
      mutedThreadKeys = new Set(),
      sidebarSections = {},
      sidebarSectionNameMap = {},
      threadKey = (channel, threadTs) => (channel && threadTs ? `${channel}:${threadTs}` : null),
      uname = (uid, users) => (uid ? users?.[uid] || uid : 'bot'),
      windowObj = null,
    } = options;
    const { selfId, threads, dms, channelPosts, channels, users } = data;
    const preFilterLog = {};
    if (windowObj) windowObj._preFilterLog = preFilterLog;

    const noise = [];
    const whenFree = [];
    const digests = [];
    const forLlm = { threads: [], dms: [], channelPosts: [] };

    function isBot(message) {
      return message.bot_id || message.subtype === 'bot_message';
    }

    const threadList = Array.isArray(threads) ? threads : [];
    const channelPostList = Array.isArray(channelPosts) ? channelPosts : [];
    const dmList = Array.isArray(dms) ? dms : [];

    const broadcastedThreadReplyKeys = new Set();
    for (const channelPost of channelPostList) {
      const channelId = channelPost?.channel_id;
      if (!channelId) continue;
      for (const message of channelPost.messages || []) {
        if (message.thread_ts && message.thread_ts !== message.ts) {
          broadcastedThreadReplyKeys.add(`${channelId}:${message.ts}`);
        }
      }
    }

    const filteredThreads = [];
    for (const thread of threadList) {
      if (!thread) continue;
      const muteKey = threadKey(thread.channel_id, thread.ts);
      if (muteKey && mutedThreadKeys.has(muteKey)) continue;
      const unreadReplies = thread.unread_replies || [];
      if (unreadReplies.length > 0 && broadcastedThreadReplyKeys.size > 0) {
        const dedupedReplies = unreadReplies.filter((reply) => !broadcastedThreadReplyKeys.has(`${thread.channel_id}:${reply.ts}`));
        if (dedupedReplies.length !== unreadReplies.length) {
          thread.unread_replies = dedupedReplies;
          if (dedupedReplies.length > 0) {
            const latestReply = dedupedReplies[dedupedReplies.length - 1];
            if (latestReply?.ts) thread.sort_ts = latestReply.ts;
          }
        }
      }
      if ((thread.unread_replies || []).length === 0) continue;
      filteredThreads.push(thread);
    }
    data.threads = filteredThreads;

    for (const thread of filteredThreads) {
      thread._userReplied = (thread.reply_users || []).includes(selfId);
      thread._type = 'thread';
      thread._isDmThread = thread.channel_id?.startsWith('D') || false;
      thread._sidebarSection = sidebarSections[thread.channel_id] || null;
      thread._sidebarSectionName = sidebarSectionNameMap[thread.channel_id] || null;

      const unreadTexts = (thread.unread_replies || []).map((reply) => reply.text).join(' ');
      thread._mentionInReplies = containsSelfMention(unreadTexts, selfId, { handleMentionRegex });
      thread._isMentioned = thread._mentionInReplies;
      thread._mentionInRoot = containsSelfMention(thread.root_text || '', selfId, { handleMentionRegex });

      const isOwnThread = thread.root_user === selfId;
      if (thread._sidebarSection === 'high_volume' && !isOwnThread && !thread._isMentioned) {
        const sectionName = thread._sidebarSectionName || 'high-volume';
        if (msgEngagement(thread) >= HOT_THRESHOLD) {
          thread._forceThreadSummary = true;
          thread._ruleOverride = `"${sectionName}" section: ${HOT_THRESHOLD}+ engagement → relevant`;
          whenFree.push(thread);
        } else {
          thread._ruleOverride = `"${sectionName}" section: <${HOT_THRESHOLD} engagement → noise`;
          noise.push(thread);
        }
        continue;
      }

      forLlm.threads.push(thread);
    }

    const threadRootKeys = new Set();
    const threadByKey = {};
    for (const thread of filteredThreads) {
      if (thread.channel_id && thread.ts) {
        const key = `${thread.channel_id}:${thread.ts}`;
        threadRootKeys.add(key);
        threadByKey[key] = thread;
      }
    }

    for (const channelPost of channelPostList) {
      channelPost._type = 'channel';
      channelPost._sidebarSection = sidebarSections[channelPost.channel_id] || null;
      channelPost._sidebarSectionName = sidebarSectionNameMap[channelPost.channel_id] || null;

      // Per-message mention detection: split mentioned vs non-mentioned messages
      const mentionedMessages = [];
      const nonMentionedMessages = [];
      for (const message of channelPost.messages || []) {
        if (containsSelfMention(message.text || '', selfId, { handleMentionRegex })) {
          mentionedMessages.push(message);
        } else {
          nonMentionedMessages.push(message);
        }
      }
      channelPost._isMentioned = mentionedMessages.length > 0;
      const allTexts = (channelPost.messages || []).map((message) => message.text || '').join(' ');

      const channelLabel = channels[channelPost.channel_id] || channelPost.channel_id;
      const debugLog = (route) => {
        preFilterLog[channelPost.channel_id] = {
          channel: channelLabel,
          route,
          _isMentioned: channelPost._isMentioned,
          mention_count: channelPost.mention_count,
          msgCount: channelPost.messages.length,
          selfId,
          sidebarSection: channelPost._sidebarSection,
          textSnippet: allTexts.slice(0, 200),
        };
      };

      const channelMessagesInThreads = channelPost.messages.filter((message) => threadRootKeys.has(`${channelPost.channel_id}:${message.ts}`));
      if (channelMessagesInThreads.length === channelPost.messages.length && channelPost.messages.length > 0) {
        for (const message of channelMessagesInThreads) {
          const thread = threadByKey[`${channelPost.channel_id}:${message.ts}`];
          if (thread) {
            if (channelPost.mention_count > 0) thread.mention_count = (thread.mention_count || 0) + channelPost.mention_count;
            if (channelPost._isMentioned) thread._isMentioned = true;
          }
        }
        debugLog('dedup-to-thread');
        continue;
      }

      // First pass: rescue reaction-spiked messages → whenFree (before section routing)
      const spikedMessages = channelPost.messages.filter((message) => message.isReactionSpike);
      if (spikedMessages.length > 0) {
        whenFree.push({
          ...channelPost,
          messages: spikedMessages,
          _type: 'channel',
          _ruleOverride: `reaction spike (≥${Math.max(6, Math.round(3 * (channelPost.reactionMedian || 0)))} reactions) → relevant`,
        });
        channelPost.messages = channelPost.messages.filter((message) => !message.isReactionSpike);
        if (channelPost.messages.length === 0) {
          debugLog('reaction-spike-all');
          continue;
        }
      }

      if (channelPost._sidebarSection === 'high_volume' && !channelPost._isMentioned) {
        const sectionName = channelPost._sidebarSectionName || 'high-volume';
        const hotMessages = channelPost.messages.filter((message) => msgEngagement(message) >= HOT_THRESHOLD);
        const coldMessages = channelPost.messages.filter((message) => msgEngagement(message) < HOT_THRESHOLD);
        if (hotMessages.length > 0) {
          const hotChannelPost = {
            ...channelPost,
            messages: hotMessages,
            _type: 'channel',
            _ruleOverride: `"${sectionName}" section: ${HOT_THRESHOLD}+ engagement → relevant`,
          };
          const replierIds = [...new Set(hotMessages.flatMap((message) => message.reply_users || []))];
          hotChannelPost._repliers = replierIds.slice(0, 3).map((uid) => uname(uid, users));
          hotChannelPost._replierOverflow = Math.max(0, replierIds.length - 3);
          hotChannelPost._summarizeThreads = true;
          whenFree.push(hotChannelPost);
        }
        if (coldMessages.length > 0) {
          noise.push({
            ...channelPost,
            messages: coldMessages,
            _type: 'channel',
            _ruleOverride: `"${sectionName}" section: <${HOT_THRESHOLD} engagement → noise`,
          });
        }
        debugLog('high_volume');
        continue;
      }

      if (channelPost._sidebarSection === 'hard_noise') {
        const sectionName = channelPost._sidebarSectionName || 'hard-noise';
        channelPost._ruleOverride = `"${sectionName}" section → always noise`;
        debugLog('hard_noise');
        noise.push(channelPost);
        continue;
      }

      if (channelPost._sidebarSection === 'skip') {
        debugLog('skip');
        continue;
      }

      // Default route: mentioned or floor-section → LLM (so floors can elevate), otherwise → noise
      // When only some messages are mentioned, split: mentioned messages → LLM as mentioned,
      // non-mentioned messages → route normally (floor/noise) WITHOUT the mention flag.
      if (channelPost._isMentioned && nonMentionedMessages.length > 0) {
        // Split: mentioned messages go to LLM as mentioned
        const mentionedPost = {
          ...channelPost,
          messages: mentionedMessages,
          _isMentioned: true,
          mention_count: mentionedMessages.length,
        };
        forLlm.channelPosts.push(mentionedPost);

        // Non-mentioned messages route as if no mention exists
        const restPost = {
          ...channelPost,
          messages: nonMentionedMessages,
          _isMentioned: false,
          mention_count: 0,
        };
        if (restPost._sidebarSection === 'floor_whenfree' || restPost._sidebarSection === 'floor_priority') {
          forLlm.channelPosts.push(restPost);
        } else {
          noise.push(restPost);
        }
        debugLog('mentioned-split');
      } else if (channelPost._isMentioned) {
        debugLog('mentioned-forLlm');
        forLlm.channelPosts.push(channelPost);
      } else if (channelPost._sidebarSection === 'floor_whenfree' || channelPost._sidebarSection === 'floor_priority') {
        debugLog('floor-section-forLlm');
        forLlm.channelPosts.push(channelPost);
      } else {
        debugLog('noise-default');
        noise.push(channelPost);
      }
    }

    for (const dm of dmList) {
      dm._type = 'dm';
      const originalMessages = dm.messages || [];
      const filteredMessages = originalMessages.filter((message) => !threadRootKeys.has(`${dm.channel_id}:${message.ts}`));
      if (filteredMessages.length === 0) continue;
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

  function serializeForLlm(forLlm, data, options = {}) {
    const {
      channelIndexOffset = 0,
      fullName = (uid, fullNames) => fullNames?.[uid] || uid,
      plainTruncate = (text) => text || '',
      textWithFwd = (text, fwd) => {
        if (!fwd) return text || '';
        const prefix = fwd.author ? `[fwd from ${fwd.author}] ` : '[fwd] ';
        return text ? `${text} ${prefix}${fwd.text}` : `${prefix}${fwd.text}`;
      },
    } = options;
    const items = [];
    const meta = data.channelMeta || {};

    for (let index = 0; index < forLlm.threads.length; index += 1) {
      const thread = forLlm.threads[index];
      const channel = data.channels[thread.channel_id] || thread.channel_id;
      const item = {
        id: `thread_${index}`,
        type: thread._isDmThread ? 'dm_thread' : 'thread',
        channel,
        _channelId: thread.channel_id,
        isPrivate: meta[thread.channel_id]?.isPrivate || false,
        isMentioned: thread._isMentioned || false,
        sidebarSection: thread._sidebarSection || undefined,
        rootUser: fullName(thread.root_user, data.fullNames),
        rootText: plainTruncate(textWithFwd(thread.root_text, thread.root_fwd), 1000, data.users),
        userReplied: thread._userReplied,
        newReplies: thread.unread_replies.map((reply) => ({
          user: fullName(reply.user, data.fullNames),
          text: plainTruncate(textWithFwd(reply.text, reply.fwd), 1000, data.users),
        })),
      };
      if (thread.full_replies?.length) {
        const readReplies = thread.full_replies.filter((reply) => !reply.is_unread);
        if (readReplies.length > 0) {
          item.recentContext = readReplies.map((reply) => ({
            user: fullName(reply.user, data.fullNames),
            text: plainTruncate(reply.text, 500, data.users),
          }));
        }
      }
      items.push(item);
    }

    for (let index = 0; index < forLlm.dms.length; index += 1) {
      const dm = forLlm.dms[index];
      const participantIds = (dm.members || []).filter((uid) => uid && uid !== data.selfId);
      const participantNames = [...new Set(participantIds.map((uid) => fullName(uid, data.fullNames)))].filter(Boolean);
      const item = {
        id: `dm_${index}`,
        type: 'dm',
        isGroup: !!dm.isGroup,
        participants: participantNames,
        messages: dm.messages.map((message) => ({
          user: message.subtype === 'bot_message' ? 'Bot' : fullName(message.user, data.fullNames),
          text: plainTruncate(textWithFwd(message.text, message.fwd), 1000, data.users),
        })),
      };
      if (dm.recentContext?.length) {
        item.recentContext = dm.recentContext.map((message) => ({
          user: fullName(message.user, data.fullNames),
          text: plainTruncate(message.text, 500, data.users),
        }));
      }
      items.push(item);
    }

    for (let index = 0; index < forLlm.channelPosts.length; index += 1) {
      const channelPost = forLlm.channelPosts[index];
      const channel = data.channels[channelPost.channel_id] || channelPost.channel_id;
      items.push({
        id: `channel_${index + channelIndexOffset}`,
        type: 'channel',
        channel,
        _channelId: channelPost.channel_id,
        isPrivate: meta[channelPost.channel_id]?.isPrivate || false,
        isMentioned: channelPost._isMentioned || false,
        sidebarSection: channelPost._sidebarSection || undefined,
        mentionCount: channelPost.mention_count || 0,
        messages: channelPost.messages.map((message) => ({
          user: message.subtype === 'bot_message' ? 'Bot' : fullName(message.user, data.fullNames),
          text: plainTruncate(textWithFwd(message.text, message.fwd), 1000, data.users),
        })),
      });
    }

    return items;
  }

  function floorCategory(current, floor) {
    return (CAT_RANK[current] || 0) >= (CAT_RANK[floor] || 0) ? current : floor;
  }

  function defaultDmPartnerName(dm, data) {
    const messages = dm.messages || [];
    if (dm.isGroup) {
      const explicitIds = (dm.members || []).filter((uid) => uid && uid !== data.selfId);
      const inferredIds = messages
        .map((message) => (message.user && message.subtype !== 'bot_message' ? message.user : null))
        .filter((uid) => uid && uid !== data.selfId);
      const uniqueIds = [...new Set([...explicitIds, ...inferredIds])];
      const names = uniqueIds.map((uid) => data.users?.[uid] || uid).filter(Boolean);
      if (names.length === 0) return 'Group DM';
      if (names.length <= 3) return names.join(', ');
      return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
    }
    for (const message of messages) {
      if (message.user && message.subtype !== 'bot_message') return data.users?.[message.user] || message.user;
    }
    return 'DM';
  }

  function mapPriorities(priorities, forLlm, deterministicNoise, deterministicWhenFree, data, reasons = {}, options = {}) {
    const { priorityRules = {}, dmPartnerName = defaultDmPartnerName } = options;
    const actNow = [];
    const priority = [];
    const whenFree = [...deterministicWhenFree];
    const noise = [...deterministicNoise];
    const meta = data?.channelMeta || {};

    const CAT_LABEL = { act_now: 'urgent', priority: 'priority', when_free: 'relevant', noise: 'noise', drop: 'drop' };

    function place(item, cat) {
      const isPrivate = meta[item.channel_id]?.isPrivate || item._type === 'dm' || item._isDmThread;
      const isDm = item._type === 'dm' || item._isDmThread;
      const isMentioned = item._isMentioned || false;
      const mentionInRoot = item._mentionInRoot || false;
      const isImportantChannel = item._sidebarSection === 'floor_priority' || item._sidebarSection === 'floor_whenfree';
      const userReplied = item._userReplied || false;
      const llmCat = cat;
      const channelLabel = data.channels?.[item.channel_id] || item.channel_id;

      const dmRule = priorityRules.dm || 'priority';
      const vipDmRule = priorityRules.vipDm || 'act_now';
      if (isDm) {
        const vipSet = new Set(data.vipUserIds || []);
        const senderIds = (item.messages || item.unread_replies || []).map((message) => message.user).filter(Boolean);
        const isVipDm = senderIds.some((uid) => vipSet.has(uid));
        if (isVipDm && vipDmRule !== 'ai') {
          const before = cat;
          cat = floorCategory(cat, vipDmRule);
          const floorLabel = CAT_LABEL[vipDmRule] || vipDmRule;
          if (cat !== before) item._ruleOverride = `VIP DM (Minimum: ${floorLabel}) — AI said ${CAT_LABEL[llmCat]}`;
          else if (cat === before && CAT_RANK[cat] > CAT_RANK[vipDmRule]) item._ruleOverride = `VIP DM (Minimum: ${floorLabel}) — AI elevated to ${CAT_LABEL[cat]}`;
          else item._ruleOverride = `VIP DM (Minimum: ${floorLabel})`;
        } else if (!isVipDm && dmRule !== 'ai') {
          const before = cat;
          cat = floorCategory(cat, dmRule);
          const floorLabel = CAT_LABEL[dmRule] || dmRule;
          if (cat !== before) item._ruleOverride = `DM (Minimum: ${floorLabel}) — AI said ${CAT_LABEL[llmCat]}`;
          else if (cat === before && CAT_RANK[cat] > CAT_RANK[dmRule]) item._ruleOverride = `DM (Minimum: ${floorLabel}) — AI elevated to ${CAT_LABEL[cat]}`;
          else item._ruleOverride = `DM (Minimum: ${floorLabel})`;
        }
      }

      const mentionRule = priorityRules.mention || 'priority';
      if (isMentioned && mentionRule !== 'ai') {
        const before = cat;
        cat = floorCategory(cat, mentionRule);
        const floorLabel = CAT_LABEL[mentionRule] || mentionRule;
        if (cat !== before) item._ruleOverride = `@mention (Minimum: ${floorLabel}) — AI said ${CAT_LABEL[llmCat]}`;
        else if (cat === before && CAT_RANK[cat] > CAT_RANK[mentionRule]) item._ruleOverride = `@mention (Minimum: ${floorLabel}) — AI elevated to ${CAT_LABEL[cat]}`;
        else item._ruleOverride = `@mention (Minimum: ${floorLabel})`;
      }

      const sectionName = item._sidebarSectionName;
      const sectionFloorLabel = item._sidebarSection === 'floor_priority'
        ? 'Minimum: Priority'
        : item._sidebarSection === 'floor_whenfree'
          ? 'Minimum: Relevant'
          : '';
      const sectionPrefix = sectionName ? `"${sectionName}" section` : 'Channel';
      if (item._sidebarSection === 'floor_priority') {
        if (cat === 'act_now') {
          item._ruleOverride = `${sectionPrefix} (${sectionFloorLabel}) — AI elevated to urgent`;
        } else if (cat !== 'priority') {
          item._ruleOverride = `${sectionPrefix} (${sectionFloorLabel}) — AI said ${CAT_LABEL[llmCat]}`;
          cat = 'priority';
        } else {
          item._ruleOverride = `${sectionPrefix} (${sectionFloorLabel})`;
        }
      }
      if (item._sidebarSection === 'floor_whenfree') {
        if (cat === 'act_now' || cat === 'priority') {
          item._ruleOverride = `${sectionPrefix} (${sectionFloorLabel}) — AI elevated to ${CAT_LABEL[cat]}`;
        } else if (cat === 'noise' || cat === 'drop') {
          item._ruleOverride = `${sectionPrefix} (${sectionFloorLabel}) — AI said ${CAT_LABEL[llmCat]}`;
          cat = 'when_free';
        } else {
          item._ruleOverride = `${sectionPrefix} (${sectionFloorLabel})`;
        }
      }

      // Private channel floor (before early return so 'priority' floor routes correctly)
      const privateRule = priorityRules.privateChannel || 'when_free';
      if (isPrivate && !isDm && privateRule !== 'ai') {
        const before = cat;
        cat = floorCategory(cat, privateRule);
        if (cat !== before) item._ruleOverride = `private channel → at least ${CAT_LABEL[cat]} (AI said ${CAT_LABEL[llmCat]})`;
      }

      // Public channel cap (before early return so the cap can actually fire)
      const publicRule = priorityRules.publicChannel || 'cap_whenfree';
      if (item._type === 'channel' && !isPrivate && !isMentioned && !isImportantChannel && publicRule === 'cap_whenfree') {
        if (cat === 'act_now' || cat === 'priority') {
          item._ruleOverride = `public channel capped at relevant (AI said ${CAT_LABEL[llmCat]})`;
          cat = 'when_free';
        }
      }

      item._reasonWhy = reasons[item._llmId + '_why'] || undefined;

      if (cat === 'act_now' || cat === 'priority') {
        item._reason = reasons[item._llmId] || undefined;
        if (!item._reason && isMentioned) {
          const inChannel = channelLabel ? ` in #${channelLabel}` : '';
          item._reason = item._mentionInReplies && !mentionInRoot ? `mentioned in a reply${inChannel}` : `mentioned${inChannel}`;
        }
        if (!item._reason) {
          let raw = '';
          if (item._type === 'thread') {
            const replies = item.unread_replies || [];
            raw = replies.reduce((best, reply) => {
              const t = reply.fwd ? `${reply.text || ''} [fwd] ${reply.fwd.text || ''}` : (reply.text || '');
              return t.length > best.length ? t : best;
            }, '') || (item.root_fwd ? `${item.root_text || ''} [fwd] ${item.root_fwd.text || ''}` : item.root_text || '');
          } else {
            const messages = item.messages || [];
            raw = messages.reduce((best, message) => {
              const t = message.fwd ? `${message.text || ''} [fwd] ${message.fwd.text || ''}` : (message.text || '');
              return t.length > best.length ? t : best;
            }, '') || '';
          }
          raw = raw.replace(/<@[A-Z0-9]+>/g, '').replace(/<[^|>]+\|([^>]+)>/g, '$1').replace(/<[^>]+>/g, '').trim();
          if (isDm) {
            const partner = dmPartnerName(item, data);
            const preview = raw.length > 100 ? `${raw.slice(0, 100)}...` : raw;
            item._reason = preview ? `${partner}: ${preview}` : `${partner} DM'd you`;
          } else {
            const words = raw.split(/\s+/).filter(Boolean);
            item._reason = words.length > 10 ? `${words.slice(0, 10).join(' ')}...` : words.join(' ') || 'new message';
          }
        }
      }

      if (cat !== llmCat || cat === 'act_now' || cat === 'priority') {
        console.log(
          `[fslack] ${item._llmId} (${item._type}, #${channelLabel}): LLM="${llmCat}" → final="${cat}" | isDm=${isDm} isPrivate=${isPrivate} isMentioned=${isMentioned} isImportant=${isImportantChannel} reason="${item._reason || ''}" why="${item._reasonWhy || ''}"`
        );
      }

      if (cat === 'act_now') {
        actNow.push(item);
        return;
      }
      if (cat === 'priority') {
        priority.push(item);
        return;
      }

      if (userReplied && (cat === 'noise' || cat === 'drop')) {
        whenFree.push(item);
        return;
      }
      if (cat === 'drop') return;
      if (cat === 'when_free') {
        whenFree.push(item);
        return;
      }
      noise.push(item);
    }

    forLlm.threads.forEach((thread, index) => {
      thread._llmId = `thread_${index}`;
      place(thread, priorities[`thread_${index}`]);
    });
    forLlm.dms.forEach((dm, index) => {
      dm._llmId = `dm_${index}`;
      place(dm, priorities[`dm_${index}`]);
    });
    forLlm.channelPosts.forEach((channelPost, index) => {
      channelPost._llmId = `channel_${index}`;
      place(channelPost, priorities[`channel_${index}`]);
    });

    return { actNow, priority, whenFree, noise };
  }

  function sortNoiseItems(items, noiseOrder = []) {
    const orderMap = new Map(noiseOrder.map((id, index) => [id, index]));
    return [...items].sort((left, right) => {
      const leftPosition = orderMap.has(left._llmId) ? orderMap.get(left._llmId) : Infinity;
      const rightPosition = orderMap.has(right._llmId) ? orderMap.get(right._llmId) : Infinity;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      const leftMessages = (left.fullMessages?.history || left.messages || []).length;
      const rightMessages = (right.fullMessages?.history || right.messages || []).length;
      if (rightMessages !== leftMessages) return rightMessages - leftMessages;
      const leftTs = parseFloat(left.messages?.[0]?.ts || left.sort_ts || '0');
      const rightTs = parseFloat(right.messages?.[0]?.ts || right.sort_ts || '0');
      return rightTs - leftTs;
    });
  }

  return {
    CAT_RANK,
    applyPreFilters,
    containsSelfMention,
    floorCategory,
    mapPriorities,
    serializeForLlm,
    sortNoiseItems,
  };
});
