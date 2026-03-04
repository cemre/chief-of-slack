// background.js — service worker: side panel relay + Claude API prioritization

const FSLACK = 'fslack';
const VIPS = ['josh', 'tara', 'dustin', 'brahm', 'rosey', 'samir', 'jane'];

// ── Side panel behavior: open on icon click ──
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── Port management ──
let panelPort = null;
let activeSlackTabId = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  panelPort = port;

  // Relay messages from side panel → content script
  port.onMessage.addListener(async (msg) => {
    if (!msg?.type?.startsWith(`${FSLACK}:`)) return;
    const tabId = await getSlackTabId();
    if (!tabId) return;
    try {
      chrome.tabs.sendMessage(tabId, msg);
    } catch {}
  });

  port.onDisconnect.addListener(() => {
    panelPort = null;
  });
});

// ── Generic relay: content script → side panel ──
// fslack:* messages from content script get forwarded to side panel port
// LLM messages (prioritize, summarize, etc.) are handled directly below
const LLM_TYPES = new Set([
  `${FSLACK}:prioritize`,
  `${FSLACK}:summarize`,
  `${FSLACK}:summarizeVip`,
  `${FSLACK}:summarizeBotThread`,
  `${FSLACK}:summarizeThreadReplies`,
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
function buildPrompt(items, selfName) {
  const vipList = VIPS.map((v) => v.charAt(0).toUpperCase() + v.slice(1)).join(', ');

  const serialized = JSON.stringify(items, null, 0);

  const nameClause = `\nMY NAME: Gem / Cemre / @gem. If someone addresses me by any of these names, treat it as directed at me.\n`;

  return `You are a Slack message prioritizer for a busy engineer. Classify each item into exactly one category.
${nameClause}
VIPs (messages from these people get higher priority): ${vipList}

CONTEXT:
- If I posted or replied in a thread (userReplied=true) and someone then asks a question — even without @mentioning me — treat it as a question directed at me.
- If I asked a question in my reply (userReplied=true) and someone answers it or gives a status update in response, classify as at least when_free — I want to see the answer to my question.
- A bare @mention with no question or explicit request (e.g. "thanks @gem" or a signature "@gem") should NOT become act_now. Only treat a mention as act_now when it includes a question mark or clear ask ("@gem can you...", "@gem do you know...?").

CATEGORIES:
- "drop": I already replied in this thread (userReplied=true) AND the new messages are just acknowledgments, +1s, emoji reactions, or the conversation continuing without needing me. Do NOT drop if someone asks a question, needs me to unblock something, or is answering a question I asked.
- "act_now": Someone is BLOCKED on me or explicitly waiting — direct question, review/approval request, can't proceed without my input. Also use act_now when someone @mentions me AND asks me to confirm, verify, check, or weigh in on something — they're waiting for my response, not just tagging me for visibility.
- "priority": Needs my attention soon — warrants a response but nobody is stuck right now. Use for @mentions that are purely informational (e.g. FYI, CC, looping me in) where nobody is waiting on me.
- "when_free": Something I could usefully respond to or should be aware of, but not urgent.
- "noise": Chatter not directed at me, announcements, automated posts, things that don't need a response.

IMPORTANT: Only use "drop" when userReplied is true. If userReplied is false, classify as one of the other categories.

ITEMS:
${serialized}

For every act_now or priority item, also provide a terse reason (under 10 words,
lowercase, no period) as "[person] [verb] [thing]" — e.g. "josh asked you to confirm
the deploy", "brahm is blocked on your review", "ori asked you to read the RFC".
Always describe the specific action/ask, even for DMs and @mentions.
Collect these in a "_reasons" key mapping item IDs to reason strings.

Respond with ONLY a JSON object mapping each item's "id" to its category, plus a "_noiseOrder" key (array of noise/drop IDs sorted by work-relevance) and a "_reasons" key (map of act_now/priority IDs to reason strings). No explanation, no markdown fences, just the JSON object.`;
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

// ── Call Claude API ──
async function handlePrioritize(payload, selfName) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };

  const prompt = buildPrompt(payload, selfName);

  try {
    const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1280,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      return { error: `API ${resp.status}: ${errBody.slice(0, 200)}` };
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';

    // Parse JSON from response (strip any accidental markdown fences)
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const noiseOrder = Array.isArray(parsed._noiseOrder) ? parsed._noiseOrder : [];
      delete parsed._noiseOrder;
      const reasons = (parsed._reasons && typeof parsed._reasons === 'object') ? parsed._reasons : {};
      delete parsed._reasons;
      return { priorities: parsed, noiseOrder, reasons };
    }
    return { error: 'parse_error', raw: text };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Build single-channel summarization prompt ──
function buildSummarizePrompt(item) {
  const serialized = JSON.stringify(item.messages, null, 0);
  return `You are summarizing Slack for Cemre (also known as "gem"), a Head of Product Management & Insights. Highlight things relevant to or mentioning them.

Summarize what happened in this Slack channel in 1-3 terse clauses, and pick the best type.

Channel: #${item.channel}

Types:
- "key_update": intentional announcement or update from a person
- "decision": a decision was made
- "heated_discussion": back-and-forth debate
- "needs_attention": something requires action
- "feedback_digest": user feedback, bug reports, or support tickets (e.g. Zendesk)
- "activity_digest": automated activity feed (e.g. Linear, GitHub, Jira)

FORMAT: Write the summary as short clauses joined by semicolons.
Each clause = [first name] [action verb] [specific thing].
Name the actual artifact, outcome, or content — not a vague category.

Bad: "Matthew is coordinating end-of-week updates"
Bad: "Cory introducing a new CLI tool and flagging policy updates"
Good: "matthew merged a PR that fixes auth timeouts; cory shipped an org-admin CLI for provisioning and flagged that golden-triangle needs legal/policy sign-off"

For automated channels, name the specific repos, tickets, or people involved.
Omit filler. Use first names only. No passive voice.

MESSAGES:
${serialized}

Respond with ONLY a JSON object:
{"relevant": true, "type": "...", "summary": "..."}
No explanation, no markdown fences, just the JSON object.`;
}

// ── Call Claude API for single-channel summarization ──
async function handleSummarize(item) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };

  const prompt = buildSummarizePrompt(item);

  try {
    const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      return { error: `API ${resp.status}: ${errBody.slice(0, 200)}` };
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return { summary: JSON.parse(jsonMatch[0]) };
    }
    return { error: 'parse_error', raw: text };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Build VIP summarization prompt ──
function buildVipSummarizePrompt(item) {
  const serialized = JSON.stringify(item.messages, null, 0);
  return `You are summarizing Slack for Cemre (also known as "gem"), a Head of Product Management & Insights. Highlight things relevant to or mentioning them.

Extract 3-5 specific bullet points about what ${item.name} has been saying or doing in Slack.
Each bullet should capture a concrete thing: a specific decision, question, announcement, concern, or piece of work — not a vague category.
Do NOT start bullets with the person's name — just state the thing directly.
Bad: "Announced the new onboarding flow is launching Thursday." (too vague) Good: "New onboarding flow launching Thursday."
Bad: "Josh asked why the /auth endpoint is returning 403s in staging." (uses name) Good: "Asking why /auth returns 403s in staging."
Use direct, terse language. No filler. No names.
If there are fewer than 2 substantive messages, return {"relevant": false}.

MESSAGES:
${serialized}

Respond with ONLY a JSON object:
{"relevant": true, "bullets": ["...", "...", "..."]} or {"relevant": false}
No explanation, no markdown fences, just the JSON object.`;
}

// ── Call Claude API for VIP summarization ──
async function handleVipSummarize(item) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };

  const prompt = buildVipSummarizePrompt(item);

  try {
    const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      return { error: `API ${resp.status}: ${errBody.slice(0, 200)}` };
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return { summary: JSON.parse(jsonMatch[0]) };
    }
    return { error: 'parse_error', raw: text };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Build thread reply summarization prompt ──
