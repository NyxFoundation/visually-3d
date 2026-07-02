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

test('publishHistory web profile keeps only what the timeline shows + writes a chronological manifest', () => {
  const gallery = mkdtempSync(path.join(os.tmpdir(), 'vt-gal4-'));
  publishHistory(id, gallery, 'web');
  const impDir = path.join(gallery, 'runs', id, 'improve-20260101-000000');
  const verDir = path.join(gallery, 'runs', id, 'verify-20260102-000000');
  assert.ok(existsSync(path.join(impDir, 'iter-01-render.png')), 'render kept');
  assert.ok(existsSync(path.join(impDir, 'iter-01-review.json')), 'review kept');
  assert.ok(!existsSync(path.join(impDir, 'iter-00.json')), 'scene snapshot dropped in web profile');
  assert.ok(!existsSync(path.join(impDir, 'iter-01-events.jsonl')), 'heavy trace dropped');
  assert.ok(existsSync(path.join(verDir, 'verify-1.txt')), 'verify log kept');
  assert.ok(existsSync(path.join(verDir, 'check-1.py')), 'self-check source kept');
  assert.ok(!existsSync(path.join(verDir, 'prompt-1.txt')), 'prompt dropped');
  const manifest = JSON.parse(readFileSync(path.join(gallery, 'runs', id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, id);
  assert.deepEqual(manifest.runs.map((r) => r.kind), ['improve', 'verify'], 'chronological order');
  assert.equal(manifest.runs[0].at, '2026-01-01T00:00:00Z');
  assert.ok(manifest.runs[0].files.includes('iter-01-render.png'));
});

test('writeHistoryManifest picks up runs placed in the published dir by hand', async () => {
  const { writeHistoryManifest } = await import('../lib/upload.js');
  const gallery = mkdtempSync(path.join(os.tmpdir(), 'vt-gal5-'));
  publishHistory(id, gallery, 'web');
  const extra = path.join(gallery, 'runs', id, 'improve-20270101-000000');
  mkdirSync(extra, { recursive: true });
  writeFileSync(path.join(extra, 'iter-01-render.png'), 'PNG');
  const runs = writeHistoryManifest(id, gallery);
  assert.equal(runs.length, 3);
  assert.equal(runs[2].dir, 'improve-20270101-000000', 'hand-placed run sorts last');
});
