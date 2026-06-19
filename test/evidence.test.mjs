import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Modules under lib/paths read $VISUALLY_HOME at load time, so point it at an
// empty temp workspace BEFORE importing — keeps loadEvidence deterministic
// (no stray ~/.visually-3d/evidence on the dev box wins over the package seed).
const HOME = mkdtempSync(path.join(os.tmpdir(), 'vt-ev-home-'));
process.env.VISUALLY_HOME = HOME;

const {
  EvidenceIndexSchema, sceneSources, buildEvidencePrompt,
  loadEvidence, evidenceExcerpt, hasEvidence,
} = await import('../lib/evidence.js');
const { evidenceDir } = await import('../lib/paths.js');

const scene = {
  machine_name: 'CFNTT Radix-2/4 NTT Accelerator (FPGA)',
  metadata: {
    domain: 'cryptographic-hardware',
    reference: 'https://doi.org/10.46586/tches.v2022.i1.94-126',
    info: {
      summary: 'A conflict-free NTT multiplication architecture.',
      sources: [
        { title: 'CFNTT (TCHES 2022)', url: 'https://tches.iacr.org/index.php/TCHES/article/view/9291' },
        { title: 'CFNTT PDF', url: 'https://tches.iacr.org/index.php/TCHES/article/download/9291/8857' },
      ],
    },
  },
  parts: [],
};

test('EvidenceIndexSchema accepts a well-formed index', () => {
  const idx = EvidenceIndexSchema.parse({
    id: 'x',
    sources: [{ title: 't', url: 'u' }],
    items: [{ kind: 'paper', file: 'paper.md' }],
  });
  assert.equal(idx.id, 'x');
  assert.equal(idx.items[0].kind, 'paper');
});

test('EvidenceIndexSchema rejects an unknown item kind', () => {
  assert.throws(() => EvidenceIndexSchema.parse({ id: 'x', items: [{ kind: 'video', file: 'a' }] }));
});

test('sceneSources collects info.sources and the top-level reference, de-duped', () => {
  const s = sceneSources(scene);
  const urls = s.map((x) => x.url);
  assert.ok(urls.includes('https://tches.iacr.org/index.php/TCHES/article/view/9291'));
  assert.ok(urls.includes('https://doi.org/10.46586/tches.v2022.i1.94-126'));
  // no duplicates
  assert.equal(new Set(urls).size, urls.length);
});

test('sceneSources is empty for a scene with no sources', () => {
  assert.deepEqual(sceneSources({ machine_name: 'x', metadata: {}, parts: [] }), []);
});

test('buildEvidencePrompt enables web fetch, forbids invention, lists the URLs', () => {
  const p = buildEvidencePrompt(scene, sceneSources(scene), { refs: false });
  assert.ok(p.includes('WebFetch'));
  assert.ok(p.includes('NEVER invent'));
  assert.ok(p.includes('tches.iacr.org/index.php/TCHES/article/view/9291'));
  assert.ok(p.includes('[paper:'));
  // without --refs, do not ask for GitHub reference implementations
  assert.ok(!/REFERENCE IMPLEMENTATIONS/.test(p));
});

test('buildEvidencePrompt --refs adds a secondary GitHub search, tagged ref-impl', () => {
  const p = buildEvidencePrompt(scene, sceneSources(scene), { refs: true });
  assert.ok(/REFERENCE IMPLEMENTATIONS/.test(p));
  assert.ok(p.includes('[ref-impl:'));
  assert.ok(p.includes('SECONDARY'));
});

test('loadEvidence falls back to the packaged example seed (origin=examples)', () => {
  // workspace is empty (temp HOME) → the checked-in examples/ntt-fpga seed wins
  const ev = loadEvidence('ntt-fpga');
  assert.equal(ev.origin, 'examples');
  assert.ok(ev.notes && ev.notes.includes('CFNTT'));
  assert.ok(hasEvidence('ntt-fpga'));
});

test('loadEvidence prefers the workspace store over the packaged seed', () => {
  const dir = evidenceDir('ntt-fpga');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'paper.md'), '# Evidence\n[paper:Sec III] bank(i)=...');
  const ev = loadEvidence('ntt-fpga');
  assert.equal(ev.origin, 'workspace');
  assert.ok(ev.paper.includes('Sec III'));
});

test('loadEvidence returns none for an unknown scene', () => {
  const ev = loadEvidence('no-such-scene-xyz');
  assert.equal(ev.origin, 'none');
  assert.equal(ev.paper, null);
  assert.equal(evidenceExcerpt(ev), '');
});

test('evidenceExcerpt includes notes/paper and respects the cap', () => {
  const ev = { id: 'x', paper: 'P'.repeat(50), notes: 'N'.repeat(50), origin: 'examples' };
  const ex = evidenceExcerpt(ev, 60);
  assert.ok(ex.length <= 60);
  assert.ok(ex.includes('Curated learnings'));
});
