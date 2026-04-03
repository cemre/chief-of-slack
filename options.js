// options.js — Settings page for Slack Attention Firewall

const apiKeyInput = document.getElementById('api-key');
const toggleKeyBtn = document.getElementById('toggle-key');
const userContextInput = document.getElementById('user-context');
const charCount = document.getElementById('char-count');
const openInBrowserCheckbox = document.getElementById('open-in-browser');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

// ── Token limit defaults (editable subset of background.js TOKEN_DEFAULTS) ──
const TOKEN_DEFAULTS = {
  prioritize: 8192,
  channelSummary: 200,
  vipSummary: 300,
  threadSummary: 300,
};

const TOKEN_LABELS = {
  prioritize: 'Prioritization',
  channelSummary: 'Channel Summary',
  vipSummary: 'VIP Summary',
  threadSummary: 'Thread Summary',
};

// ── Default prompt templates (must match background.js) ──
const PROMPT_DEFAULTS = {
  prioritize: `Slack prioritizer for a busy engineer. Classify each item.
\${identity.nameClause}\${identity.userContextClause}
\${vipList ? \`VIPs: \${vipList}\` : ''}

CATEGORIES (be conservative — when in doubt, go lower):
- "act_now": someone EXPLICITLY asked me a question, requested my review, or is waiting for MY response. There must be a direct ask addressed to me.
- "priority": needs my attention soon, but nobody is stuck on me specifically
- "when_free": worth reading — relevant to my work or area
- "noise": doesn't need my attention
- "drop": ONLY when userReplied=true and new messages are just acks/chatter

CRITICAL — these are NOT act_now:
- A bug that affects me but nobody asked me to fix it → noise or when_free
- Someone is blocked, but not blocked on ME specifically → when_free at most
- A discussion in my area where someone else was explicitly asked (e.g., "@jlo what do you think?") → noise unless I'm also asked
- A reply on a thread I started, but just informational / not asking me anything → when_free at most
- An announcement, even about something I care about → when_free

CRITICAL — these are NOT priority:
- General product ideas or feature proposals, even from VIPs → when_free
- Announcements, launches, or status updates with no ask → when_free
- Dogfooding feedback or bug reports unless I'm asked to act → when_free
- Someone else's conversation that's merely in a channel I follow → when_free or noise

KEY TEST: Before classifying act_now, ask: "Who specifically is waiting for MY response?" If the answer is nobody, it's not act_now.
Before classifying priority, ask: "Do I need to do something about this soon?" If it's just interesting/relevant, it's when_free.

If isMentioned=true without a clear ask → priority (not act_now).
If userReplied=true and someone asks a question → treat as directed at me.
If sidebarSection="Minimum: Priority" → classify at least as priority.
If sidebarSection="Minimum: Relevant" → classify at least as when_free.

ITEMS:
\${serialized}

Output a JSON object mapping each "id" to a [reason, category, summary] triple.

REASON comes first — it drives the classification. Write the reason, then pick the category that follows.

The reason must answer: "why does this belong here?" Be specific to my work.
- act_now reasons must name WHO is waiting for me and WHAT they need.
- when_free reasons must name the specific connection to my work. NOT "relevant to your area" — instead "Atlassian signup analysis, directly comparable to Dia signup flow".
- If isMentioned in a long thread, the summary must say what the thread is about AND why I was tagged.

Summary: under 10 words, lowercase, no period, "[person] [verb] [thing]".

Examples:
["josh asked me directly to confirm deploy", "act_now", "josh asked to confirm the deploy"],
["direct invite to team event requiring response", "priority", "rosey asks to come to bug bash"],
["pod teammate shipped menu bar redesign I'll review", "when_free", "matthew merged menu bar redesign PR"],
["windows team update, different product area", "noise", "brahm shared windows alpha status update"],
["bug affects my experience but nobody asked me to fix", "noise", "christine reported morning brief bug"],
["someone blocked but asked someone else for help", "noise", "patrick asks jlo about model migration"],
["reply on my thread but just informational", "noise", "jane asked rishi about cpu issue on my post"]

Also include "_noiseOrder": array of noise/drop IDs sorted most-relevant-first.
Return ONLY the JSON object, no markdown fences.`,

  batchSummarize: `\${identity.nameClause}
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
\${serialized}

Respond with ONLY a JSON object mapping each item's "id" to its summary string.
No explanation, no markdown fences, just the JSON object.`,

  channelSummary: `\${identity.contextClause}

Summarize what's being discussed in #\${item.channel} as up to 3 bullet points.
Each bullet: "- [first name] [verb] [specific thing]"
STRICT LIMIT: each bullet MUST be under 8 words.
Use first names only. Be concrete — name the specific artifact, issue, or topic, not a vague category.
For bot/automated messages (bot_id present), skip the reporter or source name — just describe the issue or topic directly. E.g. "stuck toast notification bug" not "zendesk reported stuck toast notification bug".
Combine multiple small messages from the same person into one bullet when possible.
Fewer bullets is better if fewer distinct topics exist.

Each message has a "ts" field. For each bullet, include the ts of the most relevant message in square brackets at the start, like: "- [1773771342.788049] cory shipped the new CLI"

MESSAGES:
\${serialized}

Respond with ONLY a JSON object: {"summary": "- [ts] bullet1\\n- [ts] bullet2\\n..."}
No markdown fences, no explanation.`,

  vipSummary: `\${identity.contextClause}

Extract 3-5 specific bullet points about what \${item.name} has been saying or doing in Slack.
Each bullet should capture a concrete thing: a specific decision, question, announcement, concern, or piece of work — not a vague category.
Do NOT start bullets with the person's name — just state the thing directly.
Bad: "Announced the new onboarding flow is launching Thursday." (too vague) Good: "New onboarding flow launching Thursday."
Bad: "Josh asked why the /auth endpoint is returning 403s in staging." (uses name) Good: "Asking why /auth returns 403s in staging."
Use direct, terse language. No filler. No names.
If a bullet seems particularly relevant to me (mentions my work, my team, something I should act on), prefix it with "*" — otherwise no prefix.

Each message has "channel" and "ts" fields. For each bullet, prefix it with the channel and ts of the most relevant message in square brackets, like: "[general:1773771342.788049] Asking why /auth returns 403s in staging"
Use the exact channel and ts values from the messages array.

MESSAGES:
\${serialized}

Respond with ONLY a JSON object:
{"bullets": ["[channel:ts] ...", "*[channel:ts] relevant bullet", "..."]}
No explanation, no markdown fences, just the JSON object.`,

  threadSummary: `Thread summary prompt — two modes based on input:

BOT THREAD (when rootUser is absent):
\${identity.contextClause}

A bot posted an automated report in #\${item.channel} and people replied in a thread.

Summarize in 2-3 sentences:
- What the issue or item is about (from the bot message)
- Key points from the discussion — who said what, use first names
- Current status: resolved, triaged, or still open

MESSAGES (first is the bot post, rest are replies):
\${serialized}

Respond with ONLY a JSON object: {"summary": "..."}
No markdown fences, no explanation.

---

FULL THREAD (when rootUser is present):
\${identity.threadContextClause}

Summarize the ENTIRE thread (root message + replies) as terse bullet points.
Each bullet: "- [FirstName] [verb] [specific thing]"
Use first names only. Be concrete — name the artifact, question, or decision, not a vague category.
Combine multiple small messages from the same person into one bullet when possible.
Maximum 5 bullets. Fewer is better if the thread is short.

Channel: #\${item.channel}

ROOT MESSAGE by \${item.rootUser}: \${item.rootText}

REPLIES:
\${serialized}

Respond with ONLY a JSON object: {"summary": "- bullet1\\n- bullet2\\n..."}
No markdown fences, no explanation.`,
};

