// `visually visualize <scene | "name" --url ...>` — the VISUALIZE leg of the
// three-command loop (visualize → verify → refine).
//
// Stage 0 — fetch the GROUND-TRUTH evidence up front: the reference paper AND the
//           real source code (so later legs can assume it is cached).
// Stage 1 — build/improve the 3D model GROUNDED in that source, so it depicts the
//           REAL modules / memory / datapath / control instead of a guess.
//
// Births a draft scene first if one does not exist yet. Loosely coupled: refine
// calls visualizeStep() per round; the CLI wrapper adds resolve/create + logging.

import os from 'node:os';
import path from 'node:path';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { improve } from './improve.js';
import { resolveScene, sceneIdFromPath } from './paths.js';
import { hasFindings } from './amend.js';
import { gatherEvidence, loadEvidence, sourceGrounding, sceneSources, readIndex, pendingEvidenceFetch, type LoadedEvidence } from './evidence.js';

export interface ImproveSeed { source: string; remaining_gaps: string[]; notes: string[] }

// Turn a verify report into a seed "reflection" the visual pass reads as
// carried-over gaps, so the 3D model stays consistent with what verification said
// is missing. Shape matches what improve already consumes (history.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function seedFromReport(report: any): ImproveSeed | null {
  if (!hasFindings(report)) return null;
  const gaps: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of (report.missing_fields || []) as any[]) {
    const where = m.where && m.where !== 'global' ? ` (part "${m.where}")` : '';
    gaps.push(`Make reproducible — record the ${m.kind || 'fact'}: ${m.item}${where}`);
    if (gaps.length >= 8) break;
  }
  const fr = report.fidelity_report || {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const p of (fr.parameter_fidelity || []) as any[]) {
    if (p?.match === false && gaps.length < 12) {
      gaps.push(`Match the source — ${p.param} should be "${p.reference_value}" (impls used "${p.impl_value}")`);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const s of (fr.structural_findings || []) as any[]) {
    if (gaps.length < 14) gaps.push(`Match the source's architecture — ${s}`);
  }
  const notes = [
    'These gaps come from the verification check: engineers could not rebuild the system from the scene alone. Keep the scene\'s spec/annotations consistent with the values the verify leg writes in.',
  ];
  return { source: 'verify findings', remaining_gaps: gaps, notes };
}

// The seed handed to the visual pass. Merges (a) the prior round's verification
// gaps with (b) SOURCE GROUNDING from the gathered evidence — so the 3D model is
// improved to depict the REAL architecture, not a guess. Returns null only when
// there is neither, so grounding alone (round 1, before any report) still seeds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildImproveSeed(report: any, ev: LoadedEvidence): ImproveSeed | null {
  const base = seedFromReport(report);
  const grounding = ev && ev.origin !== 'none' ? sourceGrounding(ev) : '';
  if (!base && !grounding) return null;
  const remaining_gaps = base ? [...base.remaining_gaps] : [];
  const notes = base ? [...base.notes] : [];
  if (grounding) {
    remaining_gaps.unshift(
      'Make the 3D structure FAITHFUL to the authoritative source architecture below — depict the real modules, memory banks, datapath and control as the source describes them; do not invent structure it contradicts.',
    );
    notes.push(`AUTHORITATIVE SOURCE ARCHITECTURE (ground the 3D model in this real implementation):\n${grounding}`);
  }
  return { source: base?.source ?? 'source evidence', remaining_gaps, notes };
}

export interface VisualizeOpts {
  iters?: number;
  model?: string;
  driver?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  report?: any;
  noEvidence?: boolean;
  refs?: boolean; // default true: also fetch the reference source code (GitHub)
}

