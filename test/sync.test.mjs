import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the workspace; paths reads $VISUALLY_HOME at load.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'vt-sync-home-'));
process.env.VISUALLY_HOME = HOME;

const { syncScene } = await import('../lib/sync.js');

// Seed a fake workspace for scene "demo".
const id = 'demo';
mkdirSync(path.join(HOME, 'scenes'), { recursive: true });
writeFileSync(path.join(HOME, 'scenes', `${id}.json`), JSON.stringify({ machine_name: 'Demo', parts: [{ id: 'a' }] }));
mkdirSync(path.join(HOME, 'runs', id, 'improve-20260101-000000'), { recursive: true });
writeFileSync(path.join(HOME, 'runs', id, 'improve-20260101-000000', 'iter-00.json'), '{}');
writeFileSync(path.join(HOME, 'runs', id, 'improve-20260101-000000', 'iter-01-render.png'), 'PNGDATA');
mkdirSync(path.join(HOME, 'evidence', id), { recursive: true });
writeFileSync(path.join(HOME, 'evidence', id, 'paper.md'), '# Evidence');
mkdirSync(path.join(HOME, 'impls', id), { recursive: true });
writeFileSync(path.join(HOME, 'impls', id, 'meta.json'), '{}');

test('syncScene mirrors scene + full runs (incl PNG) + evidence + impl as-is', () => {
  const dest = mkdtempSync(path.join(os.tmpdir(), 'vt-sync-dest-'));
  const r = syncScene(id, { dest });
  assert.equal(r.scene, true);
  assert.ok(r.runs >= 2, `expected ≥2 run files, got ${r.runs}`);
  assert.equal(r.evidence, 1);
  assert.equal(r.impl, 1);
  assert.ok(existsSync(path.join(dest, 'scene.json')));
  assert.ok(existsSync(path.join(dest, 'runs', 'improve-20260101-000000', 'iter-01-render.png')));
  assert.ok(existsSync(path.join(dest, 'evidence', 'paper.md')));
  assert.ok(existsSync(path.join(dest, 'impl', 'meta.json')));
  assert.equal(readFileSync(path.join(dest, 'evidence', 'paper.md'), 'utf8'), '# Evidence');
});

test('syncScene preserves a curated notes.md and drops stale mirrored files', () => {
  const dest = mkdtempSync(path.join(os.tmpdir(), 'vt-sync-dest2-'));
  // a hand-authored note that must survive, plus a stale run from a prior sync
  writeFileSync(path.join(dest, 'notes.md'), 'curated');
  mkdirSync(path.join(dest, 'runs', 'old-run'), { recursive: true });
  writeFileSync(path.join(dest, 'runs', 'old-run', 'gone.txt'), 'stale');
  syncScene(id, { dest });
  assert.equal(readFileSync(path.join(dest, 'notes.md'), 'utf8'), 'curated', 'notes.md preserved');
  assert.ok(!existsSync(path.join(dest, 'runs', 'old-run')), 'stale mirrored run removed');
  assert.ok(existsSync(path.join(dest, 'runs', 'improve-20260101-000000')), 'fresh run present');
});