const PROMPT_LABELS = {
  prioritize: 'Prioritization',
  batchSummarize: 'Batch Summarize',
  channelSummary: 'Channel Summary',
  vipSummary: 'VIP Summary',
  threadSummary: 'Thread Summary',
};

const PROMPT_HINTS = {
  prioritize: 'Classifies items into act_now / priority / when_free / noise / drop. Variables: ${serialized}, ${identity.nameClause}, ${identity.userContextClause}, ${vipList}',
  batchSummarize: 'Pre-processes raw Slack items into summaries for prioritization. Variables: ${serialized}, ${identity.nameClause}',
  channelSummary: 'Summarizes channel posts as terse bullets. Variables: ${serialized}, ${identity.contextClause}, ${item.channel}',
  vipSummary: 'Summarizes what a VIP person has been doing. Variables: ${serialized}, ${identity.contextClause}, ${item.name}',
  threadSummary: 'Summarizes threads (both bot threads and human threads). Variables: ${serialized}, ${identity.contextClause}, ${identity.threadContextClause}, ${item.channel}, ${item.rootUser}, ${item.rootText}',
};

// ── Load saved settings ──
const RULE_GROUPS = [
  { group: 'AI-prioritized (with a minimum)', options: [
    { value: 'normal', label: 'No minimum' },
    { value: 'floor_whenfree', label: 'At least Relevant' },
    { value: 'floor_priority', label: 'At least Priority' },
  ]},
  { group: 'Fixed rule (skip AI)', options: [
    { value: 'high_volume', label: 'Only show if 5+ replies' },
    { value: 'hard_noise', label: 'Always Noise' },
    { value: 'skip', label: 'Exclude entirely' },
  ]},
];

