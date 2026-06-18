import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBackend, listBackends, defaultBackendFor, selectBackend, DEFAULT_BACKEND } from '../lib/backends/index.js';

const hw = (machine_name, extra = {}) => ({
  machine_name, metadata: { mode: 'hardware' }, parts: [], ...extra,
});

test('registry contains the python-smt and sim backends', () => {
  assert.deepEqual(listBackends().sort(), ['python-smt', 'sim']);
  assert.equal(DEFAULT_BACKEND, 'python-smt');
});

test('defaultBackendFor maps mode → substrate', () => {
  assert.equal(defaultBackendFor('algorithm'), 'python-smt');
  assert.equal(defaultBackendFor('hardware'), 'sim');
  assert.equal(defaultBackendFor('architecture'), 'sim');
});

test('selectBackend auto-routes digital/compute hardware → SMT', () => {
  assert.equal(selectBackend(hw('CFNTT Radix-2/4 NTT Accelerator (FPGA)')), 'python-smt');
  assert.equal(selectBackend(hw('RISC-V 5-stage pipeline CPU')), 'python-smt');
  assert.equal(selectBackend(hw('Systolic GEMM GPU tensor core')), 'python-smt');
  assert.equal(selectBackend(hw('AES-256 crypto ASIC')), 'python-smt');
});

test('selectBackend auto-routes physical machines → sim', () => {
  assert.equal(selectBackend(hw('Prusa i3 MK3S 3D printer')), 'sim');
  assert.equal(selectBackend(hw('6-axis industrial robot arm')), 'sim');
  assert.equal(selectBackend(hw('Wind turbine gearbox')), 'sim');
});

test('selectBackend uses domain/info text, not just the title', () => {
  const s = hw('CFNTT core', { metadata: { mode: 'hardware', domain: 'cryptographic-hardware', info: { summary: 'an FPGA NTT butterfly datapath with BRAM banks' } } });
  assert.equal(selectBackend(s), 'python-smt');
});

test('selectBackend: explicit override and mode take precedence', () => {
  assert.equal(selectBackend(hw('robot arm', { metadata: { mode: 'hardware', backend: 'python-smt' } })), 'python-smt');
  assert.equal(selectBackend({ machine_name: 'DeepSeek MoE attention', metadata: { mode: 'algorithm' }, parts: [] }), 'python-smt');
  assert.equal(selectBackend({ machine_name: '清水寺 本堂', metadata: { mode: 'architecture' }, parts: [] }), 'sim');
});

test('selectBackend falls back to sim for unclassifiable hardware', () => {
  assert.equal(selectBackend(hw('mysterious contraption')), 'sim');
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
