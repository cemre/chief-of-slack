# Chief of Slack Agent Guide

This repo is a Chromium MV3 extension that turns Slack unread activity into a prioritized side panel.

The codebase is still small in file count, but behavior crosses four runtimes and most product logic still lives in a few large files. Speed and accuracy come from editing the correct runtime first and respecting the current seams.

## What Lives Where

### Extension entry points

- `manifest.json`
  Declares the MV3 service worker, Slack content scripts, side panel, redirect script, options page, commands, and DNR rules.

- `background.js`
  Service worker.
  Owns sidepanel port wiring, Slack tab routing, Anthropic calls, prompt construction, token usage tracking, and opening settings.

- `content.js`
  Content script on `app.slack.com`.
  Bridges between extension code and the Slack page context.

- `inject.js`
  Runs in Slack page context.
  This is the only place that should call Slack web APIs directly.

- `sidepanel.html`
  Sidepanel shell.
  Loads `prioritization.js` before `sidepanel.js`.

- `sidepanel.js`
  Main UI, fetch lifecycle, rendering, keyboard navigation, optimistic actions, caching, and post-render summarization passes.

- `prioritization.js`
  Current extracted pure prioritization seam.
  Holds `containsSelfMention`, `applyPreFilters`, `serializeForLlm`, `floorCategory`, `mapPriorities`, and `sortNoiseItems`.

- `content.css`
  Shared UI stylesheet for the sidepanel surface.
  Sidepanel shell layout bugs often live here, not in `sidepanel.html`.

- `options.html`, `options.js`, `options.css`
  Settings UI and storage wiring.

- `redirect.js`
  Slack redirect/archive handling.

- `block-slack-protocol.js`
  Prevents `slack://` launches when the extension cannot resolve a team mapping.

### Dev/test/build support

- `scripts/build-prod.js`
  Builds `dist/` by stripping `DEV_ONLY` blocks.

- `eval.js`, `EVAL.md`
  Dev-only classification assessment helpers.

- `test/*.test.js`
  Node test suite run via `node --test`.

- `test/fixtures/*.json`
  Sanitized characterization fixtures.
  Do not commit raw Slack snapshot dumps.

## Runtime Boundaries

There are four separate execution environments:

1. `sidepanel.js`
   Extension UI runtime with `chrome.*`, but no direct Slack page state.

2. `background.js`
   MV3 service worker with `chrome.*` and outbound Anthropic fetches.

3. `content.js`
   Isolated content-script world on Slack pages.

4. `inject.js`
   Slack page context with access to Slack `localStorage`, same-origin cookies, and Slack web APIs.

Most nontrivial features cross more than one boundary. Trace the `fslack:*` message path before editing.

## Current Structure That Matters

The project is mid-refactor, not fully modular.

### Stable extracted seam

- `prioritization.js` is the main extracted pure module.
- It uses a UMD-style wrapper:
  - `module.exports` for Node tests
  - `globalThis.FslackPrioritization` for the browser
- `sidepanel.js` expects that global to exist immediately on load.
- If you break the script order in `sidepanel.html`, the sidepanel fails at startup.

### Still-large files

- `sidepanel.js`
  Still the highest-risk file.
  Rendering, orchestration, DOM patching, and action handling are still in here.

- `inject.js`
  Still the Slack data source and the other highest-risk file.
  Changes here can silently alter data shape.

- `background.js`
  Still owns most LLM behavior and response parsing.

## Build Constraints

This repo does not have a bundler.

- `scripts/build-prod.js` copies only top-level files into `dist/`.
- It skips directories entirely.
- That means new runtime-loaded modules must either:
  - live at repo top level, or
  - be accompanied by a build script change.

This is why the extracted prioritization module currently lives at `prioritization.js` instead of `lib/prioritization.js`.

## Important Quirks

- `content.css` styles the sidepanel shell itself.
  Shell height/blank-page bugs can be CSS-only even if the HTML and JS are fine.

- `applyPreFilters` mutates data objects in place.
  It rewrites `data.threads`, attaches `_type`, `_sidebarSection`, `_ruleOverride`, `_isMentioned`, and more.