function buildThreadReplySummarizePrompt(item) {
  const serialized = JSON.stringify(item.replies, null, 0);
  return `You are summarizing Slack for Cemre (also known as "gem"), a Head of Product Management & Insights. Highlight things relevant to or mentioning them.

A thread in #${item.channel} has new unread replies. The original message and replies are below.

Summarize the unread replies in 1-2 terse sentences. Focus on:
- What was discussed or decided
- Key points from different people (use first names)
- Current status if relevant

ORIGINAL POST by ${item.rootUser}: ${item.rootText}

UNREAD REPLIES:
${serialized}

Respond with ONLY a JSON object: {"summary": "..."}
No markdown fences, no explanation.`;
}

// ── Call Claude API for thread reply summarization ──
async function handleThreadReplySummarize(item) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };

  try {
    const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: buildThreadReplySummarizePrompt(item) }],
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      return { error: `API ${resp.status}: ${errBody.slice(0, 200)}` };
    }
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { summary: JSON.parse(jsonMatch[0]) };
    return { error: 'parse_error', raw: text };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Build bot thread summarization prompt ──
function buildBotThreadPrompt(item) {
  const serialized = JSON.stringify(item.messages, null, 0);
  return `You are summarizing Slack for Cemre (also known as "gem"), a Head of Product Management & Insights. Highlight things relevant to or mentioning them.

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

  try {
    const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: buildBotThreadPrompt(item) }],
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      return { error: `API ${resp.status}: ${errBody.slice(0, 200)}` };
    }
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { summary: JSON.parse(jsonMatch[0]) };
    return { error: 'parse_error', raw: text };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Message handler (LLM calls + API key) ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Track active Slack tab from content script messages
  if (sender.tab?.id && sender.tab.url?.startsWith('https://app.slack.com')) {
    activeSlackTabId = sender.tab.id;
  }

  // Relay fslack:* messages from content script → side panel
  if (msg?.type?.startsWith(`${FSLACK}:`) && !LLM_TYPES.has(msg.type) && sender.tab) {
    if (panelPort) {
      try { panelPort.postMessage(msg); } catch {}
    }
    return false;
  }

  // LLM handlers (from side panel or content script)
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
  if (msg.type === `${FSLACK}:summarizeThreadReplies`) {
    handleThreadReplySummarize(msg.data).then(sendResponse);
    return true;
  }
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
});
