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

test('isRepoCheckout: .git present vs absent', () => {
  const a = mkdtempSync(path.join(os.tmpdir(), 'vt-git-')); mkdirSync(path.join(a, '.git'));
  const b = mkdtempSync(path.join(os.tmpdir(), 'vt-nogit-'));
  assert.equal(isRepoCheckout(a), true);
  assert.equal(isRepoCheckout(b), false);
});

test('publishToGallery writes <id>.json, registers index, copies full history', () => {
  const gallery = mkdtempSync(path.join(os.tmpdir(), 'vt-gal-'));
  const r = publishToGallery(id, sceneSrc, scene, gallery, false);
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
  publishHistory(id, gallery, true);
  const runDir = path.join(gallery, 'runs', id, 'improve-20260101-000000');
  assert.ok(existsSync(path.join(runDir, 'iter-01-render.png')), 'render kept');
  assert.ok(existsSync(path.join(runDir, 'iter-00.json')), 'scene version kept');
  assert.ok(!existsSync(path.join(runDir, 'iter-01-events.jsonl')), 'heavy trace scrubbed');
});

test('publishToGallery does not double-register an existing id', () => {
  const gallery = mkdtempSync(path.join(os.tmpdir(), 'vt-gal3-'));
  writeFileSync(path.join(gallery, 'index.json'), JSON.stringify({ samples: [{ id }] }));
  const r = publishToGallery(id, sceneSrc, scene, gallery, false);
  assert.equal(r.registered, false);
  const idx = JSON.parse(readFileSync(path.join(gallery, 'index.json'), 'utf8'));
  assert.equal(idx.samples.filter((s) => s.id === id).length, 1);
});