- `mapPriorities` also mutates in place.
  It adds `_llmId`, `_reason`, `_reasonWhy`, `_ruleOverride`, and final bucket metadata used by the UI and eval tooling.

- The first sidepanel render is intentionally incomplete.
  Secondary summarizers fill in richer thread/channel summaries later.

- Fast fetch is intentionally partial.
  It reuses cached channel state and does not behave like a full reload.

- `background.js` should be the only Anthropic caller.

- `inject.js` should be the only Slack API caller.

- The current public-channel cap behavior is quirky.
  `test/prioritization.test.js` characterizes that a public channel classified as `priority` currently remains in `priority` because `mapPriorities` returns before the cap logic runs.
  Do not “fix” that accidentally during unrelated refactors.

- Dev-only controls are embedded directly in production files behind marker comments.
  Production output depends on those markers remaining intact.

## Tests And Verification

### Main test command

```bash
npm test
```

### Full verification gate

```bash
node --check background.js
node --check content.js
node --check inject.js
node --check options.js
node --check redirect.js
node --check eval.js
node --check scripts/build-prod.js
node --check sidepanel.js
node --check prioritization.js
npm test
node scripts/build-prod.js
```

If you touch only one seam, still run:

- `node --check` on touched JS files
- `npm test`
- `node scripts/build-prod.js`

## Best Edit Entry Points

### Change prioritization behavior

Start here:

- `prioritization.js`
- `background.js` prompt builders only if the behavior is semantic rather than deterministic
- `test/prioritization.test.js`

Rule of thumb:

- deterministic routing belongs in `prioritization.js`
- semantic judgment belongs in prompts in `background.js`

### Change fetched Slack data

Start in `inject.js`.

If a new field needs to survive all the way to UI:

1. fetch/extract it in `inject.js`
2. thread it through `sidepanel.js` pipeline entry points
3. include it in `prioritization.js` serialization if needed by prompts
4. update `background.js` prompts if needed
5. render it in `sidepanel.js`

### Change sidepanel layout or behavior

Start in:

- `sidepanel.html` for shell order
- `content.css` for layout and styling
- `sidepanel.js` for string-template rendering and interactions

### Change settings behavior

Start in:

- `options.html`
- `options.js`
- `options.css`

Then wire through whichever runtime actually uses the setting.

## Current Test Coverage Map

Safe seams already covered by tests:

- `redirect.js`
- `eval.js`
- `scripts/build-prod.js`
- `prioritization.js`

Current prioritization fixture coverage includes:

- thread/channel dedup
- high-volume section splitting
- DM floor behavior
- serialization shape
- noise ordering
- current public-channel-cap quirk

Not yet covered well:

- mention-heavy cases
- group DMs
- richer sidebar floor-rule combinations
- render snapshots
- most of `inject.js`
- most of `background.js`
- most of `sidepanel.js` rendering/actions

## Data And Storage Notes

Common extension-side storage keys include:

- `claudeApiKey`
- `userContext`
- `priorityRules`
- `sidebarTierMap`
- `sidebarSectionNames`
- `fslackViewCache`
- `fslackPrioritizationCache`
- `fslackItemSummaryCache`
- `fslackSummaryCache`
- `fslackVipSummaryCache`
- `fslackAllSummaryCache`
- `fslackUsers`
- `fslackFullNames`
- `fslackUserMentionHints`
- `fslackChannels`
- `fslackChannelMeta`
- `fslackMutedThreads`
- `fslackDrafts`

If you change cached user-data shape, check whether `USERS_CACHE_VERSION` in `sidepanel.js` needs to move.

`inject.js` cannot use `chrome.storage`, so some sidebar state is mirrored through Slack-page `localStorage`.

## Recommended Workflow

When making changes quickly:

1. Identify the owning runtime from `manifest.json`.
2. Read the message path end to end.
3. Add or update characterization tests first if the seam is testable.
4. Make one small extraction or behavior change.
5. Run the verification gate immediately.

When in doubt:

- keep runtime boundaries intact
- prefer extending the existing extracted seam instead of adding another partial abstraction
- avoid moving files into subdirectories unless you also update the production build path
