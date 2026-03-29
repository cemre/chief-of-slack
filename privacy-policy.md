# Privacy Policy — Chief of Slack

**Last updated:** March 27, 2026

## Summary

Chief of Slack processes your Slack messages locally in your browser and sends them to the Anthropic API for AI classification. There is no middleman server, no account to create, and no data collected by us. Your API key and all settings stay in your browser.

## What data is processed

- **Slack message text**: Unread messages, DMs, thread replies, and channel messages visible in the Slack web app are read from the page by a content script.
- **User-provided settings**: Your Anthropic API key, VIP list, sidebar section rules, "about me" description, and display preferences.

## How data is used

Message text is sent directly from your browser to the Anthropic API (api.anthropic.com) for priority classification and summarization. The extension uses this to sort your unreads by urgency and generate one-line summaries.

No data is sent to any other server. There is no backend, proxy, or analytics service.

## Data storage

All data is stored locally in your browser using Chrome's storage API (chrome.storage.local). This includes:

- Your Anthropic API key
- Your extension settings and preferences
- Cached classification results

Nothing is stored on any external server. Uninstalling the extension removes all stored data.

## Third-party services

The only third-party service used is the **Anthropic API** (api.anthropic.com). Message text is sent to Anthropic for AI processing using your own API key. Anthropic's data handling is governed by their own privacy policy and API terms of service at https://www.anthropic.com/privacy.

Per Anthropic's API terms, data sent through the API is not used to train their models.

## Data sharing

We do not collect, store, share, or sell any user data. We have no servers and no ability to access your data.

## Your control

- You can stop all AI processing by closing the side panel.
- You can delete all stored data by uninstalling the extension or clearing extension storage.
- You can inspect every API request in Chrome DevTools.

## Contact

If you have questions about this privacy policy, open an issue at https://github.com/nicobailon/chief-of-slack.
