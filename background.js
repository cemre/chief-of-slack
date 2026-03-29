// background.js — service worker: side panel relay + Claude API prioritization

const FSLACK = 'fslack';

// ── Load user identity settings ──
async function getIdentity() {
  const { selfHandle, userContext } = await chrome.storage.local.get(['selfHandle', 'userContext']);
  const name = selfHandle ? `@${selfHandle}` : null;
  return {
    nameClause: name
      ? `\nMY NAME: ${name}. If someone addresses me by this name, treat it as directed at me.\n`
      : '',
    contextClause: userContext
      ? `You are summarizing Slack for ${name || 'the user'}. ${userContext}. Highlight things relevant to or mentioning them.`
      : (name
        ? `You are summarizing Slack for ${name}. Highlight things relevant to or mentioning them.`
        : 'You are summarizing Slack messages. Highlight things that seem important.'),
    threadContextClause: userContext
      ? `You are summarizing a Slack thread for ${name || 'the user'}. ${userContext}.`
      : (name
        ? `You are summarizing a Slack thread for ${name}.`
        : 'You are summarizing a Slack thread.'),
    userContextClause: userContext
      ? `\nABOUT ME: ${userContext}\nUse my role and background above to judge what's relevant or urgent to me.\n`
      : '',
  };
}

// ── Side panel behavior: open on icon click ──
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── Port management ──
let panelPort = null;
let activeSlackTabId = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  console.log('[fslack bg] side panel connected');
  panelPort = port;

  // Relay messages from side panel → content script
  port.onMessage.addListener(async (msg) => {
    if (!msg?.type?.startsWith(`${FSLACK}:`)) return;
    const tabId = await getSlackTabId();
    console.log(`[fslack bg] panel→content: ${msg.type}, tabId=${tabId}`);
    if (!tabId) {
      try { port.postMessage({ type: `${FSLACK}:error`, error: 'No Slack tab found. Open app.slack.com and try again.' }); } catch {}
      return;
    }
    chrome.tabs.sendMessage(tabId, msg).catch(() => {
      try { port.postMessage({ type: `${FSLACK}:error`, error: 'Could not reach Slack tab. Try refreshing the Slack page.' }); } catch {}
    });
  });

  port.onDisconnect.addListener(() => {
    console.log('[fslack bg] side panel disconnected');
    panelPort = null;
  });
});

// ── Generic relay: content script → side panel ──
// fslack:* messages from content script get forwarded to side panel port
// LLM messages (prioritize, summarize, etc.) are handled directly below
const LLM_TYPES = new Set([
  `${FSLACK}:batchSummarize`,
  `${FSLACK}:prioritize`,
  `${FSLACK}:summarize`,
  `${FSLACK}:summarizeVip`,
  `${FSLACK}:summarizeBotThread`,
  `${FSLACK}:summarizeChannelPost`,
  `${FSLACK}:summarizeThreadReplies`,
  `${FSLACK}:summarizeFullThread`,
  /* DEV_ONLY_START */ `${FSLACK}:anonymize`, /* DEV_ONLY_END */
  `${FSLACK}:setApiKey`,
  `${FSLACK}:getApiKey`,
]);


// ── Track active Slack tab ──
async function getSlackTabId() {
  if (activeSlackTabId) {
    try {
      const tab = await chrome.tabs.get(activeSlackTabId);
      if (tab?.url?.startsWith('https://app.slack.com')) return activeSlackTabId;
    } catch {}
  }
  // Fallback: query for active Slack tab
  const [tab] = await chrome.tabs.query({ url: 'https://app.slack.com/*', active: true, currentWindow: true });
  if (tab) { activeSlackTabId = tab.id; return tab.id; }
  const [anyTab] = await chrome.tabs.query({ url: 'https://app.slack.com/*' });
  if (anyTab) { activeSlackTabId = anyTab.id; return anyTab.id; }
  return null;
}

// ── Keyboard shortcut toggle ──
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-flack') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://app.slack.com')) return;
  // Toggle: if panel port exists, close it; otherwise open
  if (panelPort) {
    try { await chrome.sidePanel.setOptions({ enabled: false, tabId: tab.id }); } catch {}
    // Re-enable for future opens
    setTimeout(() => { chrome.sidePanel.setOptions({ enabled: true, tabId: tab.id }).catch(() => {}); }, 100);
  } else {
    try { await chrome.sidePanel.open({ tabId: tab.id }); } catch {}
  }
});

