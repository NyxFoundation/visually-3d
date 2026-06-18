import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.VISUALLY_HOME = mkdtempSync(path.join(os.tmpdir(), 'vh-'));
const { listTimeline, getFrameDetail } = await import('../lib/revisions.js');
const { runDir } = await import('../lib/paths.js');

function seed() {
  const create = runDir('printer', 'create', '20260101-100000');
  mkdirSync(create, { recursive: true });
  writeFileSync(path.join(create, 'scene.json'), JSON.stringify({ machine_name: 'Printer', parts: [{ id: 'frame', material: 'steel' }] }));

  const improve = runDir('printer', 'improve', '20260101-110000');
  mkdirSync(improve, { recursive: true });
  writeFileSync(path.join(improve, 'iter-01.json'), JSON.stringify({ machine_name: 'Printer', parts: [{ id: 'frame', material: 'aluminum' }, { id: 'bed', material: 'glass' }] }));
  writeFileSync(path.join(improve, 'iter-01-review.json'), JSON.stringify({ total: 80, critique: 'switch to aluminium', remaining_gaps: ['cables'] }));
  writeFileSync(path.join(improve, 'iter-01-render.png'), 'PNG');

  const repro = runDir('printer', 'reproduce', '20260101-120000');
  mkdirSync(repro, { recursive: true });
  writeFileSync(path.join(repro, 'report.json'), JSON.stringify({ reproducibility: 71, verdict: 'ambiguous', summary: 'spec omits bit widths', missing_fields: [{ kind: 'width', item: 'bus width' }], executable_verification: { enabled: true, passed: 1, total: 2 } }));
  writeFileSync(path.join(repro, 'impl-1.py'), 'def run():\n    return 1\n');
  writeFileSync(path.join(repro, 'impl-1-verify.txt'), 'pass=true ran=true');
}

test('timeline interleaves numbered revisions with verification markers', () => {
  seed();
  const t = listTimeline('printer');
  assert.equal(t.length, 3);
  assert.equal(t[0].kind, 'revision'); assert.equal(t[0].version, 0); assert.equal(t[0].source, 'created');
  assert.equal(t[1].kind, 'revision'); assert.equal(t[1].version, 1); assert.equal(t[1].score, 80);
  assert.equal(t[1].render.file, 'iter-01-render.png');
  assert.equal(t[1].scene.file, 'iter-01.json');
  assert.equal(t[0].scene.file, 'scene.json');
  assert.equal(t[2].kind, 'verification'); assert.equal(t[2].reproducibility, 71);
});

test('revision frame: reasoning + scene (structural) change', () => {
  const d = getFrameDetail('printer', 'improve-20260101-110000:1');
  assert.equal(d.kind, 'revision');
  assert.equal(d.changeKind, 'scene');
  assert.equal(d.reasoning.text, 'switch to aluminium');
  assert.deepEqual(d.reasoning.gaps, ['cables']);
  assert.deepEqual(d.structural.added.map((p) => p.id), ['bed']);
  const frame = d.structural.changed.find((c) => c.id === 'frame');
  assert.deepEqual(frame.fields.find((f) => f.field === 'material'), { field: 'material', before: 'steel', after: 'aluminum' });
  assert.ok(d.rawDiff.includes('- ') || d.rawDiff.includes('+ '));
});

test('verification frame: reasoning + impl (code) change', () => {
  const d = getFrameDetail('printer', 'reproduce-20260101-120000:v');
  assert.equal(d.kind, 'verification');
  assert.equal(d.changeKind, 'impl');
  assert.equal(d.score, 71); // reproducibility
  assert.equal(d.structural, null);
  assert.ok(d.rawDiff.length > 0); // first verification → all-added code diff
});

test('unknown frame key returns null', () => {
  assert.equal(getFrameDetail('printer', 'nope:9'), null);
});
