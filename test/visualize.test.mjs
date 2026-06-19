import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// paths reads $VISUALLY_HOME at load; isolate to an empty temp workspace.
process.env.VISUALLY_HOME = mkdtempSync(path.join(os.tmpdir(), 'vt-refine-'));

const { buildImproveSeed } = await import('../lib/visualize.js');

const none = { id: 'x', paper: null, notes: null, origin: 'none' };
const ev = { id: 'x', paper: '[paper:Sec III] bank(i)=...', notes: 'CFNTT notes', origin: 'workspace' };
const report = () => ({
  missing_fields: [{ item: 'twiddle ROM addr fn', kind: 'operation', where: 'twiddle_rom' }],
});

test('buildImproveSeed returns null when there is neither a report nor evidence', () => {
  assert.equal(buildImproveSeed(null, none), null);
  assert.equal(buildImproveSeed({}, none), null);
});

test('buildImproveSeed seeds from source grounding alone (round 1, no report)', () => {
  const seed = buildImproveSeed(null, ev);
  assert.ok(seed);
  assert.equal(seed.source, 'source evidence');
  // a gap that pushes the 3D model to depict the real architecture
  assert.ok(seed.remaining_gaps.some((g) => /FAITHFUL to the authoritative source/.test(g)));
  // the actual source text rides along in the notes
  assert.ok(seed.notes.some((n) => n.includes('AUTHORITATIVE SOURCE ARCHITECTURE') && n.includes('CFNTT notes')));
});

test('buildImproveSeed merges report gaps with source grounding', () => {
  const seed = buildImproveSeed(report(), ev);
  assert.ok(seed);
  // report-derived gap is present...
  assert.ok(seed.remaining_gaps.some((g) => g.includes('twiddle ROM addr fn')));
  // ...and the grounding gap is prepended (depict the real architecture)
  assert.ok(/FAITHFUL to the authoritative source/.test(seed.remaining_gaps[0]));
});

test('buildImproveSeed falls back to report-only when there is no evidence', () => {
  const seed = buildImproveSeed(report(), none);
  assert.ok(seed);
  assert.equal(seed.source, 'verify findings');
  assert.ok(!seed.notes.some((n) => n.includes('AUTHORITATIVE SOURCE ARCHITECTURE')));
});