// ── Build the prioritization prompt ──
function buildPrompt(items, selfName, identity, vipNames) {
  const vipList = (vipNames || []).map((v) => v.charAt(0).toUpperCase() + v.slice(1)).join(', ');

  const serialized = JSON.stringify(items, null, 0);

  return `You are a Slack message prioritizer for a busy engineer. Each item has a pre-generated summary. Classify each into exactly one category.
${identity.nameClause}${identity.userContextClause}
${vipList ? `VIPs (messages from these people get higher priority): ${vipList}` : ''}

SIDEBAR RULES: Items may include a "sidebarSection" field indicating the channel's priority rule:
- "floor_priority" = important channel — classify at least as priority
- "floor_whenfree" = moderately important — classify at least as when_free
- "normal" = no special rule — use your judgment

CONTEXT:
- If I posted or replied in a thread (userReplied=true) and someone asks a question or needs something — treat it as directed at me.
- If userReplied=true and someone answers a question I asked, classify as at least when_free.
- A bare @mention with no question or request should NOT become act_now. Only treat a mention as act_now when it includes a clear ask.

CATEGORIES:
- "drop": I already replied (userReplied=true) AND the new messages are just acknowledgments or chatter not needing me. Do NOT drop if someone asks a question, needs me to unblock something, or answers my question.
- "act_now": Someone is BLOCKED on me or explicitly waiting — direct question, review/approval request, can't proceed without my input.
- "priority": Needs my attention soon — warrants a response but nobody is stuck right now. Use for informational @mentions (FYI, CC).
- "when_free": Something I could usefully respond to or should be aware of, but not urgent.
- "noise": Chatter not directed at me, announcements, automated posts, things that don't need a response.

IMPORTANT: Only use "drop" when userReplied is true. If userReplied is false, classify as one of the other categories.

ITEMS:
${serialized}

For EVERY item, respond with a [category, summary, reason] triple. The summary is a terse
description (under 10 words, lowercase, no period) as "[person] [verb] [thing]" —
e.g. ["act_now", "josh asked you to confirm the deploy", "josh is blocked waiting for deploy confirmation"],
["priority", "rosey asks you to come to bug bash", "direct invite to team event"],
["noise", "brahm shared windows alpha status update", "status update, no action needed"].
The reason should explain WHY you chose this category — what signal drove the decision.
The summary must justify the category — if you can't describe someone waiting on me, it's not act_now.

MENTION RULE: When isMentioned=true and it's a long thread, the summary must cover BOTH what the thread is about AND why I was tagged — e.g. "auth refactor discussion, josh tagged you for review" not just "josh started an auth refactor". The mention is the reason it's elevated, so surface it.

Respond with ONLY a JSON object mapping each item's "id" to its [category, summary, reason] triple, plus a "_noiseOrder" key (array of noise/drop IDs sorted from MOST work-relevant first to LEAST work-relevant last — e.g. engineering discussions before social chatter). No explanation, no markdown fences, just the JSON object.`;
}

// ── Token limit defaults ──
const TOKEN_DEFAULTS = {
  batchSummarize: 4096,
  prioritize: 8192,
  channelSummary: 150,
  vipSummary: 300,
  threadReply: 200,
  fullThread: 300,
  botThread: 200,
  channelPost: 200,
};

// ── Load token limits (user overrides or defaults) ──
async function getTokenLimits() {
  const { tokenLimits } = await chrome.storage.local.get('tokenLimits');
  return { ...TOKEN_DEFAULTS, ...(tokenLimits || {}) };
}

