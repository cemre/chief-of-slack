# Handoff

Read [REFACTOR_PLAN.md](/Users/gem_1/Library/Mobile Documents/com~apple~CloudDocs/coding projects/fslack2/REFACTOR_PLAN.md) first.

## What Was Done

- Reviewed the full extension architecture.
- Identified the main refactor risk areas:
  - `sidepanel.js`
  - `inject.js`
  - `background.js`
- Added a phase-0 safety net:
  - `package.json`
  - `test/redirect.test.js`
  - `test/eval.test.js`
  - `test/build-prod.test.js`
- Fixed two concrete settings-page issues in `options.js`:
  - token default drift for `prioritize`
  - bot-only rule select relying on block-scoped helper placement
- Refactored small low-risk files to expose pure helpers for tests:
  - `redirect.js`
  - `eval.js`
  - `scripts/build-prod.js`
- Wrote the staged refactor plan in `REFACTOR_PLAN.md`.

## Verified Status

These passed after the phase-0 changes:

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

## Important Repo State

There were already unrelated dirty changes in:

- `background.js`
- `content.css`
- `content.js`
- `inject.js`

Do not casually overwrite or refactor those in the next slice unless the slice explicitly requires it.

Current added/edited files from this work:

- `REFACTOR_PLAN.md`
- `HANDOFF.md`
- `package.json`
- `test/redirect.test.js`
- `test/eval.test.js`
- `test/build-prod.test.js`
- `options.js`
- `redirect.js`
- `eval.js`
- `scripts/build-prod.js`

## Local Snapshot Available

Use this as local source material only. Do not commit it to the repo.

`/Users/gem_1/Downloads/fslack-snapshot-2026-03-30-21-53.json`

It contains enough data to start Phase 2 fixture extraction for prioritization logic.

## Next Step

Continue with **Phase 2** from `REFACTOR_PLAN.md`.

Immediate objective:

1. Inspect current dirty git state.
2. Derive a minimal sanitized fixture subset from the local snapshot.
3. Add characterization tests around the pure prioritization logic currently embedded in `sidepanel.js`.
4. Only after the tests exist, extract the pure prioritization helpers from `sidepanel.js`.
5. Re-run the verification gate after that slice.

## Suggested Fresh-Session Prompt

```text
Read HANDOFF.md first, then REFACTOR_PLAN.md, then inspect the current repo state and continue Phase 2.

Constraints:
- Work incrementally.
- Add characterization tests before refactoring.
- Re-run the verification gate after each slice.
- Do not commit or copy the raw Slack snapshot into the repo.
- Avoid touching already-dirty files unless needed for the current slice.

Useful local snapshot source:
/Users/gem_1/Downloads/fslack-snapshot-2026-03-30-21-53.json

Before editing, summarize the current dirty git state and explain exactly which files you plan to touch in this slice.
```
