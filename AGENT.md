# Chief of Slack Agent Guide

This repo is a Chromium MV3 extension that turns Slack web unreads into a prioritized side panel. The extension does three jobs:

1. Fetch unread Slack data from the logged-in Slack web app by injecting code into the page context.
2. Send compact summaries to Anthropic for prioritization and secondary summarization.
3. Render a keyboard-driven side panel that lets the user triage, reply, react, save, mute, and mark messages read.

The codebase is small, but most behavior lives in one large file: `sidepanel.js`.

## File Layout

### Entry points

- `manifest.json`
  Declares the MV3 service worker, the Slack content scripts, the side panel, commands, DNR rules, and options page.

- `background.js`
  Service worker. Owns:
  - side panel port wiring
  - message relay between side panel and Slack tab
  - Anthropic API calls and prompt construction
  - token usage tracking
  - opening settings / navigating the Slack tab

- `content.js`
  Content script on `app.slack.com`. Thin bridge between the extension world and Slack page context.
  - injects `inject.js`
  - mirrors some `chrome.storage.local` state into `localStorage` for page-context code
  - hides Slack nav and injects the nav toggle button
  - forwards `fslack:*` messages between `inject.js` and `background.js`

- `inject.js`
  Runs in Slack page context. This is the Slack data layer.
  - reads Slack auth token from `localStorage`
  - calls Slack internal web APIs via same-origin `/api/...`
  - fetches unreads, threads, DMs, channel posts, VIP activity, saved items, popular posts
  - performs mark read / reply / reaction / save / mute actions
  - caches Slack-side data in page `localStorage`

- `sidepanel.html`
  Minimal shell for the side panel.

- `sidepanel.js`
  Main UI and orchestration layer. Owns:
  - fetch lifecycle
  - deterministic routing rules
  - batch summarize -> prioritize pipeline
  - renderers for every item type
  - keyboard navigation
  - optimistic action handling
  - local caches and persisted view state
  - dev-only demo / eval helpers

- `content.css`
  Side panel styling. Also includes dev-only demo / assessment UI styles.

- `options.html`, `options.js`, `options.css`
  Settings page. Stores API key, user context, priority rules, sidebar section rules, redirect toggle, and token limits.

- `redirect.js`
  Content script for Slack redirect/archive pages. Rewrites Slack URLs to `https://app.slack.com/client/...` when possible.

- `block-slack-protocol.js`
  Page-context monkeypatch used by `redirect.js` when a team ID cannot be resolved. Blocks `slack://` launches.

### Support files

- `rules.json`
  Declarative net request ruleset used by the extension.

- `standard-emoji.json`
  Generated shortcode -> unicode map used in rendering.

- `eval.js`, `EVAL.md`
  Dev-only assessment tooling for reviewing classification quality.

- `scripts/generate-emoji.js`
  Rebuilds `standard-emoji.json`.

- `scripts/build-prod.js`
  Builds `dist/` by stripping `DEV_ONLY` blocks from JS/CSS/HTML.

## Runtime Boundaries

The extension has four execution environments:

1. `sidepanel.js`
   Extension UI. Has `chrome.*`, no direct Slack cookies or page JS access.

2. `background.js`
   Extension service worker. Has `chrome.*`, performs Anthropic fetches.

3. `content.js`
   Isolated content-script world on Slack pages. Can talk to both extension and DOM.

4. `inject.js`
   Slack page context. Can use Slack `localStorage`, same-origin cookies, and Slack web APIs.

Everything moves through `fslack:*` messages.

## Data Flow

### Main fetch path

1. `sidepanel.js` calls `startFetch()` or `startFullFetch()`.
2. `sidepanel.js` sends `fslack:fetchFast` or `fslack:fetch` through the sidepanel port.
3. `background.js` relays to the active Slack tab.
4. `content.js` forwards to `inject.js` via `window.postMessage`.
5. `inject.js` fetches Slack data and posts back `fslack:fastResult` or `fslack:result`.
6. `content.js` forwards to `background.js`.
7. `background.js` relays to the side panel.
8. `sidepanel.js` runs deterministic prefilters, LLM summarize/prioritize, then renders.

### LLM path

1. `sidepanel.js` serializes items into lean payloads.
2. `sidepanel.js` sends `fslack:batchSummarize` and then `fslack:prioritize`.
3. `background.js` builds prompts and calls Anthropic.
4. `background.js` parses JSON responses and returns summaries / priorities / reasons.
5. `sidepanel.js` applies deterministic overrides and renders final buckets.

### Action path

Most UI actions originate in `sidepanel.js`, go through `background.js` and `content.js`, and execute in `inject.js` against Slack APIs. Results come back as `...Result` messages and update the DOM optimistically or confirm completion.

## Fetching and Classification Pipeline

The core pipeline is split between `inject.js`, `sidepanel.js`, and `background.js`.