// ── Token usage tracking (read-modify-write to avoid race with service worker startup) ──
async function trackUsage(type, usage) {
  const { tokenUsage = {}, tokenLog = [] } = await chrome.storage.local.get(['tokenUsage', 'tokenLog']);
  if (!tokenUsage[type]) tokenUsage[type] = { calls: 0, inputTokens: 0, outputTokens: 0 };
  tokenUsage[type].calls++;
  tokenUsage[type].inputTokens += usage?.input_tokens || 0;
  tokenUsage[type].outputTokens += usage?.output_tokens || 0;
  // Append timestamped log entry
  tokenLog.push({
    ts: Date.now(),
    type,
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
  });
  // Prune entries older than 48h to prevent unbounded growth
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const pruned = tokenLog.filter((e) => e.ts > cutoff);
  chrome.storage.local.set({ tokenUsage, tokenLog: pruned });
}

// ── Shared Claude API caller with token tracking ──
const MODEL_HAIKU = 'claude-haiku-4-5';
const MODEL_SONNET = 'claude-sonnet-4-5';

// Model per call type: summarization uses Sonnet (signal preservation matters most), rest use Haiku
const MODEL_FOR = {
  batchSummarize: MODEL_SONNET,
};

async function callClaude(apiKey, prompt, limitKey, limits) {
  const model = MODEL_FOR[limitKey] || MODEL_HAIKU;
  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: limits[limitKey] || TOKEN_DEFAULTS[limitKey],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    return { error: `API ${resp.status}: ${errBody.slice(0, 200)}` };
  }

  const data = await resp.json();
  trackUsage(limitKey, data.usage);

  if (data.stop_reason === 'max_tokens') {
    console.warn(`[fslack bg] max_tokens truncation (${limitKey}): ${data.usage?.output_tokens} tokens used`);
    // Try to salvage partial JSON by closing the truncated object
    const text = (data.content?.[0]?.text || '').trim();
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    // Remove trailing incomplete entry (after last complete comma-separated value)
    const lastGoodComma = cleaned.lastIndexOf('],');
    if (lastGoodComma > 0) {
      const salvaged = cleaned.slice(0, lastGoodComma + 1) + '}';
      try {
        const parsed = JSON.parse(salvaged);
        console.log(`[fslack bg] salvaged ${Object.keys(parsed).length} items from truncated response`);
        return { parsed, text, truncated: true };
      } catch {}
    }
    return { error: 'max_tokens', raw: text };
  }

  const text = data.content?.[0]?.text || '';
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('[fslack bg] parse_error — raw LLM response:', text.slice(0, 500));
    return { error: 'parse_error', raw: text };
  }
  try {
    return { parsed: JSON.parse(jsonMatch[0]), text };
  } catch (e) {
    console.warn('[fslack bg] JSON.parse failed:', e.message, '— raw:', jsonMatch[0].slice(0, 500));
    return { error: 'parse_error', raw: text };
  }
}

// ── Retry wrapper for transient API errors (429/529) ──
const MAX_RETRIES = 2;
const RETRY_DELAYS = [1500, 3000]; // ms

async function fetchWithRetry(url, options) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url, options);
    if (resp.ok) return resp;
    if ((resp.status === 529 || resp.status === 429) && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      continue;
    }
    return resp; // non-retryable or exhausted retries
  }
}

// ── Batch summarize: distill raw items into terse summaries for prioritization ──
function buildBatchSummarizePrompt(items, identity) {
  const serialized = JSON.stringify(items, null, 0);
  return `${identity.nameClause}
You are summarizing Slack items so they can be prioritized. For each item, write a 2-3 sentence summary that preserves ALL signals needed for prioritization. Be specific — names, asks, blockers, and deadlines matter. Do not generalize.

Capture:
- WHO is talking, who they're addressing, and the relationship (teammate, manager, external)
- WHAT they need: are they blocked on me, asking a question, requesting review/approval, sharing info, or just chatting?
- WHETHER someone answered a question I asked (if userReplied=true) and what the answer was
- The TOPIC and any urgency signals (deadlines, "ASAP", "blocking", "waiting on")

CRITICAL — @mention handling (isMentioned=true):
When isMentioned=true, you MUST find the exact message that contains my @mention and quote what it says.
The summary MUST answer: "Who mentioned me, and what did they say/ask when they tagged me?"
Do NOT just say "you were mentioned" — find the message text around the @mention and include it.
Example: "julia tagged you asking to review the spacing changes in her top bar PR" NOT "@gem898 is @mentioned in polish-team channel"

"recentContext" = messages I already read (for conversation flow). "newReplies" / "messages" = the unread messages.
Focus on the UNREAD messages, referencing context only to explain what they're responding to.

ITEMS:
${serialized}

Respond with ONLY a JSON object mapping each item's "id" to its summary string.
No explanation, no markdown fences, just the JSON object.`;
}

