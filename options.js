// options.js — Settings page for Slack Attention Firewall

const apiKeyInput = document.getElementById('api-key');
const toggleKeyBtn = document.getElementById('toggle-key');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

// ── Load saved settings ──
chrome.storage.local.get('claudeApiKey', (result) => {
  if (result.claudeApiKey) apiKeyInput.value = result.claudeApiKey;
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

  chrome.storage.local.set({ claudeApiKey: key }, () => {
    saveStatus.textContent = 'Saved!';
    setTimeout(() => { saveStatus.textContent = ''; }, 2000);
  });
});
