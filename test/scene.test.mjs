import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScene, slugify, extractScene, deriveIndexEntry, SHAPES } from '../lib/scene.js';

const part = (over = {}) => ({
  id: 'a', name: 'A', shape: 'box', position: [0, 0, 0], size: [1, 1, 1],
  material: 'steel', role: 'r', ...over,
});

test('SHAPES is the 7 primitives (no mesh)', () => {
  assert.deepEqual([...SHAPES].sort(),
    ['box', 'capsule', 'complex', 'cone', 'cylinder', 'sphere', 'torus']);
});

test('validateScene accepts a minimal valid scene', () => {
  assert.deepEqual(validateScene({ machine_name: 'X', parts: [part()] }), []);
});

test('validateScene rejects missing name / empty parts', () => {
  assert.ok(validateScene({ parts: [part()] }).some((e) => /machine_name/.test(e)));
  assert.ok(validateScene({ machine_name: 'X', parts: [] }).some((e) => /missing or empty/.test(e)));
});

test('validateScene rejects bad shape, sizes and duplicate ids', () => {
  assert.ok(validateScene({ machine_name: 'X', parts: [part({ shape: 'mesh' })] })
    .some((e) => /invalid shape/.test(e)));
  assert.ok(validateScene({ machine_name: 'X', parts: [part({ size: [0, 1, 1] })] })
    .some((e) => /size/.test(e)));
  assert.ok(validateScene({ machine_name: 'X', parts: [part({ position: [0, 0] })] })
    .some((e) => /position/.test(e)));
  assert.ok(validateScene({ machine_name: 'X', parts: [part(), part()] })
    .some((e) => /duplicate/.test(e)));
});

test('slugify keeps ascii and hashes non-ascii (no more "scene" collisions)', () => {
  assert.equal(slugify('Prusa i3 MK3S'), 'prusa-i3-mk3s');
  const a = slugify('井波彫刻 雲龍欄間');
  const b = slugify('九谷焼の花瓶');
  assert.match(a, /^scene-[0-9a-f]{6}$/);
  assert.match(b, /^scene-[0-9a-f]{6}$/);
  assert.notEqual(a, b, 'different non-ascii names must get different ids');
});

test('extractScene pulls the first balanced JSON object, ignoring braces in strings', () => {
  const o = extractScene('noise {"machine_name":"Y { not a brace }","parts":[]} tail');
  assert.equal(o.machine_name, 'Y { not a brace }');
  assert.throws(() => extractScene('no json here'));
});

test('deriveIndexEntry builds a gallery entry', () => {
  const e = deriveIndexEntry({ machine_name: 'Z', metadata: { summary: 's' } }, 'z-id');
  assert.equal(e.id, 'z-id');
  assert.equal(e.title, 'Z');
  assert.equal(e.path, '/samples/z-id.json');
});
