// background.js — service worker: icon toggle + Claude API prioritization

const FSLACK = 'fslack';
const VIPS = ['josh', 'tara', 'dustin', 'brahm', 'rosey', 'samir', 'jane'];

// ── Icon click toggles the overlay ──
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url?.startsWith('https://app.slack.com')) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        document.getElementById('fslack-host')?.__fslackToggle?.();
      },
    });
  } catch {
    // Tab not ready or no permission — ignore
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

CATEGORIES:
- "drop": I already replied in this thread (userReplied=true) AND the new messages are just acknowledgments, +1s, emoji reactions, or the conversation continuing without needing me. Do NOT drop if someone asks a question or needs me to unblock something.
- "act_now": Someone is BLOCKED on me or explicitly waiting — direct question, review/approval request, can't proceed without my input. Also use act_now when someone @mentions me asking me to confirm, verify, check, or weigh in on something — they're waiting for my response.
- "priority": Needs my attention soon — warrants a response but nobody is stuck right now. Use for @mentions that are purely informational (e.g. FYI, CC, looping me in) where nobody is waiting on me.
- "when_free": Something I could usefully respond to or should be aware of, but not urgent.
- "noise": Chatter not directed at me, announcements, automated posts, things that don't need a response.

IMPORTANT: Only use "drop" when userReplied is true. If userReplied is false, classify as one of the other categories.

ITEMS:
${serialized}

Respond with ONLY a JSON object mapping each item's "id" to its category, plus a "_noiseOrder" key: an array of all noise/drop item IDs sorted from most work-relevant (informational announcements, decisions, discussions in work channels) to least relevant (social banter, #random chatter, celebrations, memes, off-topic). No explanation, no markdown fences, just the JSON object.`;
}

// ── Call Claude API ──
async function handlePrioritize(payload, selfName) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };

  const prompt = buildPrompt(payload, selfName);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
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
      return { priorities: parsed, noiseOrder };
    }
    return { error: 'parse_error', raw: text };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Build single-channel summarization prompt ──
function buildSummarizePrompt(item) {
  const serialized = JSON.stringify(item.messages, null, 0);
  return `Summarize what happened in this Slack channel in 1-3 terse clauses, and pick the best type.

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
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
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
  return `Extract 3-5 specific bullet points about what ${item.name} has been saying or doing in Slack.
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
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
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
  return `A thread in #${item.channel} has new unread replies. The original message and replies are below.

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
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
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
  return `A bot posted an automated report in #${item.channel} and people replied in a thread.

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
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
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

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