### `inject.js`: gather raw Slack data

The two main functions are:

- `fetchUnreads(...)`
  Full fetch. Pulls threads, DMs, channels, activity feed misses, user/channel resolution, emoji, sidebar sections, and metadata.

- `fetchFast(...)`
  Cheaper fetch. Reuses short-lived caches and only fetches channels with mentions instead of all unread channels.

Important helpers:

- `slackApi(endpoint, params)`
  Wrapper around Slack web API POSTs to `/api/...`.

- `getSelfIdAndMuted()`
  Reads `client.userBoot` and resolves self ID, handle, muted channels, and VIP user IDs.

- `fetchActivityMentions(...)`
  Backfills unread mentions/threads that `client.counts` or `subscriptions.thread.getView` may miss.

- `extractText`, `extractFwd`, `extractFiles`
  Normalize Slack message structures into renderable plain objects.

- `ensureTranscripts(files)`
  Retranscribes voice notes when needed.

### `sidepanel.js`: deterministic routing + AI

The important orchestration functions are:

- `applyPreFilters(data)`
  First routing pass. It:
  - dedupes thread broadcasts
  - drops muted threads
  - applies high-volume / hard-noise / skip section rules
  - routes bot-only items
  - decides what goes straight to `noise` / `whenFree` and what still needs AI

- `serializeForLlm(forLlm, data)`
  Converts raw threads, DMs, and channel posts into compact prompt items with metadata like mentions, privacy, sidebar section, participants, etc.

- `_prioritizeAndRenderInner(data)`
  Main pipeline:
  - run prefilters
  - batch summarize uncached items
  - prioritize lean items
  - map LLM output into final buckets
  - render immediately
  - kick off slower secondary summarizers

- `mapPriorities(...)`
  Applies deterministic post-LLM overrides:
  - VIP DM floor
  - DM floor
  - @mention floor
  - sidebar section floors
  - private-channel floor
  - public-channel cap
  - user-replied rescue from noise/drop

### `background.js`: prompts and Anthropic calls

Prompt builders:

- `buildBatchSummarizePrompt`
- `buildPrompt` for prioritization
- `buildSummarizePrompt`
- `buildVipSummarizePrompt`
- `buildThreadReplySummarizePrompt`
- `buildFullThreadSummarizePrompt`
- `buildBotThreadPrompt`
- `buildChannelPostPrompt`

Network helpers:

- `callClaude(...)`
- `fetchWithRetry(...)`
- `trackUsage(...)`

Important detail: summarization uses Sonnet for `batchSummarize`; most other calls default to Haiku.

## Rendering Model

`sidepanel.js` has one large render surface. The most important rendering functions are:

- `renderPrioritized(...)`
  Final grouped UI:
  - Saved
  - Priority
  - Relevant
  - Popular
  - Recent noise
  - Older noise
  - VIP section placeholder

- `renderAnyItem(...)`
  Dispatch for all item subtypes.

- `renderThreadItem(...)`
- `renderDmItem(...)`
- `renderChannelItem(...)`
- `renderDeepSummarizedItem(...)`
- `renderBotThreadItem(...)`
- `renderSavedItem(...)`

Secondary summarizers update parts of the DOM in place after the first render:

- `runBotThreadSummarization(...)`
- `runWhenFreeChannelSummarization(...)`
- `runThreadReplySummarization(...)`
- `runChannelThreadSummarization(...)`
- `runRootSummarization(...)`
- `kickoffVipSection(...)`

That split matters: first render is optimized for speed; richer summaries are layered in later.

## Caching

There are two different cache layers.

### Page-context / Slack fetch caches in `inject.js`

- `_countsCache`
- `_threadViewCache`
- `_dmContextCache`
- `localStorage.fslackSidebarSections`
- `localStorage.fslackSectionNames`
- `localStorage.fslackSectionChannelIds`
- `localStorage.fslackSectionNameMap`
- `localStorage.fslackTierMap`

These exist because `inject.js` cannot use `chrome.storage`.

### Extension caches in `sidepanel.js`

- `fslackViewCache`
  Last rendered prioritized view.

- `fslackPrioritizationCache`
  Whole-pipeline hash cache keyed by serialized items.

- `fslackItemSummaryCache`
  Per-item batch-summary cache keyed by item hash.

- `fslackSummaryCache`
  Per-channel summary cache.

- `fslackVipSummaryCache`
  VIP summary cache.

- `fslackAllSummaryCache`
  Other secondary summaries: bot thread, thread replies, channel thread summaries, etc.

Also persisted:

- users, full names, mention hints
- channels and channel meta
- emoji and emoji timestamp
- saved message keys
- muted thread keys
- VIP seen timestamps
- drafts
- last fetch timestamp

## Storage Contract

Common `chrome.storage.local` keys:

