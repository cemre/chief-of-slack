# AI Quality Evaluation

## Overview

The app uses Claude Haiku in a 2-step pipeline:
1. **Batch summarize** — condense each Slack item to ~25 words
2. **Prioritize** — classify each item into act_now / priority / when_free / noise

After the LLM, deterministic rules override certain classifications (DMs bump to priority, @mentions floor to priority, sidebar section rules, etc.).

The main thing to evaluate is whether items end up in the **right bucket**. Summary quality only matters insofar as it causes misclassification.

## Assessment Mode

### Setup

1. Hover over the bottom-right corner of the sidepanel (nearly invisible controls appear)
2. Check the checkbox next to the 🧪 icon
3. Every item now shows a 👎 button at its top-right corner

### Flagging Errors

1. When you see an item in the wrong bucket, click 👎
2. A picker appears with the other categories — click the correct one
3. The button updates to show `👎 → Priority` (or whichever you picked)
4. The disagreement is logged and persisted automatically

### What Gets Logged

Each disagreement records:
- Timestamp
- LLM's category vs your chosen category
- Channel name, summary, reason text
- Item ID (for matching back to raw data)

Logs persist across sessions in `chrome.storage.local`.

## Exporting Data

Press **Shift+E** (when not in a text field) to download a JSON export containing:

- `assessLog` — all your disagreement entries
- `stats` — computed metrics (critical misses, false urgency, transition matrix)
- `currentItems` — every item in the current view with its AI-assigned category and metadata

## Analyzing Results

```bash
node eval.js fslack-eval-2026-03-29-12-00.json
```

The script prints:
- **Disagree rate** — flagged items / total items
- **Critical misses** — items you said should be Priority/Act Now but AI put in Noise/Relevant (worst failure mode)
- **False urgency** — items AI put in Priority/Act Now but should be Noise/Relevant (annoying but less harmful)
- **Transition matrix** — counts of each `llmCategory → userCategory` pair
- **Category distribution** — how the AI distributed items across buckets

## How to Use This

### Daily (passive)

Leave assessment mode on. Flag wrong items as you encounter them. Takes ~1 extra second per error. Over a week you'll accumulate enough data to see patterns.

### When Changing Prompts

1. Export before the change (Shift+E)
2. Make the prompt change
3. Refresh the inbox
4. Export after
5. Compare the two eval reports

### Key Metrics to Watch

| Metric | Threshold | Action |
|--------|-----------|--------|
| Disagree rate > 15% | Prompt needs work | Revise classification criteria |
| Critical misses > 5% | Dangerous | Add deterministic rules or upgrade model |
| False urgency > 20% | Annoying | Tighten act_now/priority definitions |
| One specific transition dominates | Systematic bias | Fix that specific case in prompt |

### Golden Set Approach

The disagree-only workflow is the 80/20: assume unflagged items are correct, flagged items are wrong. This gives you an implicit golden set with zero extra effort.

If you need precise accuracy numbers (e.g., when iterating on prompts), export via Shift+E and manually add a `humanCategory` field to every item in `currentItems`. Then compare `category` vs `humanCategory` for full precision/recall metrics.
