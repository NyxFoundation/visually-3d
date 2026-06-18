import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../lib/backends/python-smt.js';

test('timeout is detected from killed / SIGTERM', () => {
  assert.equal(classifyFailure({ killed: true, signal: 'SIGTERM' }, '', ''), 'timeout');
  assert.equal(classifyFailure({ message: 'Command failed: timed out' }, '', ''), 'timeout');
});

test('an invalid literal is a syntax error, not a wrong impl', () => {
  // the exact class that broke ntt-fpga round 2: random.Random(0xCFNTT)
  const stderr = 'File "check.py", line 261\n    rng = random.Random(0xCFNTT)\nSyntaxError: invalid hexadecimal literal';
  assert.equal(classifyFailure({ code: 1 }, '', stderr), 'syntax');
});

test('a clean FAIL verdict is a semantic failure', () => {
  assert.equal(classifyFailure({ code: 1 }, 'FAIL: N^-1 mismatch: spec 8857 != 12277', ''), 'fail');
});

test('an uncaught exception is a harness error, not a verdict', () => {
  const stderr = 'Traceback (most recent call last):\n  File "check.py", line 9\nValueError: bad';
  assert.equal(classifyFailure({ code: 1 }, '', stderr), 'error');
});

test('an unexplained non-zero exit defaults to fail', () => {
  assert.equal(classifyFailure({ code: 1 }, '', ''), 'fail');
});
