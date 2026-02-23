# FSlack — Focus Slack

Chrome extension that overlays Slack's web app with a focused view of what actually needs your attention. Instead of scrolling through hundreds of unread channels, FSlack fetches your unreads, filters out noise (messages you sent, threads you've already seen), and shows only what matters.

## How It Works

1. Content script injects into `app.slack.com` and creates a full-screen overlay (shadow DOM)
2. Page-context script extracts your auth token from `localStorage` and calls Slack's internal APIs using relative URLs (no CORS, no cookie extraction needed)
3. Results are filtered — your own messages excluded, only truly unread items shown
4. Deterministic pre-filters remove obvious noise (bots, #help-dia without @mention)
5. Remaining items sent to Claude Haiku via background.js for priority classification
6. UI renders four priority sections: Act Now (red), When You Have a Moment (yellow), Interesting Elsewhere (blue), Noise (grey, collapsed)
7. Toggle with `Cmd+Shift+F` or click the extension icon

## File Structure

```
fslack2/
├── manifest.json    # MV3 manifest — permissions: activeTab, storage, scripting
├── inject.js        # Runs in Slack's PAGE context (has localStorage + cookie access)
│                    #   - Extracts xoxc- token from localConfig_v2
│                    #   - Calls /api/* endpoints with credentials: 'include'
│                    #   - Sends progress + results back via window.postMessage
│                    #   - Guarded against duplicate injection (__fslack_injected)
├── content.js       # Content script injected on app.slack.com
│                    #   - Injects inject.js into page context
│                    #   - Creates shadow DOM overlay with full UI
│                    #   - Deterministic pre-filters (bots→noise, help-dia→drop)
│                    #   - Sends items to background.js for LLM classification
│                    #   - Renders priority-based UI (Act Now / When Free / Noise)
│                    #   - Handles keyboard toggle (Cmd+Shift+F)
├── background.js    # Service worker — icon toggle + LLM prioritization
│                    #   - Handles extension icon click → executeScript toggle
│                    #   - chrome.runtime.onMessage for prioritize/apiKey (safe in SW)
│                    #   - Calls Claude Haiku API for message classification
│                    #   - Stores API key in chrome.storage.local
├── popup.html       # (unused, kept for reference — UI is in content.js overlay)
└── popup.js         # (unused, kept for reference)
```

## Slack API Details

All calls are POST to `/api/<endpoint>` (relative URL from page context) with `token` in FormData body and `credentials: 'include'` to send the `d` cookie automatically.

| Endpoint | Purpose | Key params |
|---|---|---|
| `client.counts` | Unread counts across all channels, DMs, threads | — |
| `client.userBoot` | Self user ID, team info, channel list | — |
| `subscriptions.thread.getView` | Unread threads with `unread_replies` (truly new) and `latest_replies` | — |
| `conversations.history` | Messages in a channel | `channel`, `oldest` (for unread-only), `limit` |
| `conversations.info` | Channel name, topic, membership | `channel` |
| `users.info` | Resolve user ID → display name | `user` |
| `search.messages` | Find high-engagement messages for "Interesting Elsewhere" | `query`, `sort`, `count` |

### Important API nuances
- `subscriptions.thread.getView` returns both `latest_replies` (may include read messages) and `unread_replies` (only new ones). **Use `unread_replies`.**
- `client.counts` channels include `last_read` timestamp — pass as `oldest` to `conversations.history` to fetch only unread messages.
- Token comes from `localStorage.localConfig_v2.teams[lastActiveTeamId].token` (xoxc- prefix).
- Slack's own JS uses `https://<team>.slack.com/api/` (cross-origin), but relative `/api/` from `app.slack.com` works and avoids CORS.

## Architecture Decisions

### Why overlay instead of popup?
Chrome popups close when you click away, killing the connection mid-fetch. The overlay stays persistent, renders directly on the page, and the shadow DOM isolates styles from Slack's CSS.

### Why no chrome.runtime.onMessage in content.js?
Orphaned content scripts (after extension reload) keep their `onMessage` listeners alive, causing "Could not establish connection" errors. We avoid this entirely by:
- Using `window.postMessage` for inject.js ↔ content.js communication
- Using `chrome.scripting.executeScript` for background.js → content.js toggle
- Zero `chrome.runtime` message listeners in content scripts

### Why inject.js in page context?
Content scripts are in an isolated world — they can't access `localStorage` or send cookies with fetch. inject.js runs in the actual page context where it has full access to Slack's auth state.

### LLM Prioritization Architecture
- **Pre-filters** (deterministic, in content.js): Bots → noise, #help-dia without @mention → drop, threads annotated with `_userReplied` flag
- **LLM call** (in background.js): content.js sends serialized items via `chrome.runtime.sendMessage` → background.js calls Claude Haiku → returns JSON mapping of item IDs to categories
- **No onMessage listener in content.js**: content.js uses `chrome.runtime.sendMessage` with callback (one-shot, no listener needed). background.js has the `onMessage` listener (safe in service workers).
- **Fallback**: If no API key or LLM fails, falls back to the original unprioritized 3-section view
- **VIP list**: Hardcoded in background.js: josh, tara, dustin, brahm, rosey, samir, jane

### Priority Categories
| Category | Color | Criteria |
|---|---|---|
| **Act Now** | Red `#e01e5a` | Blocked on me, decision needs my input, VIP needing reply, urgent production |
| **When You Have a Moment** | Yellow `#ecb22e` | VIP FYIs, non-urgent questions for me, discussions to weigh in on |
| **Interesting Elsewhere** | Blue `#1d9bd1` | High-engagement workspace messages (≥5 reactions or replies) |
| **Noise** | Grey `#616061` | Bots, general chatter, non-VIP announcements (collapsed by default) |
| **Drop** | — | Thread I replied to where new msgs are just acks/+1s (not shown at all) |

## Current Status

- [x] Token extraction from localStorage
- [x] All API endpoints tested and working
- [x] Overlay UI with shadow DOM (dark theme matching Slack)
- [x] Unread threads — filtered to `unread_replies`, excluding self
- [x] Unread DMs
- [x] Unread channel posts (top 15 most recent, only messages since `last_read`)
- [x] User name resolution (up to 25 parallel)
- [x] Channel name resolution
- [x] Step-by-step progress indicator during fetch
- [x] Keyboard toggle (Cmd+Shift+F) + extension icon toggle
- [x] Clean extension reload without errors
- [x] LLM prioritization via Claude Haiku (Act Now / When Free / Noise / Drop)
- [x] Deterministic pre-filters (bots, #help-dia)
- [x] "Interesting Elsewhere" section (high-engagement messages via search.messages)
- [x] API key inline prompt with Skip fallback
- [x] Noise section collapsed by default

## Next Steps

### Polish & UX
- [ ] Auto-fetch on overlay open (instead of requiring button click)
- [ ] Periodic background refresh (every N minutes)
- [ ] Click on an item → navigate to that thread/channel in Slack and close overlay
- [ ] Resolve `<@U...>` mentions in message text to display names
- [ ] Better empty states and loading animations

### Filtering & Prioritization
- [ ] Mark items as "dealt with" to dismiss from the list
- [ ] Mute specific channels from showing up

### LLM Integration
- [ ] Generate suggested replies
- [ ] Daily digest summary

### Robustness
- [ ] Cache user/channel names in `chrome.storage` to reduce API calls
- [ ] Handle token expiry / re-auth gracefully
- [ ] Rate limiting awareness (Slack may throttle rapid API calls)
