// options.js — Settings page for Slack Attention Firewall

const apiKeyInput = document.getElementById('api-key');
const toggleKeyBtn = document.getElementById('toggle-key');
const userContextInput = document.getElementById('user-context');
const charCount = document.getElementById('char-count');
const openInBrowserCheckbox = document.getElementById('open-in-browser');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

// ── Load saved settings ──
chrome.storage.local.get(['claudeApiKey', 'userContext', 'openInBrowser', 'vipNames'], (result) => {
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

  chrome.storage.local.set({
    claudeApiKey: key,
    userContext: context,
    openInBrowser: openInBrowserCheckbox.checked,
  }, () => {
    saveStatus.textContent = 'Saved!';
    setTimeout(() => { saveStatus.textContent = ''; }, 2000);
  });
});
