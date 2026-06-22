import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the workspace; paths reads $VISUALLY_HOME at load.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'vt-verify-'));
process.env.VISUALLY_HOME = HOME;

const { verifyStep, buildSourceVerifyPrompt } = await import('../lib/verify.js');

const scene = {
  machine_name: 'CFNTT',
  metadata: { mode: 'hardware', info: { sources: [{ url: 'https://example/paper' }] }, spec: { params: { q: 12289 } } },
  parts: [{ id: 'bu', name: 'butterfly', role: 'compute', spec: { ops: ['mod-mul'] } }],
};

test('buildSourceVerifyPrompt grounds on the REAL source, not reverse-implementation', () => {
  const ev = { id: 'x', paper: '[paper:Sec III] bank(i)=(i^(i>>3)) mod 8', notes: 'CFNTT notes', origin: 'workspace' };
  const p = buildSourceVerifyPrompt(scene, ev, 'BACKEND-INSTRUCTIONS-HERE');
  assert.ok(/FORMALLY VERIFYING a REAL/.test(p));
  assert.ok(p.includes('BACKEND-INSTRUCTIONS-HERE')); // backend's two-tier rules included
  assert.ok(p.includes('bank(i)=(i^(i>>3)) mod 8')); // the real source rides along
  assert.ok(/NOT\s+reverse-implementing/i.test(p));
});

test('buildSourceVerifyPrompt points at the CLONED tree when one exists', () => {
  const ev = { id: 'x', paper: 'notes', notes: null, sourceDir: '/home/u/.visually-3d/evidence/x/source', origin: 'workspace' };
  const p = buildSourceVerifyPrompt(scene, ev, 'BACKEND');
  assert.ok(p.includes('/home/u/.visually-3d/evidence/x/source'));
  assert.ok(/ls -R|grep|cat/.test(p)); // told to read the real files
});

test('verifyStep errors when there is no gathered source', async () => {
  const id = 'no-src';
  mkdirSync(path.join(HOME, 'scenes'), { recursive: true });
  writeFileSync(path.join(HOME, 'scenes', `${id}.json`), JSON.stringify(scene));
  await assert.rejects(() => verifyStep(id), /no source evidence/);
});
