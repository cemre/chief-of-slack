# Refactor Plan

## Goal

Clean up and simplify the extension incrementally without breaking behavior.

The rule for every phase:

1. Add or extend characterization tests first.
2. Refactor one small seam only.
3. Re-run the verification gate immediately.
4. Do not move to the next seam until the current seam is green.

This is intentionally slower than a rewrite, but it is the right approach for a Chrome extension that currently has little automated coverage and several large, stateful files.

## Current Risk Map

### Highest-risk files

- `sidepanel.js`
  - Very large mixed-responsibility file.
  - Contains state management, fetch orchestration, prioritization logic, rendering, keyboard navigation, and action handlers.
  - Refactor only in small slices.

- `inject.js`
  - Talks directly to Slack APIs and page-local state.
  - Contains duplicated full-fetch / fast-fetch flows.
  - Changes here can silently alter data shape.

- `background.js`
  - Lower UI risk than `sidepanel.js`, but it contains many LLM call paths and response parsers.
  - Good candidate for safe extraction after tests exist.

### Lower-risk files

- `redirect.js`
- `eval.js`
- `scripts/build-prod.js`
- `options.js`

These are the best places to establish the testing pattern first.

## Verification Gate

Run this after every refactor slice:

```bash
node --check background.js
node --check content.js
node --check inject.js
node --check options.js
node --check redirect.js
node --check eval.js
node --check scripts/build-prod.js
node --check sidepanel.js
npm test
node scripts/build-prod.js
```

If a slice touches only a subset of files, at minimum run:

- `node --check` on the touched files
- `npm test`
- `node scripts/build-prod.js`

## Snapshot Coverage

Reference snapshot used for planning:

- `/Users/gem_1/Downloads/fslack-snapshot-2026-03-30-21-53.json`

This snapshot is useful because it contains:

- cached view input data
- prioritized output data
- threads, DMs, channels, users, channel metadata, section metadata

Observed coverage from this snapshot:

- `1` unread thread
- `1` DM
- `20` channel-post groups
- `4` all-bot channel groups
- `15` channel groups with replies
- `6` `whenFree` items
- `12` `noise` items
- `2` `actNow` items
- `4` `priority` items

Observed gaps in this snapshot:

- no mention-driven items
- no DM thread items
- no group DMs
- no saved items
- no popular items
- no explicit sidebar-rule variety beyond `normal`

Implication:

- This snapshot is good enough for phase 1 and most of phase 2.
- We still need at least 2-4 additional targeted fixtures later for mention-heavy and rule-heavy cases.

## Fixture Strategy

Do not commit the raw snapshot to the repo.

Instead:

1. Use the local snapshot as the source of truth while extracting minimal fixture subsets.
2. Create sanitized fixtures under `test/fixtures/` only when a test needs them.
3. Keep the fixture payloads small and purpose-built.

Recommended fixture files to derive from the snapshot:

- `prioritization-base.json`
  - Minimal subset needed to exercise `applyPreFilters`, `serializeForLlm`, `mapPriorities`, and noise sorting.

- `render-base.json`
  - Small subset with one thread, one DM, one normal channel item, one deep-noise item.

- `bot-noise.json`
  - One or two all-bot channel groups showing current routing behavior.

Later fixtures still needed from another export or hand-built sanitization:

- `mention-floor.json`
- `group-dm.json`
- `sidebar-floor-rule.json`
- `public-channel-cap.json`

## Refactor Sequence

### Phase 0: Baseline Safety

Status: complete

Done:

- added small regression tests for `redirect.js`, `eval.js`, and `scripts/build-prod.js`
- fixed settings-page drift in `options.js`
- verified syntax, tests, and prod build

### Phase 1: Extract Pure Logic From Small Files

Goal:

- keep proving the workflow on low-risk code

Targets:

- `redirect.js`
- `eval.js`
- `scripts/build-prod.js`
- small `options.js` helpers

Test coverage:

- already present
- extend only if behavior changes

Exit criteria:

- no runtime behavior changes
- tests remain green

### Phase 2: Extract Sidepanel Prioritization Core

