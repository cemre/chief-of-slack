#!/usr/bin/env node
// Build a production copy of the extension with dev-only code stripped.
// Usage: node scripts/build-prod.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Files to skip entirely (dev-only)
const SKIP = new Set(['eval.js', 'EVAL.md', 'CLAUDE.md', '.gitignore', 'dist', '_metadata', 'scripts', '.git', '.DS_Store']);

// Strip /* DEV_ONLY_START */ ... /* DEV_ONLY_END */ (JS/CSS)
// Handles both multiline blocks and inline (same-line) markers
const JS_RE = /\/\*\s*DEV_ONLY_START\s*\*\/[\s\S]*?\/\*\s*DEV_ONLY_END\s*\*\//g;

// Strip <!-- DEV_ONLY_START --> ... <!-- DEV_ONLY_END --> (HTML)
const HTML_RE = /<!--\s*DEV_ONLY_START\s*-->[\s\S]*?<!--\s*DEV_ONLY_END\s*-->/g;

// Clean up leftover blank lines (3+ consecutive newlines → 2)
const BLANK_RE = /\n{3,}/g;

function strip(content, ext) {
  let out = content;
  if (['.js', '.css'].includes(ext)) out = out.replace(JS_RE, '');
  if (ext === '.html') out = out.replace(HTML_RE, '');
  return out.replace(BLANK_RE, '\n\n');
}

// Recreate dist/
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
fs.mkdirSync(DIST);

let stripped = 0;
let copied = 0;

for (const entry of fs.readdirSync(ROOT)) {
  if (SKIP.has(entry)) continue;
  const src = path.join(ROOT, entry);
  const dest = path.join(DIST, entry);
  const stat = fs.statSync(src);

  if (stat.isDirectory()) continue; // skip subdirectories

  const ext = path.extname(entry);
  if (['.js', '.css', '.html'].includes(ext)) {
    const before = fs.readFileSync(src, 'utf8');
    const after = strip(before, ext);
    fs.writeFileSync(dest, after);
    if (after.length < before.length) {
      stripped++;
      console.log(`  stripped: ${entry} (${before.length - after.length} bytes removed)`);
    } else {
      copied++;
    }
  } else {
    fs.copyFileSync(src, dest);
    copied++;
  }
}

console.log(`\nDone → dist/  (${stripped} stripped, ${copied} copied)`);
