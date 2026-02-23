# Flack — Focus Slack

Chrome extension that overlays Slack's web app with a focused view of unreads. Fetches all unread threads, DMs, and channels, filters out noise, sends the rest to Claude Haiku for priority classification, and renders a triage UI with inline actions (react, reply, mark read, save).

## Architecture

```
content.js  ←window.postMessage→  inject.js (page context)
    ↓ chrome.runtime.sendMessage
background.js → Claude API
```

- **inject.js** — Runs in Slack's page context (has `localStorage` + cookies). Extracts `xoxc-` token, calls Slack's `/api/*` endpoints with `credentials: 'include'`. Handles all Slack API calls and sends results back via `window.postMessage`.
- **content.js** — Content script injected on `app.slack.com`. Creates a full-screen shadow DOM overlay. Handles UI rendering, deterministic pre-filters, and orchestrates LLM prioritization via background.js.
- **background.js** — Service worker. Handles extension icon click toggle, Claude API calls for prioritization, and API key storage.
- **popup.html/popup.js** — Unused legacy files. UI lives in the content.js overlay.
- **rules.json** — Strips `Origin` header on Anthropic API requests to avoid CORS issues.

### Key design decisions
- **Overlay, not popup**: Chrome popups close when you click away. Shadow DOM isolates from Slack's CSS.
- **No `chrome.runtime.onMessage` in content.js**: Orphaned content scripts (after extension reload) cause "Could not establish connection" errors. content.js uses `chrome.runtime.sendMessage` with callback (one-shot) instead.
- **inject.js in page context**: Content scripts can't access `localStorage` or send cookies. inject.js runs where Slack's auth state lives.

## Slack API

All calls are POST to `/api/<endpoint>` (relative URL from page context) with `token` in FormData body and `credentials: 'include'`.

| Endpoint | Purpose |
|---|---|
| `client.counts` | Unread counts, `last_read` timestamps |
| `client.userBoot` | Self user ID |
| `subscriptions.thread.getView` | Unread threads — use `unread_replies` not `latest_replies` |
| `conversations.history` | Channel/DM messages since `last_read` |
| `conversations.info` | Channel name, `is_private` flag |
| `conversations.replies` | Full thread replies (for "earlier replies" lazy load) |
| `conversations.mark` | Mark channel as read up to timestamp |
| `users.info` | User ID → display name |
| `search.messages` | High-engagement messages for "Interesting Elsewhere" |
| `reactions.add` | Add emoji reaction |
| `stars.add` | Save/bookmark a message |
| `chat.postMessage` | Send reply (with `thread_ts` for threaded) |

### Important nuances
- Token: `localStorage.localConfig_v2.teams[lastActiveTeamId].token` (xoxc- prefix)
- `subscriptions.thread.getView` returns `latest_replies` (may include read) AND `unread_replies` (only new). **Always use `unread_replies`.**
- `client.counts` channels have `last_read` — pass as `oldest` to `conversations.history`.
- Relative `/api/` from `app.slack.com` works and avoids CORS. Slack's own JS uses `https://<team>.slack.com/api/`.

## Prioritization Pipeline

### 1. Deterministic pre-filters (content.js `applyPreFilters`)
- All-bot messages → noise (except dia-reporter channels with threads ≥8 replies → send to LLM)
- `#help-dia` without @mention → hard drop
- Threads annotated with `_userReplied`, `_isMentioned`, `_isDmThread` flags for LLM context

### 2. LLM classification (background.js → Claude Haiku)
Items serialized to JSON with metadata (channel, isPrivate, userReplied, isMentioned, rootUser, messages). Prompt instructs model to classify each item ID into a category.

### 3. Safety overrides (content.js `mapPriorities`)
- Private channel/DM items never become "noise" — promoted to when_free
- `userReplied` items never dropped — promoted to when_free
- `drop` on non-private items = actually dropped (not shown)

### Priority categories
| Category | Color | When |
|---|---|---|
| **Act Now** | `#e01e5a` red | Blocked on me, waiting for my response |
| **Priority** | `#e8912d` orange | Needs attention soon, VIP messages, active discussions I'm in |
| **When Free** | `#ecb22e` yellow | VIP FYIs, non-urgent questions, discussions to weigh in on |
| **Interesting** | `#1d9bd1` blue | High-engagement workspace messages (≥5 reactions or replies) |
| **Noise** | `#616061` grey | Bots, general chatter (collapsed by default) |
| **Drop** | — | Ack/+1 replies in threads I already replied to (hidden) |

### VIP list (background.js)
josh, tara, dustin, brahm, rosey, samir, jane

### Mention detection (content.js)
Checks for `<@selfId>`, `@selfId`, `@gem`, `hey gem`, `hi gem`, `hey cemre`, `hi cemre` (case-insensitive).

## Inline Actions

Each message row has hover actions handled via `window.postMessage` to inject.js:
- **React** (👍💛👀) → `reactions.add`
- **Save** (bookmark icon) → `stars.add`
- **Mark read** (○) → `conversations.mark` — dims the entire item
- **Reply** (↩) → opens inline text input → `chat.postMessage`
- **Mark all read** — appears on item hover, marks the whole thread/channel read
- **Earlier replies** — lazy-loads full thread via `conversations.replies`

## Fetch Flow

1. User clicks "Fetch Unreads" (or overlay auto-shows on load)
2. content.js fires `fslack:fetch` + `fslack:fetchPopular` in parallel via postMessage
3. inject.js runs 6-step fetch: counts → threads → DMs → channels → users → channel names
4. Progress updates sent as `fslack:progress` messages (Step 1-6)
5. Results arrive as `fslack:result` and `fslack:popularResult`
6. content.js deduplicates popular against unreads, runs pre-filters, calls LLM, renders

## Next Steps

- [ ] Auto-fetch on overlay open (instead of requiring button click)
- [ ] Click item → navigate to that thread/channel in Slack and close overlay
- [ ] Mark items as "dealt with" / dismiss from list
- [ ] Mute specific channels
- [ ] Cache user/channel names in `chrome.storage`
- [ ] Handle token expiry gracefully
