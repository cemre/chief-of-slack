// redirect.js — content script running at document_start on Slack redirect/archives pages
// Intercepts slack:// protocol launches and redirects to app.slack.com/client/

function normalizeSlackTimestamp(pTimestamp) {
  if (!pTimestamp) return '';
  return pTimestamp.length > 10
    ? pTimestamp.slice(0, 10) + '.' + pTimestamp.slice(10)
    : pTimestamp;
}

function resolveRedirectTarget(href, workspaceTeamMap = {}) {
  const url = new URL(href);
  const path = url.pathname;

  if (path.startsWith('/app_redirect') || path.startsWith('/ssb/redirect')) {
    const channel = url.searchParams.get('channel');
    const team = url.searchParams.get('team');
    if (!channel || !team) return null;
    return { action: 'redirect', target: `https://app.slack.com/client/${team}/${channel}` };
  }

  const archivesMatch = path.match(/^\/archives\/([A-Z][A-Z0-9]+)(?:\/p(\d+))?/);
  if (!archivesMatch) return null;

  const channelId = archivesMatch[1];
  const msgTs = normalizeSlackTimestamp(archivesMatch[2]);
  let teamId;

  if (url.hostname === 'app.slack.com') {
    teamId = Object.values(workspaceTeamMap || {})[0];
  } else {
    const workspace = url.hostname.split('.')[0];
    teamId = workspaceTeamMap?.[workspace];
  }

  if (!teamId) {
    return { action: 'block-protocol' };
  }

  const tsPath = msgTs ? `/${msgTs}` : '';
  const threadTs = url.searchParams.get('thread_ts');
  const threadQuery = threadTs ? `?thread_ts=${threadTs}` : '';
  return {
    action: 'redirect',
    target: `https://app.slack.com/client/${teamId}/${channelId}${tsPath}${threadQuery}`,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    normalizeSlackTimestamp,
    resolveRedirectTarget,
  };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined') {
  (async function () {
    const { openInBrowser } = await chrome.storage.local.get('openInBrowser');
    if (openInBrowser === false) return;

    const { workspaceTeamMap } = await chrome.storage.local.get('workspaceTeamMap');
    const resolution = resolveRedirectTarget(window.location.href, workspaceTeamMap);
    if (!resolution) return;

    if (resolution.action === 'redirect') {
      console.log('[fslack redirect] redirect →', resolution.target);
      window.location.replace(resolution.target);
      return;
    }

    console.log('[fslack redirect] No team ID cached — blocking slack:// protocol');
    blockSlackProtocol();

    function blockSlackProtocol() {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('block-slack-protocol.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    }
  })();
}
