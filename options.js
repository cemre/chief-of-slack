// options.js — Settings page for Slack Attention Firewall

const apiKeyInput = document.getElementById('api-key');
const toggleKeyBtn = document.getElementById('toggle-key');
const userContextInput = document.getElementById('user-context');
const charCount = document.getElementById('char-count');
const openInBrowserCheckbox = document.getElementById('open-in-browser');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

// ── Token limit defaults (must match background.js TOKEN_DEFAULTS) ──
const TOKEN_DEFAULTS = {
  prioritize: 800,
  channelSummary: 150,
  vipSummary: 300,
  threadReply: 200,
  fullThread: 300,
  botThread: 200,
  channelPost: 200,
};

const TOKEN_LABELS = {
  prioritize: 'Prioritization',
  channelSummary: 'Channel Summary',
  vipSummary: 'VIP Summary',
  threadReply: 'Thread Reply',
  fullThread: 'Full Thread',
  botThread: 'Bot Thread',
  channelPost: 'Channel Post',
};

// ── Load saved settings ──
const RULE_GROUPS = [
  { group: 'AI decides, with a floor', options: [
    { value: 'floor_priority', label: 'Priority' },
    { value: 'floor_whenfree', label: 'Floor: Relevant' },
    { value: 'normal', label: 'Floor: Noise' },
  ]},
  { group: 'Fixed rule', options: [
    { value: 'high_volume', label: 'High-volume (5+ replies → Relevant)' },
    { value: 'hard_noise', label: 'Noise' },
    { value: 'skip', label: 'Exclude' },
  ]},
];

chrome.storage.local.get(['claudeApiKey', 'userContext', 'openInBrowser', 'vipNames', 'sidebarSectionNames', 'sidebarTierMap', 'tokenLimits', 'tokenUsage', 'tokenLog'], (result) => {
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

  // Render sidebar section rules
  const sectionNames = result.sidebarSectionNames || [];
  const savedRules = result.sidebarTierMap || {};
  const defaultRules = {}; // all sections default to 'normal'
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
    function buildRuleSelect(key, currentRule) {
      return RULE_GROUPS.map((g) =>
        `<optgroup label="${g.group}">${g.options.map((o) =>
          `<option value="${o.value}"${o.value === currentRule ? ' selected' : ''}>${o.label}</option>`
        ).join('')}</optgroup>`
      ).join('');
    }
    for (const name of sorted) {
      const key = name.toLowerCase();
      const currentRule = savedRules[key] || defaultRules[key] || 'normal';
      const row = document.createElement('div');
      row.className = 'tier-row';
      row.innerHTML = `<span class="section-name">${name}</span><select data-section="${key}">${buildRuleSelect(key, currentRule)}</select>`;
      tierMapEl.appendChild(row);
    }

    const botRule = savedRules['__bot_only'] || 'high_volume';
    const botRow = document.createElement('div');
    botRow.className = 'tier-row';
    botRow.innerHTML = `<span class="section-name">\u{1F916} Bot-only channels</span><select data-section="__bot_only">${buildRuleSelect('__bot_only', botRule)}</select>`;
    tierMapEl.appendChild(botRow);
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
      <td><input type="number" data-key="${key}" value="${limits[key]}" min="50" max="4096" step="50" placeholder="${defaultVal}"></td>
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

  chrome.storage.local.set({
    claudeApiKey: key,
    userContext: context,
    openInBrowser: openInBrowserCheckbox.checked,
    sidebarTierMap,
    tokenLimits,
  }, () => {
    saveStatus.textContent = 'Saved!';
    setTimeout(() => { saveStatus.textContent = ''; }, 2000);
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