async function handleBatchSummarize(items) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };

  const identity = await getIdentity();
  const limits = await getTokenLimits();
  const prompt = buildBatchSummarizePrompt(items, identity);

  try {
    const result = await callClaude(claudeApiKey, prompt, 'batchSummarize', limits);
    if (result.error) return result;
    return { summaries: result.parsed };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Call Claude API for prioritization ──
async function handlePrioritize(payload, selfName) {
  const { claudeApiKey, vipNames } = await chrome.storage.local.get(['claudeApiKey', 'vipNames']);
  if (!claudeApiKey) return { error: 'no_api_key' };

  const identity = await getIdentity();
  const limits = await getTokenLimits();
  const prompt = buildPrompt(payload, selfName, identity, vipNames);

  try {
    const result = await callClaude(claudeApiKey, prompt, 'prioritize', limits);
    if (result.error) return result;

    const parsed = result.parsed;
    const noiseOrder = Array.isArray(parsed._noiseOrder) ? parsed._noiseOrder : [];
    delete parsed._noiseOrder;
    const priorities = {};
    const reasons = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (Array.isArray(val) && val.length >= 3) {
        priorities[key] = val[0];
        reasons[key] = val[1];
        reasons[key + '_why'] = val[2];
      } else if (Array.isArray(val) && val.length >= 2) {
        priorities[key] = val[0];
        reasons[key] = val[1];
      } else {
        priorities[key] = val;
      }
    }
    console.log('[fslack bg] LLM response:', JSON.stringify({ priorities, reasons }, null, 2));
    return { priorities, noiseOrder, reasons };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Build single-channel summarization prompt ──
function buildSummarizePrompt(item, identity) {
  const serialized = JSON.stringify(item.messages, null, 0);
  return `${identity.contextClause}

Summarize this Slack channel as 1-3 bullet points. STRICT LIMIT: each bullet MUST be under 8 words.

Channel: #${item.channel}

Format: [first name] [verb] [what]

Examples of CORRECT length:
- "jeff added media support to artifacts"
- "rishi rewrote suggestions prompt"
- "vardhan flagged suggestion quality issues"
- "bot surfaced Reddit post about Dia"

Examples of WRONG length (TOO LONG — never do this):
- "jeff explored adding additional sources to clia artifacts by extending adk-core support for fonts, images, media, and stylesheets"
- "rishi pushed a PR rewriting the combined chat + url suggestions prompt and reports marked quality improvements"

Drop all detail. First names only. No filler.

Each message has a "ts" field. Prefix each bullet with the ts of the most relevant message: "[1773771342.788049] jeff added media support"

MESSAGES:
${serialized}

Respond with ONLY a JSON object:
{"bullets": ["[ts] ...", "[ts] ..."]}
No explanation, no markdown fences, just the JSON object.`;
}

// ── Call Claude API for single-channel summarization ──
async function handleSummarize(item) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };
  const identity = await getIdentity();
  const limits = await getTokenLimits();
  try {
    const result = await callClaude(claudeApiKey, buildSummarizePrompt(item, identity), 'channelSummary', limits);
    if (result.error) return result;
    return { summary: result.parsed };
  } catch (err) { return { error: err.message }; }
}

