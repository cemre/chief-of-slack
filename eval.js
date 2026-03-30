#!/usr/bin/env node
// eval.js — Analyze fslack assessment data exported via Shift+E
// Usage: node eval.js fslack-eval-*.json

const fs = require('fs');

function buildEvalReport(data) {
  const log = data.assessLog || [];
  const pipeline = data.pipeline || [];
  const finalBuckets = data.finalBuckets || [];
  const lines = [];

  lines.push('');
  lines.push('=== fslack AI Eval Report ===');
  lines.push(`Exported: ${data.exportedAt}`);
  lines.push(`Total disagreements logged: ${log.length}`);
  lines.push(`Pipeline items: ${pipeline.length}`);
  lines.push(`Final bucketed items: ${finalBuckets.length}`);

  if (finalBuckets.length > 0) {
    lines.push('');
    lines.push('Final bucket distribution:');
    const dist = {};
    for (const i of finalBuckets) dist[i.finalCategory] = (dist[i.finalCategory] || 0) + 1;
    for (const [cat, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${cat}: ${count} (${(count / finalBuckets.length * 100).toFixed(0)}%)`);
    }
  }

  if (log.length === 0) {
    lines.push('');
    lines.push('No disagreements logged yet. Use assessment mode to flag wrong classifications.');
    lines.push('');
  } else {
    const total = finalBuckets.length || pipeline.length;
    if (total > 0) {
      lines.push('');
      lines.push(`Disagree rate: ~${(log.length / total * 100).toFixed(1)}% (${log.length}/${total})`);
    }

    const criticalMisses = log.filter(a =>
      (a.userCategory === 'act_now' || a.userCategory === 'priority') &&
      (a.llmCategory === 'noise' || a.llmCategory === 'when_free')
    );
    lines.push('');
    lines.push(`Critical misses (should be Priority, AI said Noise/Relevant): ${criticalMisses.length}`);
    for (const m of criticalMisses) {
      lines.push(`  [${m.llmCategory} → ${m.userCategory}] ${m.channel}: ${m.summary || m.itemText?.slice(0, 80) || '(no text)'}`);
    }

    const falseUrgency = log.filter(a =>
      (a.llmCategory === 'act_now' || a.llmCategory === 'priority') &&
      (a.userCategory === 'noise' || a.userCategory === 'when_free')
    );
    lines.push('');
    lines.push(`False urgency (AI said Priority, should be Noise/Relevant): ${falseUrgency.length}`);
    for (const m of falseUrgency) {
      lines.push(`  [${m.llmCategory} → ${m.userCategory}] ${m.channel}: ${m.summary || m.itemText?.slice(0, 80) || '(no text)'}`);
    }

    lines.push('');
    lines.push('Transition matrix (LLM → User):');
    const transitions = {};
    for (const a of log) {
      const key = `${a.llmCategory} → ${a.userCategory}`;
      transitions[key] = (transitions[key] || 0) + 1;
    }
    const sorted = Object.entries(transitions).sort((a, b) => b[1] - a[1]);
    for (const [key, count] of sorted) {
      lines.push(`  ${key}: ${count}`);
    }
  }

  if (pipeline.length > 0) {
    lines.push('');
    lines.push('=== Pipeline Audit (raw → summary → classification) ===');

    const overrides = [];
    for (const p of pipeline) {
      const llmCat = Array.isArray(p.classification) ? p.classification[0] : p.classification;
      const final = finalBuckets.find(f => f.llmId === p.id);
      if (final && final.finalCategory !== llmCat) {
        overrides.push({ ...p, llmCat, finalCat: final.finalCategory });
      }
    }
    if (overrides.length > 0) {
      lines.push('');
      lines.push(`Deterministic overrides (${overrides.length} items):`);
      for (const o of overrides) {
        lines.push(`  ${o.id} [${o.llmCat} → ${o.finalCat}] ${o.channel}`);
        lines.push(`    summary: ${o.summary}`);
        lines.push(`    raw: ${(o.rawText || '').slice(0, 120)}`);
      }
    }

    if (log.length > 0) {
      lines.push('');
      lines.push('=== Disagreement Details (raw text → summary → classification) ===');
      for (const entry of log) {
        const match = pipeline.find(p =>
          p.channel === entry.channel ||
          (entry.itemId && p.id === entry.itemId)
        );
        if (match) {
          const llmCat = Array.isArray(match.classification) ? match.classification[0] : match.classification;
          lines.push('');
          lines.push(`  ${match.id} (${match.channel})`);
          lines.push(`    LLM said: ${llmCat} | You said: ${entry.userCategory}`);
          lines.push(`    Summary:  ${match.summary}`);
          lines.push(`    Raw text: ${(match.rawText || '').slice(0, 200)}`);
          if (match.rawReplies) lines.push(`    Replies:  ${match.rawReplies.slice(0, 200)}`);
          lines.push(`    Reason:   ${Array.isArray(match.classification) ? match.classification[2] || '' : match.reason || ''}`);
        } else {
          lines.push('');
          lines.push(`  (no pipeline match) ${entry.channel}`);
          lines.push(`    LLM said: ${entry.llmCategory} | You said: ${entry.userCategory}`);
          lines.push(`    Text: ${entry.summary || entry.itemText || '(none)'}`);
        }
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = { buildEvalReport };
}

if (typeof require !== 'undefined' && require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: node eval.js <fslack-eval-export.json>');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.stdout.write(buildEvalReport(data));
}
