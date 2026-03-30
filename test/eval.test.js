const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEvalReport } = require('../eval.js');

test('buildEvalReport summarizes disagreements, overrides, and pipeline details', () => {
  const report = buildEvalReport({
    exportedAt: '2026-03-30T12:00:00.000Z',
    assessLog: [
      {
        channel: 'eng',
        llmCategory: 'noise',
        userCategory: 'priority',
        summary: 'deploy approval request',
        itemId: 'thread_0',
      },
    ],
    pipeline: [
      {
        id: 'thread_0',
        channel: 'eng',
        summary: 'alex asked for deploy approval',
        rawText: 'Can you approve the deploy?',
        classification: ['noise', 'reason text'],
      },
    ],
    finalBuckets: [
      {
        llmId: 'thread_0',
        finalCategory: 'priority',
      },
    ],
  });

  assert.match(report, /=== fslack AI Eval Report ===/);
  assert.match(report, /Disagree rate: ~100\.0% \(1\/1\)/);
  assert.match(report, /Critical misses \(should be Priority, AI said Noise\/Relevant\): 1/);
  assert.match(report, /Deterministic overrides \(1 items\):/);
  assert.match(report, /LLM said: noise \| You said: priority/);
});

test('buildEvalReport handles empty disagreement logs', () => {
  const report = buildEvalReport({
    exportedAt: '2026-03-30T12:00:00.000Z',
    assessLog: [],
    pipeline: [],
    finalBuckets: [],
  });

  assert.match(report, /No disagreements logged yet\./);
});