// ── Build VIP summarization prompt ──
function buildVipSummarizePrompt(item, identity) {
  const serialized = JSON.stringify(item.messages, null, 0);
  return `${identity.contextClause}

Extract 3-5 specific bullet points about what ${item.name} has been saying or doing in Slack.
Each bullet should capture a concrete thing: a specific decision, question, announcement, concern, or piece of work — not a vague category.
Do NOT start bullets with the person's name — just state the thing directly.
Bad: "Announced the new onboarding flow is launching Thursday." (too vague) Good: "New onboarding flow launching Thursday."
Bad: "Josh asked why the /auth endpoint is returning 403s in staging." (uses name) Good: "Asking why /auth returns 403s in staging."
Use direct, terse language. No filler. No names.
If a bullet seems particularly relevant to me (mentions my work, my team, something I should act on), prefix it with "*" — otherwise no prefix.

Each message has "channel" and "ts" fields. For each bullet, prefix it with the channel and ts of the most relevant message in square brackets, like: "[general:1773771342.788049] Asking why /auth returns 403s in staging"
Use the exact channel and ts values from the messages array.

MESSAGES:
${serialized}

Respond with ONLY a JSON object:
{"bullets": ["[channel:ts] ...", "*[channel:ts] relevant bullet", "..."]}
No explanation, no markdown fences, just the JSON object.`;
}

// ── Call Claude API for VIP summarization ──
async function handleVipSummarize(item) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };
  const identity = await getIdentity();
  const limits = await getTokenLimits();
  try {
    const result = await callClaude(claudeApiKey, buildVipSummarizePrompt(item, identity), 'vipSummary', limits);
    if (result.error) return result;
    return { summary: result.parsed };
  } catch (err) { return { error: err.message }; }
}

// ── Build thread reply summarization prompt ──
function buildThreadReplySummarizePrompt(item, identity) {
  const serialized = JSON.stringify(item.replies, null, 0);
  return `${identity.contextClause}

A thread in #${item.channel} has new unread replies. The original post is shown below for context only — the user can already see it, so do NOT repeat or restate it.

Summarize ONLY what's new in the unread replies in 1-2 terse sentences. Focus on:
- What new information, decisions, or actions came from the replies
- Key points from different people (use first names)
- Do NOT restate what the original post said or asked

ORIGINAL POST (already visible, for context only) by ${item.rootUser}: ${item.rootText}

UNREAD REPLIES:
${serialized}

Respond with ONLY a JSON object: {"summary": "..."}
No markdown fences, no explanation.`;
}

// ── Call Claude API for thread reply summarization ──
async function handleThreadReplySummarize(item) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };
  const identity = await getIdentity();
  const limits = await getTokenLimits();
  try {
    const result = await callClaude(claudeApiKey, buildThreadReplySummarizePrompt(item, identity), 'threadReply', limits);
    if (result.error) return result;
    return { summary: result.parsed };
  } catch (err) { return { error: err.message }; }
}

// ── Build full-thread bullet-point summarization prompt ──
function buildFullThreadSummarizePrompt(item, identity) {
  const serialized = JSON.stringify(item.replies, null, 0);
  return `${identity.threadContextClause}

Summarize the ENTIRE thread (root message + replies) as terse bullet points.
Each bullet: "- [FirstName] [verb] [specific thing]"
Use first names only. Be concrete — name the artifact, question, or decision, not a vague category.
Combine multiple small messages from the same person into one bullet when possible.
Maximum 5 bullets. Fewer is better if the thread is short.

Channel: #${item.channel}

ROOT MESSAGE by ${item.rootUser}: ${item.rootText}

REPLIES:
${serialized}

Respond with ONLY a JSON object: {"summary": "- bullet1\\n- bullet2\\n..."}
No markdown fences, no explanation.`;
}

// ── Call Claude API for full-thread bullet summarization ──
async function handleFullThreadSummarize(item) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };
  const identity = await getIdentity();
  const limits = await getTokenLimits();
  try {
    const result = await callClaude(claudeApiKey, buildFullThreadSummarizePrompt(item, identity), 'fullThread', limits);
    if (result.error) return result;
    return { summary: result.parsed };
  } catch (err) { return { error: err.message }; }
}

// ── Build bot thread summarization prompt ──
function buildBotThreadPrompt(item, identity) {
  const serialized = JSON.stringify(item.messages, null, 0);
  return `${identity.contextClause}

A bot posted an automated report in #${item.channel} and people replied in a thread.

Summarize in 2-3 sentences:
- What the issue or item is about (from the bot message)
- Key points from the discussion — who said what, use first names
- Current status: resolved, triaged, or still open

MESSAGES (first is the bot post, rest are replies):
${serialized}

Respond with ONLY a JSON object: {"summary": "..."}
No markdown fences, no explanation.`;
}