// Stage 0: make sure the reference + source are cached. Decides what is still
// missing from the attempt log (not merely "does paper.md exist"), so a
// paper-only scene gets its SOURCE topped up and a complete one is a no-op. No-op
// when the scene cites no source or evidence is opted out.
export async function ensureGroundTruth(
  id: string,
  opts: { noEvidence?: boolean; refs?: boolean; model?: string } = {},
): Promise<void> {
  if (opts.noEvidence) return;
  const wantRefs = opts.refs !== false;
  const haveWorkspacePaper = loadEvidence(id).origin === 'workspace';
  const need = pendingEvidenceFetch(readIndex(id)?.attempts ?? [], haveWorkspacePaper, wantRefs);
  if (!need) return; // reference + (optionally) source already cached
  const target = resolveScene(id);
  let sources: { url?: string }[] = [];
  if (target) {
    try { sources = sceneSources(JSON.parse(readFileSync(target, 'utf8'))); } catch { /* ignore */ }
  }
  if (!sources.length) return;
  console.log(need === 'refs'
    ? '  ▶ topping up ground-truth SOURCE code (paper already cached)…'
    : '  ▶ fetching ground-truth evidence (reference paper + real source code)…');
  try {
    // 'paper' fetches the primary source (+refs in the same pass); 'refs' adds
    // only the source code, appended to the existing paper.md.
    await gatherEvidence(id, { method: need, refs: need === 'paper' ? wantRefs : true, model: opts.model });
  } catch (err) {
    console.log(`  ⚠ evidence gathering stopped: ${(err as Error).message}`);
  }
}

// Stage 1: one grounded visual-improve pass (iters iterations).
export async function visualizeStep(id: string, opts: VisualizeOpts = {}): Promise<void> {
  await ensureGroundTruth(id, opts);
  const iters = opts.iters && opts.iters > 0 ? opts.iters : 1;
  const seed = buildImproveSeed(opts.report ?? null, loadEvidence(id));
  if (seed && seed.source === 'source evidence') {
    console.log('  grounding the 3D pass in the gathered source architecture');
  }
  const prevSeedEnv = process.env.VISUALLY_SEED_REVIEW;
  try {
    if (seed) {
      const seedDir = mkdtempSync(path.join(os.tmpdir(), 'visually-vis-seed-'));
      const seedPath = path.join(seedDir, 'seed-review.json');
      writeFileSync(seedPath, JSON.stringify(seed, null, 2));
      process.env.VISUALLY_SEED_REVIEW = seedPath;
      console.log(`  seeding visual pass with ${seed.remaining_gaps.length} grounding/verification gap(s)`);
    }
    const improveArgs = [id, String(iters)];
    if (opts.driver) improveArgs.push('--driver', opts.driver);
    if (opts.model) improveArgs.push('--model', opts.model);
    await improve(improveArgs);
  } finally {
    if (seed) {
      if (prevSeedEnv === undefined) delete process.env.VISUALLY_SEED_REVIEW;
      else process.env.VISUALLY_SEED_REVIEW = prevSeedEnv;
    }
  }
}

interface VisualizeCliOpts {
  positional: string[];
  url?: string; iters?: number; model?: string; driver?: string;
  noEvidence?: boolean; noRefs?: boolean;
}

function parseArgs(argv: string[]): VisualizeCliOpts {
  const opts: VisualizeCliOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') opts.url = argv[++i];
    else if (a === '--iters') opts.iters = Number(argv[++i]);
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--driver') opts.driver = argv[++i];
    else if (a === '--no-evidence') opts.noEvidence = true;
    else if (a === '--no-refs') opts.noRefs = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function visualize(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) {
    throw new Error('usage: visually visualize <scene | "name" --url <paper-url>> [--iters N] [--model <m>] [--driver claude|codex] [--no-evidence] [--no-refs]');
  }
  let target = resolveScene(ref);
  let id: string;
  if (!target) {
    // Birth a draft from the name (+url) first, then ground it. Dynamic import
    // avoids a create → refine → visualize static import cycle.
    console.log(`visually visualize: "${ref}" — no such scene yet; creating a draft first`);
    const { create } = await import('./create.js');
    const createArgs = [ref, '--no-refine'];
    if (opts.url) createArgs.push('--url', opts.url);
    if (opts.model) createArgs.push('--model', opts.model);
    if (opts.driver) createArgs.push('--driver', opts.driver);
    target = await create(createArgs);
    id = sceneIdFromPath(target);
  } else {
    id = sceneIdFromPath(target);
  }
  console.log(`\nvisually visualize: ${id} — ground-truth evidence + source-grounded 3D model`);
  await visualizeStep(id, {
    iters: opts.iters ?? 3,
    model: opts.model,
    driver: opts.driver,
    noEvidence: opts.noEvidence,
    refs: !opts.noRefs,
  });
  console.log(`\n  ✓ visualize done. Next: visually verify ${id}`);
}
