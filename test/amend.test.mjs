import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAmendPatch, buildAmendPrompt, hasFindings } from '../lib/amend.js';
import { specCoverage, validateScene, parseScene } from '../lib/scene.js';

const baseScene = () => ({
  machine_name: 'Test NTT core',
  parts: [
    { id: 'mod_red', name: 'reducer', shape: 'box', position: [0, 0, 0], size: [1, 1, 1], material: 'steel', role: 'r' },
    { id: 'rom', name: 'twiddle', shape: 'box', position: [1, 0, 0], size: [1, 1, 1], material: 'brass', role: 'r' },
  ],
});

const report = () => ({
  reproducibility: 8,
  verdict: 'underspecified',
  divergences: ['Impl1 used q=12289; Impl2 left q as a port'],
  missing_fields: [
    { item: 'modulus q', kind: 'param', where: 'mod_red' },
    { item: 'transform size N', kind: 'param', where: 'global' },
  ],
  verify_findings: [
    { impl: 1, pass: true, ran: true, counterexample: null },
    { impl: 2, pass: false, ran: true, counterexample: 'FAIL: q=12277 gives wrong INTT scale' },
  ],
  fidelity: 35,
  fidelity_report: {
    parameter_fidelity: [
      { param: 'modulus q', reference_value: '14-bit NTT prime', impl_value: '12277', match: false, where: 'mod_red' },
      { param: 'N', reference_value: '1024', impl_value: '1024', match: true, where: 'global' },
    ],
    property_checks: [
      { property: 'conflict-free memory mapping', status: 'unverifiable', evidence: 'no mapping eq', where: 'crossbar' },
    ],
    structural_findings: ['Impl2 reordered reduction before add/sub vs the source datapath'],
  },
});

test('hasFindings is true when a report carries something to fold back', () => {
  assert.equal(hasFindings(report()), true);
  assert.equal(hasFindings({ missing_fields: [], divergences: [], verify_findings: [] }), false);
  assert.equal(hasFindings(null), false);
});

test('buildAmendPrompt routes each missing field to a part spec or metadata.spec', () => {
  const p = buildAmendPrompt(baseScene(), report());
  assert.ok(p.includes('part "mod_red".spec'), 'part-scoped field targets the part');
  assert.ok(p.includes('metadata.spec'), 'global field targets metadata.spec');
  assert.ok(p.includes('modulus q'), 'carries the missing item');
  assert.ok(p.includes('q=12289'), 'carries the divergence to resolve');
  assert.ok(p.includes('FAIL: q=12277'), 'carries the verifier counterexample');
  assert.ok(p.includes('mod_red, rom'), 'lists existing part ids');
  assert.ok(p.includes('SMALL SPEC PATCH'), 'asks for a patch, not a full scene rewrite');
  assert.ok(p.includes('"part_specs"'), 'declares the patch shape');
  assert.ok(p.includes('Geometry') && p.includes('MUST NOT'), 'forbids geometry and other non-spec fields');
});

test('buildAmendPrompt surfaces fidelity gaps (parameter, property, structural)', () => {
  const p = buildAmendPrompt(baseScene(), report());
  assert.ok(p.includes('FIDELITY GAPS'), 'has a fidelity section');
  assert.ok(p.includes('modulus q') && p.includes('14-bit NTT prime'), 'parameter mismatch with source value');
  assert.ok(!p.includes('"param": "N"'), 'matching params are not listed as gaps');
  assert.ok(p.includes('conflict-free memory mapping'), 'unsatisfied property surfaced');
  assert.ok(p.includes('reordered reduction'), 'structural divergence surfaced');
});

test('hasFindings is true for a fidelity-only report (no missing fields)', () => {
  const fidelityOnly = {
    missing_fields: [], divergences: [], verify_findings: [],
    fidelity_report: { parameter_fidelity: [{ param: 'q', match: false }] },
  };
  assert.equal(hasFindings(fidelityOnly), true);
});

test('buildAmendPrompt is robust to an empty report', () => {
  const p = buildAmendPrompt(baseScene(), {});
  assert.ok(p.includes('(none reported)'));
  assert.ok(typeof p === 'string' && p.length > 200);
});

// The injected block carries this distinctive header; rule #5 mentions
// "GATHERED SOURCE EVIDENCE" unconditionally, so key off the header instead.
const EVIDENCE_BLOCK_MARKER = 'transcribed from the actual source by';

test('buildAmendPrompt injects gathered evidence and asks to quote it as [paper]', () => {
  const ev = { id: 'x', paper: '# Evidence\n[paper:Sec III] bank(i)=(i^(i>>3)) mod 8', notes: null, origin: 'workspace' };
  const p = buildAmendPrompt(baseScene(), report(), ev);
  assert.ok(p.includes(EVIDENCE_BLOCK_MARKER));
  assert.ok(p.includes('bank(i)=(i^(i>>3)) mod 8'));
  assert.ok(p.includes('[paper]'));
});