// ── Call Claude API for bot thread summarization ──
async function handleBotThreadSummarize(item) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };
  const identity = await getIdentity();
  const limits = await getTokenLimits();
  try {
    const result = await callClaude(claudeApiKey, buildBotThreadPrompt(item, identity), 'botThread', limits);
    if (result.error) return result;
    return { summary: result.parsed };
  } catch (err) { return { error: err.message }; }
}

// ── Build channel post summarization prompt ──
function buildChannelPostPrompt(item, identity) {
  const serialized = JSON.stringify(item.messages, null, 0);
  return `${identity.contextClause}

Summarize what people are discussing in #${item.channel} as exactly 3 bullet points.
Each bullet: "- [first name] [verb] [specific thing]"
Use first names only. Be concrete — name the specific artifact, issue, or topic, not a vague category.
For bot/automated messages (bot_id present), skip the reporter or source name — just describe the issue or topic directly. E.g. "stuck toast notification bug" not "zendesk reported stuck toast notification bug" or "customer reported stuck toast notification bug".
Combine multiple small messages from the same person into one bullet when possible.
If fewer than 3 distinct topics, use fewer bullets.

Each message has a "ts" field. For each bullet, include the ts of the most relevant message in square brackets at the start, like: "- [1773771342.788049] cory shipped the new CLI"

MESSAGES:
${serialized}

Respond with ONLY a JSON object: {"summary": "- [ts] bullet1\\n- [ts] bullet2\\n- [ts] bullet3"}
No markdown fences, no explanation.`;
}

// ── Call Claude API for channel post summarization ──
async function handleChannelPostSummarize(item) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };
  const identity = await getIdentity();
  const limits = await getTokenLimits();
  try {
    const result = await callClaude(claudeApiKey, buildChannelPostPrompt(item, identity), 'channelPost', limits);
    if (result.error) return result;
    return { summary: result.parsed };
  } catch (err) { return { error: err.message }; }
}


/* DEV_ONLY_START */
// ── Call Claude API to build anonymization replacement map ──
async function handleAnonymize(data) {
  console.log(`[fslack bg] anonymize: ${data.names?.length} names, ${data.channels?.length} channels, ${data.snippets?.length} snippets`);
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) { console.warn('[fslack bg] anonymize: no API key'); return { error: 'no_api_key' }; }
  try {
    const startTime = Date.now();
    const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL_HAIKU,
        // ~10 tokens per replacement entry + 50 buffer for JSON overhead
        max_tokens: Math.max(1000, ((data.names?.length || 0) + (data.channels?.length || 0) + (data.snippets?.length || 0)) * 10 + 50),
        messages: [{ role: 'user', content: `Generate a find-and-replace map to anonymize a workplace chat dashboard for demos.

PERSON NAMES (replace with realistic fake first names):
${JSON.stringify(data.names)}

CHANNEL NAMES (replace with plausible generic alternatives):
${JSON.stringify(data.channels)}

SAMPLE TEXT SNIPPETS (scan for any product names, project names, internal tools, or company-specific terms that also need replacing — add those to the map too):
${JSON.stringify(data.snippets)}

Rules:
- Every name/channel above MUST have a replacement
- Add extra entries for any product/project/tool names you spot in the snippets
- Replacements should be realistic but clearly different
- Keep similar length/feel
- Do NOT include generic words, timestamps, or UI labels
- SKIP any entry where the original is 2 characters or shorter

Return ONLY a flat JSON object mapping each original string to its replacement. No explanation, no markdown fences.
Example: {"josh": "Marcus", "deploy-pipeline": "release-flow", "ProjectX": "Beacon"}` }],
      }),
    });
    console.log(`[fslack bg] anonymize: API responded ${resp.status} in ${Date.now() - startTime}ms`);
    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('[fslack bg] anonymize: API error', resp.status, errBody.slice(0, 300));
      return { error: `API ${resp.status}: ${errBody.slice(0, 200)}` };
    }
    const result = await resp.json();
    console.log(`[fslack bg] anonymize: output tokens = ${result.usage?.output_tokens}, stop = ${result.stop_reason}`);
    trackUsage('anonymize', result.usage);
    const text = result.content?.[0]?.text || '';
    console.log('[fslack bg] anonymize: raw response length =', text.length, 'stop =', result.stop_reason);
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    // If truncated, try to salvage by removing the last incomplete entry and closing the object
    if (result.stop_reason === 'end_turn' || result.stop_reason === 'max_tokens') {
      if (!cleaned.endsWith('}')) {
        // Remove trailing incomplete key-value pair and close
        cleaned = cleaned.replace(/,?\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '') + '}';
        console.log('[fslack bg] anonymize: truncated response, salvaged JSON');
      }
    }
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[fslack bg] anonymize: no JSON found in response:', cleaned.slice(0, 300));
      return { error: 'parse_error', raw: text };
    }
    try {
      return { map: JSON.parse(jsonMatch[0]) };
    } catch (parseErr) {
      console.error('[fslack bg] anonymize: JSON.parse failed:', parseErr.message, jsonMatch[0].slice(0, 300));
      return { error: 'parse_error', raw: text };
    }
  } catch (err) {
    console.error('[fslack bg] anonymize: exception', err);
    return { error: err.message };
  }
}
/* DEV_ONLY_END */

