#!/usr/bin/env node

// Generates a lean {shortcode: unicode_string} map from emoji-datasource
// and writes it to ../standard-emoji.json

const fs = require('fs');
const path = require('path');

// Skin tone modifier codepoints (Fitzpatrick scale)
const SKIN_TONE_CODEPOINTS = new Set([
  '1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF',
]);

async function main() {
  const url = 'https://cdn.jsdelivr.net/npm/emoji-datasource/emoji.json';
  console.log(`Fetching ${url} ...`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const emojis = await res.json();

  const map = {};

  for (const entry of emojis) {
    // Skip entries that ARE skin tone variants (unified contains a skin tone modifier)
    const codepoints = entry.unified.split('-');
    if (codepoints.some(cp => SKIN_TONE_CODEPOINTS.has(cp.toUpperCase()))) {
      continue;
    }

    // Convert unified hex codepoints to actual Unicode string
    const unicode = String.fromCodePoint(
      ...codepoints.map(cp => parseInt(cp, 16))
    );

    // Add an entry for each short_name
    for (const name of entry.short_names) {
      map[name] = unicode;
    }
  }

  const outPath = path.resolve(__dirname, '..', 'standard-emoji.json');
  fs.writeFileSync(outPath, JSON.stringify(map, null, 2) + '\n');

  const count = Object.keys(map).length;
  console.log(`Wrote ${count} shortcode entries to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