Goal:

- separate pure logic from DOM-heavy code without changing behavior

First extraction targets from `sidepanel.js`:

- `containsSelfMention`
- `applyPreFilters`
- `serializeForLlm`
- `floorCategory`
- `mapPriorities`
- `sortNoiseItems`
- small category/rank constants

Proposed new module:

- `lib/prioritization.js`

Tests to add before extraction:

- deterministic routing of bot-only items
- high-volume section routing
- thread/channel dedup behavior
- DM floor behavior
- public-channel cap behavior
- noise ordering behavior

Data source:

- derive `prioritization-base.json` and `bot-noise.json` from the local snapshot
- hand-build missing mention and rule fixtures if snapshot does not contain them

Exit criteria:

- same bucket counts for the fixture inputs before and after extraction
- same rule-override strings for tested cases

### Phase 3: Extract Sidepanel Rendering Helpers

Goal:

- shrink `sidepanel.js` without touching fetch/state flow yet

First extraction targets:

- Slack text formatting helpers
- file/render helpers
- link helpers
- item render helpers for thread, DM, channel, saved item

Proposed modules:

- `lib/formatting.js`
- `lib/render-items.js`

Tests to add before extraction:

- formatting of basic text
- formatting of forwarded/shared text
- file/image rendering shape
- rendered HTML snapshots for one item of each type

Notes:

- keep generated HTML identical at first
- do not redesign UI during this phase

### Phase 4: Extract Sidepanel Action / Port Handlers

Goal:

- isolate message dispatch and action result handling from rendering/state

Targets:

- `handlePortMessage`
- specific result handlers
- request ID routing helpers

Proposed modules:

- `lib/port-dispatch.js`
- `lib/action-results.js`

Tests to add:

- message dispatch table tests
- one-shot request completion tests
- result handler state transition tests where possible

### Phase 5: Deduplicate `inject.js` Fetch Pipelines

Goal:

- unify shared logic between `fetchUnreads` and `fetchFast`

Targets:

- Slack API wrapper and extraction helpers
- DM collection
- thread collection
- user resolution
- channel resolution
- result assembly

Proposed modules:

- `lib/slack-api.js`
- `lib/slack-extractors.js`
- `lib/fetch-shared.js`

Approach:

- first extract pure helpers only
- then make `fetchUnreads` and `fetchFast` call shared collectors
- keep output object shape unchanged

Tests to add:

- message extraction tests for `extractText`, `extractFwd`, `extractFiles`
- fetch result shape tests against fixture payloads
- fast/full mode invariant tests for overlapping fields

### Phase 6: Simplify `background.js`

Goal:

- collapse repeated Claude call handlers into a declarative map

Targets:

- prompt builders
- handler registration
- response parsing and normalization

Proposed module:

- `lib/claude-handlers.js`

Tests to add:

- prompt builder smoke tests
- parsing behavior for normal JSON, fenced JSON, and truncation salvage
- call-type to token-limit/model mapping

### Phase 7: Optional Browser Smoke Test

Goal:

- reduce manual testing for integration-level behavior

Suggested scope:

- load extension
- render sidepanel from a stubbed fixture payload
- verify sections render
- verify one mark-read action and one navigation action

Only add this after phases 2-5 make the logic more modular. Before that, setup cost is high.

## Manual Test Budget

Manual testing should stay minimal and focused.

After each phase, only do a short smoke pass:

1. open Slack
2. open sidepanel
3. confirm main sections render
4. click one item
5. mark one item read
6. open settings page

Do not rely on broad exploratory manual testing as the primary safety mechanism.

## Rules For Future Sessions

- Do not refactor `sidepanel.js` and `inject.js` in the same slice.
- Do not change output shapes and module boundaries in the same patch.
- Do not commit raw Slack exports.
- Prefer extracting pure functions before moving event handlers or DOM code.
- If a snapshot reveals real behavior that looks odd, preserve it first and document it; behavior changes are a separate step.

## Immediate Next Step

Start Phase 2 by extracting the sidepanel prioritization core behind characterization tests built from the snapshot-derived fixture subset.