test('buildAmendPrompt omits the evidence block when there is none', () => {
  const p = buildAmendPrompt(baseScene(), report(), { id: 'x', paper: null, notes: null, origin: 'none' });
  assert.ok(!p.includes(EVIDENCE_BLOCK_MARKER));
});

test('applyAmendPatch only merges metadata.spec and existing part specs', () => {
  const scene = baseScene();
  const patch = {
    machine_name: 'evil rename',
    parts: [],
    metadata_spec: {
      params: { N: 1024 },
      properties: ['NTT followed by INTT is identity'],
      notes: '[src] system size is 1024',
    },
    part_specs: {
      mod_red: {
        params: { q: 12289 },
        widths: { coeff: 14 },
        ops: ['barrett_reduce'],
        notes: '[src] 14-bit NTT prime',
      },
      missing_part: { params: { ignored: true } },
    },
  };

  const { scene: merged, applied, ignored } = applyAmendPatch(scene, patch);
  assert.equal(applied, 2);
  assert.deepEqual(ignored, ['missing_part']);
  assert.equal(merged.machine_name, scene.machine_name, 'cannot rename the scene');
  assert.equal(merged.parts.length, scene.parts.length, 'cannot replace parts');
  assert.deepEqual(merged.parts[0].position, scene.parts[0].position, 'keeps geometry untouched');
  assert.equal(merged.parts[0].material, scene.parts[0].material, 'keeps material untouched');
  assert.deepEqual(merged.metadata.spec.params, { N: 1024 });
  assert.deepEqual(merged.parts[0].spec.params, { q: 12289 });
  assert.deepEqual(merged.parts[0].spec.widths, { coeff: 14 });
  assert.deepEqual(merged.parts[0].spec.ops, ['barrett_reduce']);
  assert.equal(merged.parts[1].spec, undefined, 'unknown patch targets are ignored');
});

test('applyAmendPatch deep-merges arrays uniquely and appends notes', () => {
  const scene = baseScene();
  scene.metadata = {
    spec: {
      params: { q: 12289 },
      properties: ['conflict-free memory mapping'],
      notes: '[src] base',
    },
  };
  scene.parts[0].spec = {
    ops: ['add'],
    notes: '[src] existing',
  };

  const { scene: merged } = applyAmendPatch(scene, {
    metadata_spec: {
      params: { N: 1024 },
      properties: ['conflict-free memory mapping', 'no bit-reversal'],
      notes: '[calc] stage count = 10',
    },
    part_specs: {
      mod_red: {
        ops: ['add', 'barrett_reduce'],
        notes: '[conv] post-add reduction',
      },
    },
  });

  assert.deepEqual(merged.metadata.spec.params, { q: 12289, N: 1024 });
  assert.deepEqual(merged.metadata.spec.properties, ['conflict-free memory mapping', 'no bit-reversal']);
  assert.equal(merged.metadata.spec.notes, '[src] base\n[calc] stage count = 10');
  assert.deepEqual(merged.parts[0].spec.ops, ['add', 'barrett_reduce']);
  assert.equal(merged.parts[0].spec.notes, '[src] existing\n[conv] post-add reduction');
});

test('applyAmendPatch treats empty template patches as no-ops', () => {
  const scene = baseScene();
  const { scene: merged, applied, ignored } = applyAmendPatch(scene, {
    metadata_spec: { params: {}, ops: [], notes: '' },
    part_specs: {
      mod_red: { params: {}, ports: [], notes: '' },
      rom: {},
    },
  });

  assert.equal(applied, 0);
  assert.deepEqual(ignored, []);
  assert.equal(merged.metadata, undefined);
  assert.equal(merged.parts[0].spec, undefined);
  assert.equal(merged.parts[1].spec, undefined);
});

test('specCoverage counts spec fields across parts and metadata', () => {
  const scene = baseScene();
  assert.deepEqual(specCoverage(scene), { parts: 2, covered: 0, keys: 0 });
  scene.parts[0].spec = { params: { q: 12289 }, widths: { coeff: 14 } };
  scene.metadata = { spec: { params: { N: 1024 } } };
  const cov = specCoverage(scene);
  assert.equal(cov.parts, 2);
  assert.equal(cov.covered, 1);
  assert.equal(cov.keys, 3); // q + coeff + N
});

test('the schema accepts a scene carrying a functional spec (back/forward compatible)', () => {
  const scene = baseScene();
  scene.parts[0].spec = {
    params: { q: 12289 },
    widths: { coeff: 14 },
    ports: [{ name: 'din', dir: 'in', width: 14 }],
    ops: ['barrett_reduce'],
    fsm: ['IDLE', 'RUN'],
    notes: 'chose Kyber modulus',
    extra_future_field: 42,
  };
  assert.deepEqual(validateScene(scene), [], 'validateScene accepts spec');
  const parsed = parseScene(scene); // strict zod boundary must not throw
  assert.equal(parsed.parts[0].spec.params.q, 12289);
});

test('a scene without any spec still validates (no regression)', () => {
  assert.deepEqual(validateScene(baseScene()), []);
});
