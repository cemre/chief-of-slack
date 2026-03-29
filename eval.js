#!/usr/bin/env node
// eval.js — Analyze fslack assessment data exported via Shift+E
// Usage: node eval.js fslack-eval-*.json

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.log('Usage: node eval.js <fslack-eval-export.json>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const log = data.assessLog || [];
const pipeline = data.pipeline || [];
const finalBuckets = data.finalBuckets || [];

console.log(`\n=== fslack AI Eval Report ===`);
console.log(`Exported: ${data.exportedAt}`);
console.log(`Total disagreements logged: ${log.length}`);
console.log(`Pipeline items: ${pipeline.length}`);
console.log(`Final bucketed items: ${finalBuckets.length}`);

// Category distribution
if (finalBuckets.length > 0) {
  console.log(`\nFinal bucket distribution:`);
  const dist = {};
  for (const i of finalBuckets) dist[i.finalCategory] = (dist[i.finalCategory] || 0) + 1;
  for (const [cat, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count} (${(count / finalBuckets.length * 100).toFixed(0)}%)`);
  }
}

// Disagree rate
if (log.length === 0) {
  console.log('\nNo disagreements logged yet. Use assessment mode to flag wrong classifications.\n');
} else {
  const total = finalBuckets.length || pipeline.length;
  if (total > 0) {
    console.log(`\nDisagree rate: ~${(log.length / total * 100).toFixed(1)}% (${log.length}/${total})`);
  }

  // Critical misses: priority/act_now items that AI put in noise
  const criticalMisses = log.filter(a =>
    (a.userCategory === 'act_now' || a.userCategory === 'priority') &&
    (a.llmCategory === 'noise' || a.llmCategory === 'when_free')
  );
  console.log(`\nCritical misses (should be Priority, AI said Noise/Relevant): ${criticalMisses.length}`);
  for (const m of criticalMisses) {
    console.log(`  [${m.llmCategory} → ${m.userCategory}] ${m.channel}: ${m.summary || m.itemText?.slice(0, 80) || '(no text)'}`);
  }

  // False urgency: noise/when_free items that AI put in act_now/priority
  const falseUrgency = log.filter(a =>
    (a.llmCategory === 'act_now' || a.llmCategory === 'priority') &&
    (a.userCategory === 'noise' || a.userCategory === 'when_free')
  );
  console.log(`\nFalse urgency (AI said Priority, should be Noise/Relevant): ${falseUrgency.length}`);
  for (const m of falseUrgency) {
    console.log(`  [${m.llmCategory} → ${m.userCategory}] ${m.channel}: ${m.summary || m.itemText?.slice(0, 80) || '(no text)'}`);
  }

  // Transition matrix
  console.log(`\nTransition matrix (LLM → User):`);
  const transitions = {};
  for (const a of log) {
    const key = `${a.llmCategory} → ${a.userCategory}`;
    transitions[key] = (transitions[key] || 0) + 1;
  }
  const sorted = Object.entries(transitions).sort((a, b) => b[1] - a[1]);
  for (const [key, count] of sorted) {
    console.log(`  ${key}: ${count}`);
  }
}

// Pipeline audit: show full chain for each item
if (pipeline.length > 0) {
  console.log(`\n=== Pipeline Audit (raw → summary → classification) ===`);

  // Show items where LLM classification differs from final bucket (deterministic overrides kicked in)
  const overrides = [];
  for (const p of pipeline) {
    const llmCat = Array.isArray(p.classification) ? p.classification[0] : p.classification;
    const final = finalBuckets.find(f => f.llmId === p.id);
    if (final && final.finalCategory !== llmCat) {
      overrides.push({ ...p, llmCat, finalCat: final.finalCategory });
    }
  }
  if (overrides.length > 0) {
    console.log(`\nDeterministic overrides (${overrides.length} items):`);
    for (const o of overrides) {
      console.log(`  ${o.id} [${o.llmCat} → ${o.finalCat}] ${o.channel}`);
      console.log(`    summary: ${o.summary}`);
      console.log(`    raw: ${(o.rawText || '').slice(0, 120)}`);
    }
  }

  // Show items where summary might have lost signal (flagged disagreements with pipeline data)
  if (log.length > 0) {
    console.log(`\n=== Disagreement Details (raw text → summary → classification) ===`);
    for (const entry of log) {
      // Try to find matching pipeline item
      const match = pipeline.find(p =>
        p.channel === entry.channel ||
        (entry.itemId && p.id === entry.itemId)
      );
      if (match) {
        const llmCat = Array.isArray(match.classification) ? match.classification[0] : match.classification;
        console.log(`\n  ${match.id} (${match.channel})`);
        console.log(`    LLM said: ${llmCat} | You said: ${entry.userCategory}`);
        console.log(`    Summary:  ${match.summary}`);
        console.log(`    Raw text: ${(match.rawText || '').slice(0, 200)}`);
        if (match.rawReplies) console.log(`    Replies:  ${match.rawReplies.slice(0, 200)}`);
        console.log(`    Reason:   ${Array.isArray(match.classification) ? match.classification[2] || '' : match.reason || ''}`);
      } else {
        console.log(`\n  (no pipeline match) ${entry.channel}`);
        console.log(`    LLM said: ${entry.llmCategory} | You said: ${entry.userCategory}`);
        console.log(`    Text: ${entry.summary || entry.itemText || '(none)'}`);
      }
    }
  }
}

console.log('');