function buildRuleSelect(currentRule) {
  return RULE_GROUPS.map((g) =>
    `<optgroup label="${g.group}">${g.options.map((o) =>
      `<option value="${o.value}"${o.value === currentRule ? ' selected' : ''}>${o.label}</option>`
    ).join('')}</optgroup>`
  ).join('');
}

chrome.storage.local.get(['claudeApiKey', 'userContext', 'openInBrowser', 'vipNames', 'sidebarSectionNames', 'sidebarSectionChannels', 'sidebarTierMap', 'tokenLimits', 'tokenUsage', 'tokenLog', 'priorityRules', 'customPrompts'], (result) => {
  if (result.claudeApiKey) apiKeyInput.value = result.claudeApiKey;
  if (result.userContext) userContextInput.value = result.userContext;
  charCount.textContent = `${(result.userContext || '').length}/400`;
  openInBrowserCheckbox.checked = result.openInBrowser !== false; // default true

  // Show VIP chips
  const vipList = document.getElementById('vip-list');
  const names = result.vipNames || [];
  if (names.length) {
    vipList.innerHTML = names.map((n) => `<span class="vip-chip">${n}</span>`).join('');
  }

  // Restore priority rules
  const savedPriorityRules = result.priorityRules || {};
  for (const select of document.querySelectorAll('#priority-rules select[data-rule]')) {
    const saved = savedPriorityRules[select.dataset.rule];
    if (saved) select.value = saved;
  }

  // Render sidebar section rules
  const sectionNames = result.sidebarSectionNames || [];
  const sectionChannels = result.sidebarSectionChannels || {};
  const savedRules = result.sidebarTierMap || {};
  const defaultRules = {}; // all sections default to 'normal'
  const infoSvg = `<svg class="section-info-icon" viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><text x="8" y="12" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">?</text></svg>`;
  if (sectionNames.length) {
    const tierMapEl = document.getElementById('tier-map');
    tierMapEl.innerHTML = '';
    // Sort: sections with a non-normal rule first, then alphabetical
    const sorted = [...sectionNames].sort((a, b) => {
      const aRule = savedRules[a.toLowerCase()] || defaultRules[a.toLowerCase()] || 'normal';
      const bRule = savedRules[b.toLowerCase()] || defaultRules[b.toLowerCase()] || 'normal';
      const aHasRule = aRule !== 'normal' ? 0 : 1;
      const bHasRule = bRule !== 'normal' ? 0 : 1;
      if (aHasRule !== bHasRule) return aHasRule - bHasRule;
      return a.localeCompare(b);
    });
    for (const name of sorted) {
      const key = name.toLowerCase();
      if (key === 'dms' || key === 'direct messages') continue;
      const currentRule = savedRules[key] || defaultRules[key] || 'normal';
      const channels = sectionChannels[key];
      const infoIcon = channels && channels.length ? `<span class="section-info-wrap" title="${channels.map(c => '#' + c).join(', ')}">${infoSvg}</span>` : '';
      const row = document.createElement('div');
      row.className = 'tier-row';
      row.innerHTML = `<span class="section-name">${name}${infoIcon}</span><select data-section="${key}">${buildRuleSelect(currentRule)}</select>`;
      tierMapEl.appendChild(row);
    }

  }
  // Render bot-only rule (lives under Message Type section in HTML, but stored in sidebarTierMap)
  const botSelect = document.querySelector('select[data-section="__bot_only"]');
  if (botSelect) {
    const botRule = savedRules['__bot_only'] || 'high_volume';
    botSelect.innerHTML = buildRuleSelect(botRule);
  }

  // Render token table
  const limits = { ...TOKEN_DEFAULTS, ...(result.tokenLimits || {}) };
  const usage = result.tokenUsage || {};
  const tbody = document.querySelector('#token-table tbody');
  for (const [key, defaultVal] of Object.entries(TOKEN_DEFAULTS)) {
    const u = usage[key] || { calls: 0, inputTokens: 0, outputTokens: 0 };
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${TOKEN_LABELS[key]}</td>
      <td><input type="number" data-key="${key}" value="${limits[key]}" min="50" max="16384" step="50" placeholder="${defaultVal}"></td>
      <td class="usage">${u.calls}</td>
      <td class="usage">${u.inputTokens.toLocaleString()}</td>
      <td class="usage">${u.outputTokens.toLocaleString()}</td>`;
    tbody.appendChild(tr);
  }

  // Compute 24h cost from log
  const log = result.tokenLog || [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = log.filter((e) => e.ts > cutoff);
  // Haiku pricing: $0.80/M input, $4.00/M output
  const totalIn = recent.reduce((s, e) => s + e.inputTokens, 0);
  const totalOut = recent.reduce((s, e) => s + e.outputTokens, 0);
  const cost24h = (totalIn * 0.80 + totalOut * 4.00) / 1_000_000;
  document.getElementById('cost-24h').textContent =
    `Last 24h: ${recent.length} calls, ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out — $${cost24h.toFixed(4)}`;

  // Render prompt editors
  const savedPrompts = result.customPrompts || {};
  const promptContainer = document.getElementById('prompt-editors');
  for (const [key, defaultText] of Object.entries(PROMPT_DEFAULTS)) {
    const currentText = savedPrompts[key] || '';
    const isCustom = !!savedPrompts[key];
    const div = document.createElement('div');
    div.className = 'prompt-editor';
    div.innerHTML = `
      <div class="prompt-header">
        <label>${PROMPT_LABELS[key]}</label>
        <span class="prompt-status ${isCustom ? 'custom' : ''}">${isCustom ? 'customized' : 'default'}</span>
        <button class="reset-prompt-btn" data-prompt="${key}" ${!isCustom ? 'disabled' : ''}>Reset</button>
      </div>
      <p class="hint">${PROMPT_HINTS[key]}</p>
      <textarea data-prompt="${key}" rows="6" placeholder="Using default prompt...">${isCustom ? currentText : ''}</textarea>`;
    promptContainer.appendChild(div);
  }

  // Reset individual prompt
  promptContainer.addEventListener('click', (e) => {
    if (!e.target.matches('.reset-prompt-btn')) return;
    const key = e.target.dataset.prompt;
    const textarea = promptContainer.querySelector(`textarea[data-prompt="${key}"]`);
    textarea.value = '';
    e.target.disabled = true;
    e.target.previousElementSibling.textContent = 'default';
    e.target.previousElementSibling.className = 'prompt-status';
  });
});

// ── Char counter ──
userContextInput.addEventListener('input', () => {
  charCount.textContent = `${userContextInput.value.length}/400`;
});

// ── Toggle key visibility ──
toggleKeyBtn.addEventListener('click', () => {
  const showing = apiKeyInput.type === 'text';
  apiKeyInput.type = showing ? 'password' : 'text';
  toggleKeyBtn.textContent = showing ? 'eye' : 'hide';
});

// ── Save ──
saveBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  const context = userContextInput.value.trim();

  // Collect priority rules
  const priorityRules = {};
  for (const select of document.querySelectorAll('#priority-rules select[data-rule]')) {
    priorityRules[select.dataset.rule] = select.value;
  }

  // Collect sidebar tier mapping
  const sidebarTierMap = {};
  for (const select of document.querySelectorAll('#tier-map select[data-section]')) {
    if (select.value) sidebarTierMap[select.dataset.section] = select.value;
  }

  // Collect token limits from inputs
  const tokenLimits = {};
  for (const input of document.querySelectorAll('#token-table input[data-key]')) {
    const val = parseInt(input.value, 10);
    if (!isNaN(val) && val > 0) tokenLimits[input.dataset.key] = val;
  }

  // Collect custom prompts (only save non-empty ones)
  const customPrompts = {};
  for (const textarea of document.querySelectorAll('#prompt-editors textarea[data-prompt]')) {
    const val = textarea.value.trim();
    if (val) customPrompts[textarea.dataset.prompt] = val;
  }

  chrome.storage.local.set({
    claudeApiKey: key,
    userContext: context,
    openInBrowser: openInBrowserCheckbox.checked,
    priorityRules,
    sidebarTierMap,
    tokenLimits,
    customPrompts,
  }, () => {
    saveStatus.textContent = 'Saved — go back to the Slack tab and refresh to see changes.';
    setTimeout(() => { saveStatus.textContent = ''; }, 10000);
  });
});

// ── Reset usage stats ──
document.getElementById('reset-usage').addEventListener('click', () => {
  chrome.storage.local.set({ tokenUsage: {}, tokenLog: [] }, () => {
    for (const td of document.querySelectorAll('#token-table .usage')) {
      td.textContent = '0';
    }
    document.getElementById('cost-24h').textContent = 'Last 24h: 0 calls — $0.0000';
  });
});
