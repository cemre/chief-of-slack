// redirect.js — content script running at document_start on Slack redirect/archives pages
// Intercepts slack:// protocol launches and redirects to app.slack.com/client/

(async function () {
  // Check if feature is enabled (default: true)
  const { openInBrowser } = await chrome.storage.local.get('openInBrowser');
  if (openInBrowser === false) return;

  const url = new URL(window.location.href);
  const path = url.pathname;

  // ── App redirect pages: /app_redirect?channel=C123&team=T456 ──
  if (path.startsWith('/app_redirect')) {
    const channel = url.searchParams.get('channel');
    const team = url.searchParams.get('team');
    if (channel && team) {
      const target = `https://app.slack.com/client/${team}/${channel}`;
      console.log('[fslack redirect] app_redirect →', target);
      window.location.replace(target);
      return;
    }
  }

  // ── SSB redirect pages: /ssb/redirect?channel=C123&team=T456 ──
  if (path.startsWith('/ssb/redirect')) {
    const channel = url.searchParams.get('channel');
    const team = url.searchParams.get('team');
    if (channel && team) {
      const target = `https://app.slack.com/client/${team}/${channel}`;
      console.log('[fslack redirect] SSB redirect →', target);
      window.location.replace(target);
      return;
    }
  }

  // ── Archives pages: /archives/C123[/p1710500000123456] ──
  const archivesMatch = path.match(/^\/archives\/([A-Z][A-Z0-9]+)(?:\/p(\d+))?/);
  if (archivesMatch) {
    const channelId = archivesMatch[1];
    const pTimestamp = archivesMatch[2]; // e.g. "1710500000123456"

    // Convert p-timestamp to Slack ts format: insert dot at position 10
    let msgTs = '';
    if (pTimestamp) {
      msgTs = pTimestamp.length > 10
        ? pTimestamp.slice(0, 10) + '.' + pTimestamp.slice(10)
        : pTimestamp;
    }

    // Resolve team ID: for app.slack.com use any cached team; for *.slack.com use workspace subdomain
    const { workspaceTeamMap } = await chrome.storage.local.get('workspaceTeamMap');
    let teamId;
    if (url.hostname === 'app.slack.com') {
      teamId = workspaceTeamMap && Object.values(workspaceTeamMap)[0];
    } else {
      const workspace = url.hostname.split('.')[0];
      teamId = workspaceTeamMap?.[workspace];
    }

    if (teamId) {
      // /client/TEAM/CHANNEL/TS makes Slack's SPA jump directly to the message
      const tsPath = msgTs ? `/${msgTs}` : '';
      const threadTs = url.searchParams.get('thread_ts');
      const threadQuery = threadTs ? `?thread_ts=${threadTs}` : '';
      const target = `https://app.slack.com/client/${teamId}/${channelId}${tsPath}${threadQuery}`;
      console.log('[fslack redirect] Archives redirect →', target);
      window.location.replace(target);
      return;
    }

    // No team ID cached — block slack:// protocol, let archives page render
    console.log('[fslack redirect] No team ID cached — blocking slack:// protocol');
    blockSlackProtocol();
    return;
  }

  // ── Block slack:// protocol handler launches ──
  function blockSlackProtocol() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('block-slack-protocol.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }
})();
