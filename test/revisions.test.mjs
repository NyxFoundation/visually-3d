import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.VISUALLY_HOME = mkdtempSync(path.join(os.tmpdir(), 'vh-'));
const { listTimeline, getRevisionDetail } = await import('../lib/revisions.js');
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
  writeFileSync(path.join(repro, 'report.json'), JSON.stringify({ reproducibility: 71, verdict: 'ambiguous', executable_verification: { enabled: true, passed: 1, total: 2 } }));
}

test('timeline interleaves numbered revisions with verification markers', () => {
  seed();
  const t = listTimeline('printer');
  assert.equal(t.length, 3);
  assert.equal(t[0].kind, 'revision'); assert.equal(t[0].version, 0); assert.equal(t[0].source, 'created');
  assert.equal(t[1].kind, 'revision'); assert.equal(t[1].version, 1); assert.equal(t[1].score, 80);
  assert.equal(t[1].render.file, 'iter-01-render.png');
  assert.equal(t[2].kind, 'verification'); assert.equal(t[2].reproducibility, 71);
});

test('revision detail pairs reasoning with a structural + raw diff', () => {
  const d = getRevisionDetail('printer', 'improve-20260101-110000:1');
  assert.equal(d.version, 1);
  assert.equal(d.reasoning.critique, 'switch to aluminium');
  assert.deepEqual(d.reasoning.remainingGaps, ['cables']);
  assert.deepEqual(d.diff.added.map((p) => p.id), ['bed']);
  const frame = d.diff.changed.find((c) => c.id === 'frame');
  assert.deepEqual(frame.fields.find((f) => f.field === 'material'), { field: 'material', before: 'steel', after: 'aluminum' });
  assert.equal(d.diff.initial, false);
  assert.ok(d.rawDiff.includes('- ') || d.rawDiff.includes('+ '));
});

test('unknown revision key returns null', () => {
  assert.equal(getRevisionDetail('printer', 'nope:9'), null);
});
