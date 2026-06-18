import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBackend, listBackends, defaultBackendFor, DEFAULT_BACKEND } from '../lib/backends/index.js';

test('registry contains the python-smt and sim backends', () => {
  assert.deepEqual(listBackends().sort(), ['python-smt', 'sim']);
  assert.equal(DEFAULT_BACKEND, 'python-smt');
});

test('defaultBackendFor maps mode → substrate', () => {
  assert.equal(defaultBackendFor('algorithm'), 'python-smt');
  assert.equal(defaultBackendFor('hardware'), 'sim');
  assert.equal(defaultBackendFor('architecture'), 'sim');
});

test('getBackend throws on an unknown backend', () => {
  assert.throws(() => getBackend('nope'), /unknown backend/);
});

test('every backend implements the common interface', () => {
  for (const id of listBackends()) {
    const b = getBackend(id);
    assert.equal(b.id, id);
    assert.equal(typeof b.label, 'string');
    assert.equal(typeof b.available, 'function');
    assert.equal(typeof b.implementInstructions, 'function');
    assert.equal(typeof b.verify, 'function');
    assert.ok(b.implementInstructions().length > 50);
  }
});

test('available() returns a well-shaped result', async () => {
  for (const id of listBackends()) {
    const a = await getBackend(id).available();
    assert.equal(typeof a.ok, 'boolean');
    if (!a.ok) assert.equal(typeof a.reason, 'string');
  }
});

// Integration: only runs where the toolchain is present (skipped in bare CI).
test('python-smt verify() runs a passing script (if z3 available)', async (t) => {
  const b = getBackend('python-smt');
  const a = await b.available();
  if (!a.ok) return t.skip(`z3 unavailable: ${a.reason}`);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vt-'));
  const ok = await b.verify('print("VERIFIED")', dir);
  assert.equal(ok.pass, true);
  const bad = await b.verify('import sys; print("FAIL: x"); sys.exit(1)', dir);
  assert.equal(bad.pass, false);
});

test('verify() reports gracefully when given no script', async () => {
  const r = await getBackend('python-smt').verify('', mkdtempSync(path.join(os.tmpdir(), 'vt-')));
  assert.equal(r.pass, false);
});
