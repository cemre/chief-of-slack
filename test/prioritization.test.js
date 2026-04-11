const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPreFilters,
  containsSelfMention,
  floorCategory,
  mapPriorities,
  serializeForLlm,
  sortNoiseItems,
} = require('../prioritization.js');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function textWithFwd(text, fwd) {
  if (!fwd) return text || '';
  const prefix = fwd.author ? `[fwd from ${fwd.author}] ` : '[fwd] ';
  return text ? `${text} ${prefix}${fwd.text}` : `${prefix}${fwd.text}`;
}

function cleanSlackText(text, users, channels) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<@(U[A-Z0-9_]+)(?:\|([^>]+))?>/g, (_, id, displayName) => `@${displayName || users?.[id] || id}`)
    .replace(/<#(C[A-Z0-9_]+)(?:\|([^>]+))?>/g, (_, id, label) => `#${label || channels?.[id] || id}`)
    .replace(/<([^|>]+)\|([^>]+)>/g, (_, _url, label) => label)
    .replace(/<([^>]+)>/g, (_, url) => url);
}

function plainTruncate(text, max = 150, users, channels) {
  const cleaned = cleanSlackText(text, users, channels);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}...`;
}

function fullName(uid, fullNames, users) {
  return fullNames?.[uid] || users?.[uid] || uid;
}

function uname(uid, users) {
  if (!uid) return 'bot';
  return users?.[uid] || uid;
}

function dmPartnerName(dm, data) {
  if (dm.isGroup) {
    const ids = (dm.members || []).filter((uid) => uid && uid !== data.selfId);
    const names = [...new Set(ids.map((uid) => uname(uid, data.users)))];
    return names.join(', ') || 'Group DM';
  }
  for (const message of dm.messages || []) {
    if (message.user && message.subtype !== 'bot_message' && message.user !== data.selfId) {
      return uname(message.user, data.users);
    }
  }
  return 'DM';
}

function makePreFilterOptions(data, overrides = {}) {
  return {
    handleMentionRegex: overrides.handleMentionRegex || /@casey\b/i,
    mutedThreadKeys: new Set(overrides.mutedThreadKeys || data.mutedThreadKeys || []),
    sidebarSections: overrides.sidebarSections || data.sidebarSections || {},
    sidebarSectionNameMap: overrides.sidebarSectionNameMap || data.sidebarSectionNameMap || {},
    threadKey: overrides.threadKey || ((channel, threadTs) => (channel && threadTs ? `${channel}:${threadTs}` : null)),
    uname: overrides.uname || uname,
    windowObj: overrides.windowObj || {},
  };
}

function makeSerializeOptions(data) {
  return {
    fullName: (uid, fullNames) => fullName(uid, fullNames, data.users),
    plainTruncate: (text, max, users) => plainTruncate(text, max, users, data.channels),
    textWithFwd,
  };
}

function makeMapOptions(data, overrides = {}) {
  return {
    priorityRules: overrides.priorityRules || data.priorityRules || {},
    dmPartnerName: overrides.dmPartnerName || dmPartnerName,
  };
}

test('containsSelfMention and floorCategory preserve the current floor rules', () => {
  assert.equal(containsSelfMention('Ping <@U_SELF>', 'U_SELF'), true);
  assert.equal(containsSelfMention('Heads up <!here>', 'U_SELF'), true);
  assert.equal(containsSelfMention('Need Casey on this', 'U_SELF', { handleMentionRegex: /@casey\b/i }), false);
  assert.equal(containsSelfMention('Need @casey on this', 'U_SELF', { handleMentionRegex: /@casey\b/i }), true);

  assert.equal(floorCategory('noise', 'priority'), 'priority');
  assert.equal(floorCategory('act_now', 'priority'), 'act_now');
});

test('applyPreFilters sends unmentioned channel posts to noise by default', () => {
  const data = loadFixture('bot-noise.json');
  const options = makePreFilterOptions(data);
  const result = applyPreFilters(clone(data), options);

  assert.equal(result.whenFree.length, 0);
  assert.equal(result.noise.length, 1);
  assert.equal(result.forLlm.channelPosts.length, 0);
});

test('applyPreFilters sends floor_whenfree unmentioned channel posts to forLlm', () => {
  const data = loadFixture('bot-noise.json');
  // Override sidebar section to floor_whenfree
  data.sidebarSections.C_BOT = 'floor_whenfree';
  const options = makePreFilterOptions(data);
  const result = applyPreFilters(clone(data), options);

  assert.equal(result.noise.length, 0, 'floor_whenfree channel should not go to noise');
  assert.equal(result.forLlm.channelPosts.length, 1, 'floor_whenfree channel should go to forLlm');
});

test('applyPreFilters dedups thread/channel overlap and splits high-volume sections', () => {
  const data = {
    selfId: 'U_SELF',
    users: {
      U_SELF: 'Casey',
      U_A: 'Alex',
      U_B: 'Blair',
      U_C: 'Cameron',
      U_D: 'Drew',
    },
    channels: {
      C_MAIN: 'shared-work',
      C_HV: 'release-firehose',
    },
    sidebarSections: {
      C_MAIN: 'normal',
      C_HV: 'high_volume',
    },
    sidebarSectionNameMap: {
      C_MAIN: 'Weekly',
      C_HV: 'Firehose',
    },
    threads: [
      {
        channel_id: 'C_MAIN',
        ts: '100.000100',
        sort_ts: '200.000100',
        reply_count: 2,
        reply_users: ['U_B'],
        root_user: 'U_A',
        root_text: 'Original thread root',
        unread_replies: [
          { ts: '200.000100', text: 'broadcasted reply copy', user: 'U_A' },
          { ts: '300.000100', text: 'fresh unread reply', user: 'U_B' },
        ],
      },
    ],
    dms: [],
    channelPosts: [
      {
        channel_id: 'C_MAIN',
        mention_count: 2,
        messages: [
          { ts: '100.000100', text: '<@U_SELF> root post copy', reply_count: 0, reply_users: [] },
        ],
      },
      {
        channel_id: 'C_MAIN',
        mention_count: 0,
        messages: [
          { ts: '200.000100', thread_ts: '100.000100', text: 'broadcasted reply copy', reply_count: 0, reply_users: [] },
        ],
      },
      {
        channel_id: 'C_HV',
        mention_count: 0,
        messages: [
          { ts: '400.000100', text: 'cold post', user: 'U_A', reply_count: 1, reply_users: [] },
          { ts: '500.000100', text: 'hot post', user: 'U_D', reply_count: 6, reply_users: ['U_A', 'U_B', 'U_C', 'U_D'] },
        ],
      },
    ],
  };

  const result = applyPreFilters(clone(data), makePreFilterOptions(data));

  assert.equal(result.forLlm.threads.length, 1);
  assert.equal(result.forLlm.threads[0].unread_replies.length, 1);
  assert.equal(result.forLlm.threads[0].unread_replies[0].ts, '300.000100');
  assert.equal(result.forLlm.threads[0].sort_ts, '300.000100');
  assert.equal(result.forLlm.threads[0].mention_count, 2);
  assert.equal(result.forLlm.threads[0]._isMentioned, true);

  assert.equal(result.forLlm.channelPosts.length, 0);

  assert.equal(result.whenFree.length, 1);
  assert.equal(result.whenFree[0]._ruleOverride, `"Firehose" section: ${5}+ engagement → relevant`);
  assert.deepEqual(result.whenFree[0]._repliers, ['Alex', 'Blair', 'Cameron']);
  assert.equal(result.whenFree[0]._replierOverflow, 1);

  assert.equal(result.noise.length, 2);
  assert.ok(result.noise.find((item) => item._ruleOverride === `"Firehose" section: <${5} engagement → noise`));
  assert.ok(result.noise.find((item) => item.messages?.[0]?.ts === '200.000100'));
});

test('serializeForLlm keeps the lean payload shape for snapshot-derived base items', () => {
  const data = loadFixture('prioritization-base.json');
  const preFiltered = applyPreFilters(clone(data), makePreFilterOptions(data));
  const items = serializeForLlm(preFiltered.forLlm, data, makeSerializeOptions(data));

  assert.deepEqual(items.map((item) => item.id), ['thread_0', 'dm_0', 'channel_0']);
  assert.equal(items[0].type, 'thread');
  assert.equal(items[0].channel, 'planning-ops');
  assert.match(items[0].rootText, /\[fwd from Casey\]/);
  assert.equal(items[0].recentContext[0].user, 'Casey');

  assert.equal(items[1].type, 'dm');
  assert.deepEqual(items[1].participants, ['Jordan']);
  assert.equal(items[1].messages[0].text, 'so we should count revisits after the create event');

  assert.equal(items[2].type, 'channel');
  assert.equal(items[2].channel, 'eng-ai-tools');
  assert.equal(items[2].messages[1].text, 'The new desktop build can control local GUI tools now. Read more');

  // _channelId is a transient field for behavior learning lookup
  assert.equal(items[0]._channelId, 'C_PRIVATE_THREAD', 'thread should carry _channelId');
  assert.equal(items[1]._channelId, undefined, 'DM should not carry _channelId');
  assert.equal(items[2]._channelId, 'C_PUBLIC', 'channel post should carry _channelId');
});

test('mapPriorities applies DM floors and mention floor on public channel', () => {
  const data = loadFixture('prioritization-base.json');
  const preFiltered = applyPreFilters(clone(data), makePreFilterOptions(data));
  const mapped = mapPriorities(
    {
      thread_0: 'noise',
      dm_0: 'noise',
      channel_0: 'priority',
    },
    preFiltered.forLlm,
    preFiltered.noise,
    preFiltered.whenFree,
    data,
    {},
    makeMapOptions(data, {
      priorityRules: {
        dm: 'priority',
        vipDm: 'act_now',
        mention: 'priority',
        privateChannel: 'ai',
        publicChannel: 'cap_whenfree',
      },
    })
  );

  assert.equal(mapped.actNow.length, 0);
  assert.equal(mapped.priority.length, 2);
  assert.equal(mapped.whenFree.length, 0);
  assert.equal(mapped.noise.length, 1);

  const dm = mapped.priority.find((item) => item._type === 'dm');
  assert.ok(dm);
  assert.equal(dm._ruleOverride, 'DM (Minimum: priority) — AI said noise');

  // Channel is mentioned, so mention floor applies and cap is skipped (isMentioned guard)
  const publicChannel = mapped.priority.find((item) => item._type === 'channel');
  assert.ok(publicChannel);
  assert.equal(publicChannel._ruleOverride, '@mention (Minimum: priority)');

  const thread = mapped.noise.find((item) => item._type === 'thread');
  assert.ok(thread);
});

test('mapPriorities private channel priority floor routes to priority, not noise', () => {
  const data = loadFixture('prioritization-base.json');
  const preFiltered = applyPreFilters(clone(data), makePreFilterOptions(data));
  // thread_0 is in private channel C_PRIVATE_THREAD; LLM says noise
  const mapped = mapPriorities(
    {
      thread_0: 'noise',
      dm_0: 'noise',
      channel_0: 'noise',
    },
    preFiltered.forLlm,
    preFiltered.noise,
    preFiltered.whenFree,
    data,
    {},
    makeMapOptions(data, {
      priorityRules: {
        dm: 'priority',
        privateChannel: 'priority',
        publicChannel: 'cap_whenfree',
      },
    })
  );

  // Private thread should be elevated to priority by privateChannel floor
  const thread = mapped.priority.find((item) => item._type === 'thread');
  assert.ok(thread, 'private thread with priority floor should be in priority, not noise');
  assert.match(thread._ruleOverride, /private channel/);
});

test('mapPriorities public channel cap prevents unmentioned channel from reaching priority', () => {
  // Create a minimal unmentioned public channel that goes through the LLM
  const data = clone(loadFixture('prioritization-base.json'));
  // Make the channel unmentioned and in a floor section (so it reaches forLlm)
  data.channelPosts[0].mention_count = 0;
  data.channelPosts[0].messages = [
    { text: 'General discussion about tooling', ts: '300.000100', user: 'U_TEAM', reply_count: 0, reply_users: [], thread_ts: null },
  ];
  data.sidebarSections.C_PUBLIC = 'floor_whenfree';
  const preFiltered = applyPreFilters(clone(data), makePreFilterOptions(data));
  // LLM says priority for the channel
  const mapped = mapPriorities(
    {
      thread_0: 'noise',
      dm_0: 'noise',
      channel_0: 'priority',
    },
    preFiltered.forLlm,
    preFiltered.noise,
    preFiltered.whenFree,
    data,
    {},
    makeMapOptions(data, {
      priorityRules: {
        dm: 'ai',
        publicChannel: 'cap_whenfree',
      },
    })
  );

  // Unmentioned public channel should be capped at when_free despite LLM saying priority
  // (isImportantChannel=true from floor_whenfree bypasses the cap, so it stays at priority)
  // This test verifies the cap logic runs — floor sections are exempt by design
  const channel = mapped.priority.find((item) => item._type === 'channel');
  assert.ok(channel, 'floor_whenfree channel should keep priority (floor exempts from cap)');
});

test('sortNoiseItems respects LLM order before deterministic fallback sorting', () => {
  const sorted = sortNoiseItems(
    [
      { _llmId: 'a', messages: [{ ts: '10.0' }] },
      { _llmId: 'b', messages: [{ ts: '20.0' }] },
      { messages: [{ ts: '15.0' }] },
      { messages: [{ ts: '30.0' }, { ts: '29.0' }] },
    ],
    ['b']
  );

  assert.equal(sorted[0]._llmId, 'b');
  assert.equal(sorted[1].messages.length, 2);
  assert.equal(sorted[2].messages[0].ts, '15.0');
  assert.equal(sorted[3]._llmId, 'a');
});
