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
function buildPrompt(items) {
  const vipList = VIPS.map((v) => v.charAt(0).toUpperCase() + v.slice(1)).join(', ');

  const serialized = JSON.stringify(items, null, 0);

  return `You are a Slack message prioritizer for a busy engineer. Classify each item into exactly one category.

VIPs (messages from these people get higher priority): ${vipList}

CONTEXT:
- If I posted or replied in a thread (userReplied=true) and someone then asks a question — even without @mentioning me — treat it as a question directed at me.
- Messages in private channels (isPrivate=true) are inherently higher signal. Never classify private channel messages as "noise".

CATEGORIES:
- "drop": I already replied in this thread (userReplied=true) AND the new messages are just acknowledgments, +1s, emoji reactions, or the conversation continuing without needing me. Do NOT drop if someone asks a question (even indirectly — it's likely directed at me), pushes back on what I said, or needs me to unblock something.
- "act_now": Someone is blocked on me or waiting for my response. A decision needs my specific input. A VIP message that requires a reply. An urgent production issue needing my attention. A question in a thread I participated in. Private channel messages that need a response.
- "when_free": FYIs from VIPs I should be aware of. Non-urgent questions directed at me. Discussions I should weigh in on but nobody is blocked. Private channel FYIs.
- "noise": Bots, automated notifications. General chatter not directed at me. Announcements from non-VIPs. NEVER for private channels.

IMPORTANT: Only use "drop" when userReplied is true. If userReplied is false, classify as one of the other categories.

ITEMS:
${serialized}

Respond with ONLY a JSON object mapping each item's "id" to its category. No explanation, no markdown fences, just the JSON object.`;
}

// ── Call Claude API ──
async function handlePrioritize(payload) {
  const { claudeApiKey } = await chrome.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return { error: 'no_api_key' };

  const prompt = buildPrompt(payload);

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
      return { priorities: JSON.parse(jsonMatch[0]) };
    }
    return { error: 'parse_error', raw: text };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === `${FSLACK}:prioritize`) {
    handlePrioritize(msg.data).then(sendResponse);
    return true; // async response
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
