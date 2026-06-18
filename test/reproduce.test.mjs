import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFencedCode, deescapeIfNeeded, parseImpl } from '../lib/reproduce.js';

test('extractFencedCode pulls a program out of a fenced block', () => {
  const text = 'prose\n```python\nprint("hi")\nx = 1\n```\nmore';
  assert.equal(extractFencedCode(text), 'print("hi")\nx = 1\n');
});

test('extractFencedCode prefers the program over a metadata JSON block', () => {
  const text = '```json\n{"confidence": 9}\n```\n```python\nimport sys\nprint("VERIFIED")\n```';
  const code = extractFencedCode(text);
  assert.ok(code.includes('print("VERIFIED")'));
  assert.ok(!code.includes('confidence'));
});

test('extractFencedCode returns null when there is no fenced block', () => {
  assert.equal(extractFencedCode('just text, no fences'), null);
});

test('deescapeIfNeeded fixes a program delivered with literal \\n', () => {
  const mangled = 'import sys\\nimport os\\nprint("x")\\nsys.exit(0)\\n\\nfoo()';
  const fixed = deescapeIfNeeded(mangled);
  assert.ok(fixed.includes('\n'), 'should contain real newlines');
  assert.ok(!/\\n/.test(fixed), 'should not contain literal backslash-n');
});

test('deescapeIfNeeded leaves a normal multi-line program alone', () => {
  const ok = 'import sys\nprint("ok")\nsys.exit(0)\n';
  assert.equal(deescapeIfNeeded(ok), ok);
});

test('parseImpl merges metadata JSON with the fenced program', () => {
  const text = [
    '{"language":"python","guessed":["q"],"underspecified":["width"],"confidence":42}',
    '```python',
    'print("VERIFIED")',
    '```',
  ].join('\n');
  const im = parseImpl(text);
  assert.equal(im.confidence, 42);
  assert.deepEqual(im.guessed, ['q']);
  assert.ok(im.script.includes('print("VERIFIED")'));
  assert.equal(im.implementation, im.script);
});
