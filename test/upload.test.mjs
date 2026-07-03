import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// paths reads $VISUALLY_HOME at load; isolate the workspace.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'vt-upl-home-'));
process.env.VISUALLY_HOME = HOME;

const { isRepoCheckout, publishHistory, publishToGallery } = await import('../lib/upload.js');

const id = 'demo';
const scene = { machine_name: 'Demo', metadata: { info: { summary: 's' } }, parts: [{ id: 'a' }] };
// seed a workspace scene + run history (incl a heavy raw trace + a render PNG)
mkdirSync(path.join(HOME, 'scenes'), { recursive: true });
const sceneSrc = path.join(HOME, 'scenes', `${id}.json`);
writeFileSync(sceneSrc, JSON.stringify(scene));
const run1 = path.join(HOME, 'runs', id, 'improve-20260101-000000');
mkdirSync(run1, { recursive: true });
writeFileSync(path.join(run1, 'iter-00.json'), '{}');
writeFileSync(path.join(run1, 'iter-01-render.png'), 'PNG');
writeFileSync(path.join(run1, 'iter-01-events.jsonl'), 'heavy'); // scrubbed away with --scrub
writeFileSync(path.join(run1, 'iter-01-review.json'), '{"total":90}');
const run2 = path.join(HOME, 'runs', id, 'verify-20260102-000000');
mkdirSync(run2, { recursive: true });
writeFileSync(path.join(run2, 'check-1.py'), 'print()');
writeFileSync(path.join(run2, 'verify-1.txt'), 'pass=true');
writeFileSync(path.join(run2, 'prompt-1.txt'), 'heavy prompt');

test('isRepoCheckout: .git present vs absent', () => {
  const a = mkdtempSync(path.join(os.tmpdir(), 'vt-git-')); mkdirSync(path.join(a, '.git'));
  const b = mkdtempSync(path.join(os.tmpdir(), 'vt-nogit-'));
  assert.equal(isRepoCheckout(a), true);
  assert.equal(isRepoCheckout(b), false);
});

test('publishToGallery writes <id>.json, registers index, copies full history', () => {
  const gallery = mkdtempSync(path.join(os.tmpdir(), 'vt-gal-'));
  const r = publishToGallery(id, sceneSrc, scene, gallery, 'full');
  assert.ok(existsSync(path.join(gallery, `${id}.json`)), 'scene json in gallery');
  assert.equal(r.registered, true);
  const idx = JSON.parse(readFileSync(path.join(gallery, 'index.json'), 'utf8'));
  assert.ok(idx.samples.some((s) => s.id === id), 'registered in index.json');
  // full history includes the render AND the heavy trace
  assert.ok(existsSync(path.join(gallery, 'runs', id, 'improve-20260101-000000', 'iter-01-render.png')));
  assert.ok(existsSync(path.join(gallery, 'runs', id, 'improve-20260101-000000', 'iter-01-events.jsonl')));
  assert.ok(r.runs >= 3);
});

test('publishHistory --scrub drops heavy raw traces but keeps renders/versions', () => {
  const gallery = mkdtempSync(path.join(os.tmpdir(), 'vt-gal2-'));
  publishHistory(id, gallery, 'scrub');
  const runDir = path.join(gallery, 'runs', id, 'improve-20260101-000000');
  assert.ok(existsSync(path.join(runDir, 'iter-01-render.png')), 'render kept');
  assert.ok(existsSync(path.join(runDir, 'iter-00.json')), 'scene version kept');
  assert.ok(!existsSync(path.join(runDir, 'iter-01-events.jsonl')), 'heavy trace scrubbed');
});

test('publishToGallery does not double-register an existing id', () => {
  const gallery = mkdtempSync(path.join(os.tmpdir(), 'vt-gal3-'));
  writeFileSync(path.join(gallery, 'index.json'), JSON.stringify({ samples: [{ id }] }));
  const r = publishToGallery(id, sceneSrc, scene, gallery, 'full');
  assert.equal(r.registered, false);
  const idx = JSON.parse(readFileSync(path.join(gallery, 'index.json'), 'utf8'));
  assert.equal(idx.samples.filter((s) => s.id === id).length, 1);
});

test('publishHistory web profile precomputes the studio payloads + referenced files', async () => {
  const gallery = mkdtempSync(path.join(os.tmpdir(), 'vt-gal4-'));
  // a revisions-shaped history: create -> improve(iter with review+render) -> reproduce
  const { runDir } = await import('../lib/paths.js');
  const sid = 'studio';
  const create = runDir(sid, 'create', '20260101-100000');
  mkdirSync(create, { recursive: true });
  writeFileSync(path.join(create, 'scene.json'), JSON.stringify({ machine_name: 'S', parts: [{ id: 'a' }] }));
  const improve = runDir(sid, 'improve', '20260101-110000');
  mkdirSync(improve, { recursive: true });
  writeFileSync(path.join(improve, 'iter-01.json'), JSON.stringify({ machine_name: 'S', parts: [{ id: 'a' }, { id: 'b' }] }));
  writeFileSync(path.join(improve, 'iter-01-review.json'), JSON.stringify({ total: 88, critique: 'add b' }));
  writeFileSync(path.join(improve, 'iter-01-render.png'), 'PNG');
  writeFileSync(path.join(improve, 'iter-01-events.jsonl'), 'heavy'); // must NOT be published
  const repro = runDir(sid, 'reproduce', '20260101-120000');
  mkdirSync(repro, { recursive: true });
  writeFileSync(path.join(repro, 'report.json'), JSON.stringify({ reproducibility: 70, executable_verification: { enabled: true, passed: 1, total: 1 } }));
  writeFileSync(path.join(repro, 'impl-1.py'), 'x = 1');
  writeFileSync(path.join(repro, 'impl-1-verify.txt'), 'pass=true ran=true');

  const n = publishHistory(sid, gallery, 'web');
  assert.ok(n > 0);
  const root = path.join(gallery, 'runs', sid);
  const timeline = JSON.parse(readFileSync(path.join(root, 'timeline.json'), 'utf8'));
  assert.equal(timeline.entries.length, 3, 'create + improve + verification');
  // every frame has its precomputed detail under the deterministic safe key
  const { safeFrameKey } = await import('../lib/upload.js');
  for (const e of timeline.entries) {
    assert.ok(existsSync(path.join(root, 'frames', safeFrameKey(e.key) + '.json')), 'frame detail for ' + e.key);
  }
  // referenced files (scene snapshots, render, impl code) are copied — nothing else
  assert.ok(existsSync(path.join(root, 'create-20260101-100000', 'scene.json')));
  assert.ok(existsSync(path.join(root, 'improve-20260101-110000', 'iter-01.json')));
  assert.ok(existsSync(path.join(root, 'improve-20260101-110000', 'iter-01-render.png')));
  assert.ok(existsSync(path.join(root, 'reproduce-20260101-120000', 'impl-1.py')));
  assert.ok(!existsSync(path.join(root, 'improve-20260101-110000', 'iter-01-events.jsonl')), 'heavy trace not published');
});

test('safeFrameKey is filename-safe and deterministic', async () => {
  const { safeFrameKey } = await import('../lib/upload.js');
  assert.equal(safeFrameKey('improve-20260101-110000:1'), 'improve-20260101-110000_1');
});