- `claudeApiKey`
- `userContext`
- `selfHandle`
- `vipNames`
- `priorityRules`
- `sidebarTierMap`
- `sidebarSectionNames`
- `sidebarSectionChannels`
- `tokenLimits`
- `tokenUsage`
- `tokenLog`
- `openInBrowser`
- `workspaceTeamMap`
- `fslackViewCache`
- `fslackLastFetchTs`
- `fslackUsers`
- `fslackFullNames`
- `fslackUserMentionHints`
- `fslackUsersCacheVersion`
- `fslackChannels`
- `fslackChannelMeta`
- `fslackEmoji`
- `fslackEmojiTs`
- `fslackSavedMsgs`
- `fslackMutedThreads`
- `fslackVipSeen`
- `fslackDrafts`

If you change the shape of cached user data, bump `USERS_CACHE_VERSION` in `sidepanel.js`.

## Common Edit Entry Points

### Change how items are prioritized

Start here:

- `sidepanel.js` -> `applyPreFilters`
- `sidepanel.js` -> `serializeForLlm`
- `background.js` -> `buildBatchSummarizePrompt`
- `background.js` -> `buildPrompt`
- `sidepanel.js` -> `mapPriorities`

Rule of thumb:

- deterministic rules belong in `sidepanel.js`
- semantic judgment belongs in Anthropic prompts in `background.js`

### Change what data is fetched from Slack

Start in `inject.js`:

- `fetchUnreads`
- `fetchFast`
- `fetchActivityMentions`
- `fetchVipActivity`
- `fetchPopularMessages`

If the new field must survive classification, thread it through:

1. raw fetch object in `inject.js`
2. serialization in `sidepanel.js`
3. prompt usage in `background.js`
4. renderer in `sidepanel.js`

### Change side panel layout or interactions

Start in:

- `sidepanel.html` for shell only
- `content.css` for styling
- `sidepanel.js` renderers and action handlers

The UI is not componentized. Most changes are string-template based.

### Change settings behavior

Start in:

- `options.html`
- `options.js`
- `options.css`

Then wire the setting into:

- `background.js` if it affects prompts / API calls
- `content.js` if it affects Slack page behavior
- `sidepanel.js` if it affects rendering or deterministic rules
- `redirect.js` if it affects browser redirect behavior

### Change Slack link interception

Start in:

- `redirect.js`
- `block-slack-protocol.js`
- `content.js` and `sidepanel.js` only if the new behavior needs UI coordination

## Sidepanel.js Navigation Guide

`sidepanel.js` is big. These are the main regions worth knowing:

- top of file
  Drafts, dev/demo tooling, port connection, global state

- around `startFetch` / `startFullFetch` / `showFromCache`
  Fetch lifecycle and background refresh behavior

- around `formatSlackHtml` and nearby helpers
  Slack text rendering, links, emoji, truncation, file rendering

- around `renderThreadItem` / `renderDmItem` / `renderChannelItem`
  Per-item HTML generation

- around `applyPreFilters` / `serializeForLlm` / `mapPriorities`
  Core inbox intelligence

- around `renderPrioritized`
  Section layout and post-render wiring

- around `run*Summarization`
  Secondary summarization passes

- around `_prioritizeAndRenderInner`
  Main pipeline and cache coordination

- bottom of file
  port message dispatch, initialization, and storage listeners

## Dev-Only Code

This repo uses explicit markers:

- `/* DEV_ONLY_START */ ... /* DEV_ONLY_END */` in JS/CSS
- `<!-- DEV_ONLY_START --> ... <!-- DEV_ONLY_END -->` in HTML

These sections include:

- demo anonymization
- snapshot export/import
- assessment mode
- eval export
- cache nuking controls

`scripts/build-prod.js` strips them into `dist/`.

## Important Behavioral Notes

- Fast fetch is intentionally incomplete. It reuses cached channel state and only fetches expensive channel history when needed.
- The first render may not include all rich summaries. Many summary blocks are filled in after the initial render.
- `applyPreFilters` mutates items in place. Be careful when reusing objects between buckets.
- `mapPriorities` also mutates items by attaching `_llmId`, `_reason`, `_reasonWhy`, `_ruleOverride`, and related metadata used by the UI and eval tooling.
- The side panel often updates the DOM optimistically before Slack confirms the action.
- `inject.js` is the only place that should call Slack web APIs directly.
- `background.js` is the only place that should call Anthropic directly.

## Suggested Workflow For Future Changes

When making changes, inspect in this order:

1. `manifest.json`
   Confirm which runtime owns the behavior.

2. `sidepanel.js`
   Find the render or orchestration path first.

3. `inject.js`
   Verify the raw Slack data shape being supplied.

4. `background.js`
   Adjust prompts or model routing only if deterministic rules are not enough.

5. `options.js`
   Expose new user-facing controls last.

If a change feels hard, it is usually because the behavior crosses execution boundaries. Trace the `fslack:*` message path end to end before editing.
