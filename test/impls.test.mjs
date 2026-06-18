import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// paths.ts reads VISUALLY_HOME at module load, so set it before importing.
process.env.VISUALLY_HOME = mkdtempSync(path.join(os.tmpdir(), 'vh-'));
const { saveImpl, readImpl, implDir } = await import('../lib/impls.js');

test('saveImpl/readImpl round-trips code + meta + verify log', () => {
  const meta = {
    id: 'demo', mode: 'algorithm', language: 'python', ext: 'py',
    backend: 'python-smt', confidence: 88, reproducibility: 72,
    verdict: 'reproducible', verified: { pass: true, ran: true },
    savedAt: new Date().toISOString(), runDir: '/tmp/x',
  };
  saveImpl('demo', { code: 'print(1)\n', verifyLog: 'pass=true ran=true', meta });

  const got = readImpl('demo');
  assert.ok(got, 'impl should be readable');
  assert.equal(got.code, 'print(1)\n');
  assert.equal(got.meta.backend, 'python-smt');
  assert.equal(got.meta.language, 'python');
  assert.equal(got.meta.verified.pass, true);
  assert.equal(got.verifyLog, 'pass=true ran=true');
  assert.ok(implDir('demo').endsWith(path.join('impls', 'demo')));
});

test('readImpl returns null for an unknown id', () => {
  assert.equal(readImpl('does-not-exist'), null);
});
