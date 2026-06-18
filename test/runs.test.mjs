import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.VISUALLY_HOME = mkdtempSync(path.join(os.tmpdir(), 'vh-'));
const { listRunsForScene, getRunDetail, resolveArtifact } = await import('../lib/runs.js');
const { RUNS_DIR, migrateLegacyRuns, runDir } = await import('../lib/paths.js');

function seedImprove(id, stamp) {
  const dir = runDir(id, 'improve', stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'iter-01-render.png'), 'PNG');
  writeFileSync(path.join(dir, 'iter-01.json'), JSON.stringify({ parts: [] }));
  writeFileSync(path.join(dir, 'iter-01-events.jsonl'), '{"type":"x"}\n');
  writeFileSync(path.join(dir, 'iter-01-review.json'), JSON.stringify({ total: 81 }));
  writeFileSync(path.join(dir, 'run.log'), 'self-improve: done\n');
  return dir;
}

test('lists runs newest-first with type/score/status', () => {
  seedImprove('robot', '20260101-000000');
  const reproDir = runDir('robot', 'reproduce', '20260102-000000');
  mkdirSync(reproDir, { recursive: true });
  writeFileSync(path.join(reproDir, 'report.json'), JSON.stringify({ reproducibility: 73 }));
  writeFileSync(path.join(reproDir, 'impl-1.py'), 'print(1)');

  const runs = listRunsForScene('robot');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].type, 'reproduce'); // newest first
  assert.equal(runs[0].score, 73);
  assert.equal(runs[0].iterations, 1);
  const improve = runs.find((r) => r.type === 'improve');
  assert.equal(improve.score, 81);
  assert.equal(improve.status, 'done');
});

test('run detail exposes iterations + artifacts; artifact path is jailed', () => {
  const detail = getRunDetail('robot', 'improve-20260101-000000');
  assert.equal(detail.type, 'improve');
  assert.equal(detail.iters[0].score, 81);
  assert.deepEqual(detail.highlights.scores, [81]);
  assert.ok(detail.artifacts.some((a) => a.kind === 'screenshot' && a.file === 'iter-01-render.png'));

  assert.ok(resolveArtifact('robot', 'improve-20260101-000000', 'iter-01.json'));
  assert.equal(resolveArtifact('robot', 'improve-20260101-000000', '../../../etc/passwd'), null);
});

test('reproduce highlights expose per-impl pass/fail + report summary', () => {
  const dir = runDir('robot', 'reproduce', '20260105-000000');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ reproducibility: 64, verdict: 'ambiguous', executable_verification: { enabled: true, passed: 1, total: 2 } }));
  writeFileSync(path.join(dir, 'impl-1.py'), 'print(1)');
  writeFileSync(path.join(dir, 'impl-1-verify.txt'), 'pass=true ran=true');
  writeFileSync(path.join(dir, 'impl-2.py'), 'print(2)');
  writeFileSync(path.join(dir, 'impl-2-verify.txt'), 'pass=false ran=true');

  const h = getRunDetail('robot', 'reproduce-20260105-000000').highlights;
  assert.equal(h.reproducibility, 64);
  assert.equal(h.verdict, 'ambiguous');
  assert.deepEqual(h.verify, { passed: 1, total: 2 });
  assert.deepEqual(h.impls.map((i) => [i.n, i.pass]), [[1, true], [2, false]]);
});

test('migrateLegacyRuns moves flat dirs into the per-scene tree', () => {
  // Seed a legacy flat improve dir (no prefix) and a create dir.
  const legacyImprove = path.join(RUNS_DIR, 'gizmo-20260103-101010');
  mkdirSync(legacyImprove, { recursive: true });
  writeFileSync(path.join(legacyImprove, 'iter-01.json'), '{}');
  const legacyCreate = path.join(RUNS_DIR, 'create-gizmo-20260103-090000');
  mkdirSync(legacyCreate, { recursive: true });
  writeFileSync(path.join(legacyCreate, 'scene.json'), '{}');

  migrateLegacyRuns();

  assert.ok(existsSync(runDir('gizmo', 'improve', '20260103-101010')));
  assert.ok(existsSync(runDir('gizmo', 'create', '20260103-090000')));
  assert.ok(!existsSync(legacyImprove));
  const runs = listRunsForScene('gizmo');
  assert.equal(runs.length, 2);
});
