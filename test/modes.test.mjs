import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMode, buildSystemPrompt, modeLabel, MODE_IDS } from '../server/modes.js';

test('MODE_IDS are exactly the three supported modes', () => {
  assert.deepEqual([...MODE_IDS].sort(), ['algorithm', 'architecture', 'hardware']);
});

test('detectMode routes subjects to the right mode', () => {
  assert.equal(detectMode('DeepSeek MoE transformer attention'), 'algorithm');
  assert.equal(detectMode('東京駅 駅舎'), 'architecture');
  assert.equal(detectMode('清水寺 本堂'), 'architecture');
  assert.equal(detectMode('Prusa i3 MK3S 3D printer'), 'hardware');
  assert.equal(detectMode('風力タービン'), 'hardware');
  assert.equal(detectMode(''), 'hardware'); // default
});

test('buildSystemPrompt produces a non-empty prompt per mode', () => {
  for (const id of MODE_IDS) {
    const p = buildSystemPrompt(id);
    assert.ok(typeof p === 'string' && p.length > 500, `${id} prompt too short`);
    assert.ok(p.includes('Output contract'), `${id} missing output contract`);
  }
});

test('prompts carry no removed craft/mesh/svg machinery', () => {
  for (const id of MODE_IDS) {
    const p = buildSystemPrompt(id);
    assert.ok(!/shape:\s*"mesh"|\bsvg\b|woodcarv|feDiffuseLighting/i.test(p),
      `${id} prompt still references removed craft/mesh/svg`);
  }
  // shape enum must be the 7 primitives only (no mesh)
  assert.ok(buildSystemPrompt('hardware').includes('"complex"'));
  assert.ok(!buildSystemPrompt('hardware').includes('"mesh"'));
});

test('modeLabel falls back gracefully for an unknown mode', () => {
  assert.equal(modeLabel('hardware'), 'hardware');
  assert.equal(modeLabel('nonsense'), 'hardware');
});
