# Product Marketing Notes

## Name Recommendation

**Slack Triage** (primary pick) or **Unreads**

Reasoning:
- Name must include "Slack" for store discoverability
- "Triage" resonates with target audience (busy ICs/managers) and implies intelligent sorting
- "Attention Firewall" works great as a tagline, not as the store name — "firewall" has security connotations and no one searches for it

Tagline options:
- "An attention firewall for busy teams"
- "See only what needs your attention"
- "Only what needs you gets through"

## Conversational Pitch

### The Core Insight

It's 2026. AI can write code, generate movies, and pass the bar exam. But when you open Slack, you still read every message one by one, in whatever order they came in. Your email has had priority inbox for 15 years. Why doesn't Slack?

### The Fragmentation Problem (Most Relatable Hook)

Your Slack unreads are scattered across four different places: DMs, Mentions, Threads, and the Unreads view. None of them talk to each other. None of them are sorted by urgency. You hop between tabs, clicking through each one, doing the prioritization in your head.

12 unread DMs — click through each one to find out which is "sounds good" and which is your manager asking for something urgent. 8 unread channels — click into each to see if anything's relevant. 5 thread replies — open each to remember what the conversation was even about.

This extension puts it all in one place, sorted by what actually needs you.

### Four Layers of Value

1. **One view, not four** — DMs, mentions, threads, and channel activity in a single prioritized list. No more hopping between Slack's fragmented inboxes.

2. **Summarizes before you read** — you know what each message is about without opening it. You're not clicking into a 47-message thread to figure out if it needs you. You read one line and decide.

3. **Prioritizes within mentions and DMs** — not all red badges are equal. Someone blocked waiting on your approval is not the same as "FYI looping you in." Slack treats them identically. This doesn't.

4. **Elevates from noise channels without muting them** — you don't have to banish entire channels into mute. A channel that's 95% noise can still have the one thread where someone needs your sign-off. This catches it. You stop managing channels and start managing attention.

### The Sidebar Sections Angle

You already organized your Slack sidebar into sections. This extension respects that — set a rule per section (auto-prioritize, auto-noise, exclude) and you're done. No duplicate configuration. Your existing organization carries over.

### Full Pitch (Combining All Angles)

It's 2026. AI can write code, generate movies, and pass the bar exam. But when you open Slack, you still click through every unread message one by one — first your DMs, then Mentions, then Threads, then the Unreads view — doing the prioritization in your head.

Your email has had priority inbox for 15 years. Why doesn't Slack?

This extension puts all your unreads — DMs, mentions, threads, channels — in one place, sorted by what actually needs you. Before you open a single message, you already know what each one is about and how urgent it is.

Someone blocked waiting on your approval? Red, top of the list, one-line summary of what they need. A DM that's just "thanks!"? Batched. A thread you already replied to where people are just saying "agreed"? Gone.

You don't have to mute entire channels anymore either. Low-priority channels get scanned and anything relevant to you gets elevated. You stop hopping between four inboxes and start making decisions.

---

## Store Listing

**Short description** (132 char max):
> AI-powered Slack triage. Classifies your unreads by urgency so you see what needs attention now and skip the noise.

**Detailed description:**

> Slack scatters your unreads across DMs, Mentions, Threads, and the Unreads view — four separate inboxes, none sorted by urgency. You click through each one, doing the prioritization in your head. That's Slack in 2026.
>
> This extension puts everything in one place and tells you what each message is about and whether it's urgent — before you open it.
>
> Open the side panel, and every unread across your channels, DMs, and threads appears in a single list, classified: act now, priority, when free, or noise. Someone blocked on your approval? Red, top of the list, one-line summary. A DM that's just "thanks"? Batched with the rest.
>
> You don't have to mute entire channels anymore. Low-priority channels get scanned and anything relevant to you gets elevated — no more choosing between "this channel interrupts me" and "I might miss something."
>
> **Features:**
> - AI priority classification powered by Claude — understands context, not just keywords
> - Summarizes messages before you read them — know what it's about in one line
> - Prioritizes within your mentions and DMs — not all red badges are equal
> - Uses your existing Slack sidebar sections — set rules per section and you're done
> - VIP tracking — highlights activity from people you care about most
> - "About me" context so the AI knows what's relevant to your role
> - Mark-as-read in bulk by priority group
> - All data stays local — no backend, no account, no tracking
>
> **Requirements:**
> - Slack web app (app.slack.com)
> - Your own Anthropic API key (uses Claude Haiku — very cheap, typically pennies/day)
>
> Built for engineers, PMs, and managers drowning in Slack.

## Screenshots Plan (5 for the store, 1280x800)

1. **Hero: Side panel in action** — Sidepanel open next to Slack with messages sorted into Act Now (red), Priority (orange), When Free (blue), Noise (gray). Use demo mode to anonymize. This is the money shot.

2. **Before/after** — Left: Slack with 47 unread channels, red badges everywhere. Right: Sidepanel showing 3 items under Act Now. Caption: "47 unreads → 3 that matter"

3. **VIP summary view** — VIP section with bullet-point summaries. Caption: "Know what your VIPs are saying without reading every message"

4. **Sidebar section rules** — Settings page showing section rules configured. Caption: "Already organized your Slack sidebar? Set a rule per section and you're done."

5. **Cost transparency** — Token usage / cost tracker showing near-zero spend. Caption: "Pennies a day — runs on Claude Haiku with your own API key"

Tips:
- Use demo mode (checkbox in sidepanel) to anonymize before capturing
- Use a workspace with realistic volume (20+ unreads)
- Dark sidepanel against Slack's dark theme looks cohesive
- Add minimal text overlays — don't clutter

## Positioning

**Target audience:** ICs and managers at companies with 50+ people on Slack. The person who opens Slack in the morning to 40+ unread channels and feels dread.

**Key differentiator:** Not a notification filter or keyword matcher. It reads your messages and understands context — "someone asked you a question and is waiting" vs. "someone reacted to your message." No other extension does this.

**Sidebar sections angle:** You already organized your Slack sidebar. This extension respects that. Zero setup for basic use, no duplicate configuration, granular control without complexity.

**Privacy note to address:** Message text goes to Anthropic's API for classification, but you use your own API key, no middleman server, nothing stored. Be upfront about this.

## Go-to-Market

**No competition exists in the store** — first mover advantage, but also means:
- Must explain the category, not just the product
- Start with the problem, not the solution
- Screenshots do heavy lifting (people need to *see* it to get it)
- SEO matters more than branding — pack description with search terms: "Slack unread," "Slack notifications," "Slack too many messages," "Slack noise"
- A 15-second video/GIF of the triage flow builds trust faster than copy
- Launch channels: Hacker News, r/slack, r/productivity, LinkedIn (Slack overload is a known pain point there)
