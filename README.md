# Chief of Slack

Chief of Slack puts all your unreads — DMs, mentions, threads, channels — in one place, sorted by what actually needs you. Before you open a single message, you already know what each one is about and how urgent it is.

Powered by Claude, it reads your messages and understands context — not keywords; differentiating "Can you approve this PR?" from "FYI, I approved the PR". 

## Features

- **Private by design** — no backend, no account, no tracking. Messages go directly from your browser to Anthropic's API with your own key
- **Personalized prioritization** — describe your role and what matters to you so the AI prioritizes accordingly.
- **Three sections** - high priority items shown right away (things blocked on you are color coded red), relevant channel messages and noise split out. You can map your Slack sidebar sections to the extension's sections
- **One-line summaries** — know what each message is about before you open it
- **Keyboard navigation** — arrow through unreads, mark as read, without touching your mouse
- **VIP tracking** — Define VIPs in Slack, and keep tabs on what they're posting (even in channels you're not in)
- **Bulk mark-as-read** — clear many messages in a single click.
- **Cost tracking** — see exactly what you're spending 
- **Stay in browser** - links no longer get hijacked to the Slack desktop app


## Installation

1. Go to the [latest release](https://github.com/cemre/chief-of-slack/releases) or click the green **Code** button, then **Download ZIP**
2. Unzip the downloaded file
3. Open `chrome://extensions/` in Chrome
4. Enable **Developer mode** (toggle in the top-right corner)
5. Click **Load unpacked** and select the unzipped folder
6. Click the extension icon and enter your [Anthropic API key](https://console.anthropic.com/settings/keys)

## Usage

1. Open [Slack in Chrome](https://app.slack.com)
2. Click the 🫡 Chief of Slack icon in your toolbar to open the side panel
3. Configure your API key
4. Your unreads are fetched, summarized, and prioritized automatically

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate |
| `→` / `←` | Expand / collapse |
| `m` | Mark as read (advances to next) |
| `Shift+m` | Mark unread |
| `o` | Open in Slack |
| `r` | Reply |
| `t` | Mute thread or channel |
| `l` | React with :+1: |
| `h` | React with :yellow_heart: |
| `s` | Save message |
| `Esc` | Unfocus current item |


## Requirements

- Chromium based browser
- [Slack web app](https://app.slack.com) (not the desktop app)
- [Anthropic API key](https://console.anthropic.com/settings/keys) (uses Claude Haiku)

## License

[GPL-3.0](LICENSE)
