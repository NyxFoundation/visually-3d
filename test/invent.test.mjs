import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the workspace; paths reads $VISUALLY_HOME at load.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'vt-invent-'));
process.env.VISUALLY_HOME = HOME;

const { buildIdeatePrompt, buildImplementPrompt, buildInventFixPrompt, parseConcepts, readInventionLog, DELTA_OPERATORS } =
  await import('../lib/invent.js');

const scene = { machine_name: 'CFNTT', metadata: { mode: 'algorithm' } };

const concept = {
  slug: 'psi-fold-rom',
  name: 'psi-fold ROM',
  operator: 'subtraction',
  phenomenon: 'psi-symmetry of the twiddle factors',
  delta: 'store only half the ROM; derive the rest by the symmetry',
  prediction: 'ROM entries halve while every NTT output stays bit-identical',
  sketch: 'build both ROMs, run the transform on the basis, compare',
};

test('buildIdeatePrompt carries evidence, operators, tried-list, and the contradiction', () => {
  const tried = [{ slug: 'a-b', name: 'A', operator: 'unification', prediction: 'p', status: 'falsified', round: 1, runDir: '', savedAt: '' }];
  const p = buildIdeatePrompt(scene, 'EVIDENCE-CORE', tried, 'seq env vs parallel commands', false);
  assert.ok(p.includes('EVIDENCE-CORE'));
  assert.ok(p.includes('seq env vs parallel commands'));
  assert.ok(p.includes('[falsified] a-b'));                       // no repeats
  for (const op of DELTA_OPERATORS) assert.ok(p.includes(op));    // all five generators
  assert.ok(/ONE atypical ingredient/.test(p));                   // conventional round
});

test('buildIdeatePrompt lifts the conventionality constraint on variance rounds', () => {
  const p = buildIdeatePrompt(scene, 'E', [], undefined, true);
  assert.ok(/VARIANCE ROUND/.test(p));
  assert.ok(/NAME the sharpest contradiction/.test(p));           // no contradiction given
});

test('buildImplementPrompt demands an honest prediction check', () => {
  const p = buildImplementPrompt(scene, concept, 'THE-SOURCE', 'BACKEND-RULES');
  assert.ok(p.includes(concept.prediction));
  assert.ok(p.includes('THE-SOURCE'));
  assert.ok(p.includes('BACKEND-RULES'));
  assert.ok(/falsified invention is a\s+valid/i.test(p));         // honest-kill contract
  assert.ok(/Do NOT weaken the check/.test(p));
});

test('buildInventFixPrompt fixes impl bugs but never weakens a genuine counterexample', () => {
  const p = buildInventFixPrompt(concept, 'print("x")', 'SyntaxError: boom', 'RULES');
  assert.ok(p.includes('SyntaxError: boom'));
  assert.ok(/FALSIFIED/.test(p));
  assert.ok(/do\s+NOT weaken the prediction check/i.test(p));
});

test('parseConcepts round-trips a fenced JSON reply and rejects junk', () => {
  const reply = 'Here you go:\n```json\n' + JSON.stringify({ concepts: [concept] }) + '\n```\n';
  const out = parseConcepts(reply);
  assert.equal(out.length, 1);
  assert.equal(out[0].slug, 'psi-fold-rom');
  assert.equal(out[0].operator, 'subtraction');
  assert.deepEqual(parseConcepts('no json here'), []);
  assert.deepEqual(parseConcepts('```json\n{"concepts": []}\n```'), []); // min(1)
  // invalid operator is rejected by the schema
  const bad = { concepts: [{ ...concept, operator: 'magic' }] };
  assert.deepEqual(parseConcepts('```json\n' + JSON.stringify(bad) + '\n```'), []);
});

test('readInventionLog returns [] for a fresh scene', () => {
  assert.deepEqual(readInventionLog('never-touched'), []);
});
