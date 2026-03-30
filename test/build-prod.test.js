const test = require('node:test');
const assert = require('node:assert/strict');

const { strip } = require('../scripts/build-prod.js');

test('strip removes DEV_ONLY blocks from js/css/html files', () => {
  const js = 'a();\n/* DEV_ONLY_START */\nsecret();\n/* DEV_ONLY_END */\nb();\n';
  const css = '.x{}\n/* DEV_ONLY_START */\n.dev{}\n/* DEV_ONLY_END */\n.y{}\n';
  const html = '<div>keep</div>\n<!-- DEV_ONLY_START --><div>remove</div><!-- DEV_ONLY_END -->\n<div>end</div>\n';

  assert.equal(strip(js, '.js'), 'a();\n\nb();\n');
  assert.equal(strip(css, '.css'), '.x{}\n\n.y{}\n');
  assert.equal(strip(html, '.html'), '<div>keep</div>\n\n<div>end</div>\n');
});