// ── Message handler (LLM calls + API key) ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Track active Slack tab from content script messages
  if (sender.tab?.id && sender.tab.url?.startsWith('https://app.slack.com')) {
    activeSlackTabId = sender.tab.id;
  }


  // Relay fslack:* messages from content script → side panel
  if (msg?.type?.startsWith(`${FSLACK}:`) && !LLM_TYPES.has(msg.type) && sender.tab) {
    console.log(`[fslack bg] content→panel: ${msg.type}, panelPort=${!!panelPort}`);
    if (panelPort) {
      try { panelPort.postMessage(msg); } catch {}
    }
    return false;
  }

  // LLM handlers (from side panel or content script)
  if (msg.type === `${FSLACK}:batchSummarize`) {
    handleBatchSummarize(msg.data).then(sendResponse);
    return true;
  }
  if (msg.type === `${FSLACK}:prioritize`) {
    handlePrioritize(msg.data, msg.selfName).then(sendResponse);
    return true; // async response
  }
  if (msg.type === `${FSLACK}:summarize`) {
    handleSummarize(msg.data).then(sendResponse);
    return true;
  }
  if (msg.type === `${FSLACK}:summarizeVip`) {
    handleVipSummarize(msg.data).then(sendResponse);
    return true;
  }
  if (msg.type === `${FSLACK}:summarizeBotThread`) {
    handleBotThreadSummarize(msg.data).then(sendResponse);
    return true;
  }
  if (msg.type === `${FSLACK}:summarizeChannelPost`) {
    handleChannelPostSummarize(msg.data).then(sendResponse);
    return true;
  }
  if (msg.type === `${FSLACK}:summarizeThreadReplies`) {
    handleThreadReplySummarize(msg.data).then(sendResponse);
    return true;
  }
  if (msg.type === `${FSLACK}:summarizeFullThread`) {
    handleFullThreadSummarize(msg.data).then(sendResponse);
    return true;
  }
  /* DEV_ONLY_START */
  if (msg.type === `${FSLACK}:anonymize`) {
    handleAnonymize(msg.data).then(sendResponse);
    return true;
  }
  /* DEV_ONLY_END */
  if (msg.type === `${FSLACK}:setApiKey`) {
    chrome.storage.local.set({ claudeApiKey: msg.key }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === `${FSLACK}:getApiKey`) {
    chrome.storage.local.get('claudeApiKey', (result) => {
      sendResponse({ key: result.claudeApiKey || null });
    });
    return true;
  }
  if (msg.type === `${FSLACK}:openSettings`) {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true });
      }
    });
    return true;
  }
  // Navigate existing Slack tab (from sidepanel link clicks)
  if (msg.type === `${FSLACK}:navigateSlackTab`) {
    getSlackTabId().then((tabId) => {
      if (tabId) {
        chrome.tabs.update(tabId, { url: msg.url, active: true });
      } else {
        chrome.tabs.create({ url: msg.url });
      }
    });
    return false;
  }
});
