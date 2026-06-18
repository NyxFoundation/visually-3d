// `visually refine <scene>` — the unified, CLOSED 3D ⇄ implementation
// self-improvement loop ("visioned self-improvement"). Each round:
//
//   1. improve   — render → VLM critique → rewrite the scene (visual axis),
//                  seeded with the previous round's verification findings so the
//                  annotations stay consistent with what must be reproducible;
//   2. reproduce — N engineers reverse-implement the scene from the spec alone
//                  and a backend (SMT for algorithms/circuits, physics sim for
//                  machines) actually runs each implementation's self-check;
//   3. amend     — fold the verification findings (missing fields, divergences,
//                  counterexamples) BACK into the scene's functional spec.
//
// Step 3 is the edge the old loop lacked: without it, improve wrote geometry and
// reproduce read semantics, so the reproducibility score could never move. With
// it, each round writes verified facts into the spec, the next reproduce reads
// them, the independent implementations converge, and reproducibility climbs.
//
// It stays mode/backend-agnostic, so it behaves the same for hardware,
// algorithm, and architecture scenes — only the verification backend differs.

import os from 'node:os';
import path from 'node:path';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { improve } from './improve.js';
import { reproduce } from './reproduce.js';
import { amendScene, hasFindings } from './amend.js';
import { latestVisualScore } from './history.js';
import { specCoverage } from './scene.js';
import { resolveScene, sceneIdFromPath } from './paths.js';

interface RefineOpts {
  positional: string[];
  rounds?: number;
  visual?: number;
  repro?: number;
  iters?: number;
  driver?: string;
  model?: string;
  backend?: string;
  noVerify?: boolean;
  noAmend?: boolean;
}

function parseArgs(argv: string[]): RefineOpts {
  const opts: RefineOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rounds') opts.rounds = Number(argv[++i]);
    else if (a === '--visual') opts.visual = Number(argv[++i]);
    else if (a === '--repro') opts.repro = Number(argv[++i]);
    else if (a === '--iters') opts.iters = Number(argv[++i]);
    else if (a === '--driver') opts.driver = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--backend') opts.backend = argv[++i];
    else if (a === '--no-verify') opts.noVerify = true;
    else if (a === '--no-amend') opts.noAmend = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

// Turn a reproduce report into a seed "reflection" the next improve round reads
// as carried-over gaps — so the visual pass keeps the scene's annotations and
// spec consistent with what verification said is missing. Written in the shape
// improve already consumes (see history.ts → PriorReflection / self-improve.sh).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seedFromReport(report: any): { source: string; remaining_gaps: string[]; notes: string[] } | null {
  if (!hasFindings(report)) return null;
  const gaps: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of (report.missing_fields || []) as any[]) {
    const where = m.where && m.where !== 'global' ? ` (part "${m.where}")` : '';
    gaps.push(`Make reproducible — record the ${m.kind || 'fact'}: ${m.item}${where}`);
    if (gaps.length >= 8) break;
  }
  // Fidelity gaps: keep the scene faithful to the SPECIFIC source, not a generic
  // correct version. These ride alongside the reproducibility gaps.
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
    'These gaps come from the reproducibility check: engineers could not rebuild the system from the scene alone. Keep the scene\'s spec/annotations consistent with the values amend writes in.',
  ];
  return { source: 'reproduce findings', remaining_gaps: gaps, notes };
}

export async function refine(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) {
    throw new Error('usage: visually refine <scene> [--rounds N] [--visual 90] [--repro 80] [--iters 2] [--driver claude|codex] [--model <m>] [--backend <id>] [--no-verify] [--no-amend]');
  }
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);

  const maxRounds = opts.rounds && opts.rounds > 0 ? opts.rounds : 3;
  const visualGoal = Number.isFinite(opts.visual) ? (opts.visual as number) : 90;
  const reproGoal = Number.isFinite(opts.repro) ? (opts.repro as number) : 80;
  const iters = opts.iters && opts.iters > 0 ? opts.iters : 2;

  console.log(`visually refine: ${id} — closed 3D ⇄ implementation loop (improve → reproduce → amend)`);
  console.log(`  goals: visual ≥ ${visualGoal}/100, reproducibility ≥ ${reproGoal}/100, self-check passing`);
  console.log(`  up to ${maxRounds} round(s)\n`);

  let visual: number | null = null;
  let repro: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastReport: any = null;

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n════════ refine round ${round}/${maxRounds} ════════`);

    // 1. Visual self-improvement, seeded with the prior round's verification
    // findings (carried-over gaps). Tolerate a failed pass (e.g. a render
    // hiccup): the saved scene is intact and the loop can still verify it.
    console.log(`\n▶ visual self-improvement (${iters} iteration(s))…`);
    const seed = seedFromReport(lastReport);
    const prevSeedEnv = process.env.VISUALLY_SEED_REVIEW;
    try {
      if (seed) {
        const seedDir = mkdtempSync(path.join(os.tmpdir(), 'visually-refine-seed-'));
        const seedPath = path.join(seedDir, 'seed-review.json');
        writeFileSync(seedPath, JSON.stringify(seed, null, 2));
        process.env.VISUALLY_SEED_REVIEW = seedPath;
        console.log(`  seeding visual pass with ${seed.remaining_gaps.length} verification gap(s) from last round`);
      }
      const improveArgs = [id, String(iters)];
      if (opts.driver) improveArgs.push('--driver', opts.driver);
      if (opts.model) improveArgs.push('--model', opts.model);
      await improve(improveArgs);
    } catch (err) {
      console.log(`  ⚠ visual pass stopped: ${(err as Error).message}`);
    } finally {
      // Restore the caller's env so we don't leak the seed into later rounds.
      if (seed) {
        if (prevSeedEnv === undefined) delete process.env.VISUALLY_SEED_REVIEW;
        else process.env.VISUALLY_SEED_REVIEW = prevSeedEnv;
      }
    }
    visual = latestVisualScore(id);

    // 2. Implementation verification.
    console.log(`\n▶ implementation verification…`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let report: any = null;
    try {
      const reproArgs = [id];
      if (opts.model) reproArgs.push('--model', opts.model);
      if (opts.backend) reproArgs.push('--backend', opts.backend);
      if (opts.noVerify) reproArgs.push('--no-verify');
      report = await reproduce(reproArgs);
    } catch (err) {
      console.log(`  ⚠ verification stopped: ${(err as Error).message}`);
    }
    const prevRepro = repro;
    repro = report && Number.isFinite(Number(report.reproducibility)) ? Number(report.reproducibility) : null;
    lastReport = report;

    const ev = report?.executable_verification;
    const verifyEnabled = !!ev?.enabled;
    const verifyPass = verifyEnabled ? ev.passed > 0 && ev.passed === ev.total : null;

    // 3. The return edge: fold the findings back into the scene's spec so the
    // next round's reproduce reads verified facts and the score can climb.
    if (report && !opts.noAmend) {
      console.log(`\n▶ folding verification findings into the spec…`);
      try {
        const res = await amendScene(target, report, { model: opts.model });
        if (res.applied) console.log(`  ✓ spec grown: ${res.before} → ${res.after} fields written back`);
        else console.log(`  · spec unchanged (${res.reason})`);
      } catch (err) {
        console.log(`  ⚠ amend stopped: ${(err as Error).message}`);
      }
    }

    const visualOk = visual != null && visual >= visualGoal;
    const reproOk = repro != null && repro >= reproGoal;
    const verifyOk = !verifyEnabled || verifyPass === true;

    let cov = { keys: 0 };
    try { cov = specCoverage(JSON.parse(readFileSync(target, 'utf8'))); } catch { /* ignore */ }
    const trend = prevRepro != null && repro != null
      ? (repro > prevRepro ? ` (▲${repro - prevRepro})` : repro < prevRepro ? ` (▼${prevRepro - repro})` : ' (=)')
      : '';

    const fidelity = report && Number.isFinite(Number(report.fidelity)) ? Number(report.fidelity) : null;

    console.log(
      `\n  round ${round} — visual ${visual ?? '?'}/${visualGoal} ${visualOk ? '✓' : '…'}` +
      `  ·  repro ${repro ?? '?'}/${reproGoal}${trend} ${reproOk ? '✓' : '…'}` +
      `  ·  fidelity ${fidelity ?? '?'}/100` +
      `  ·  self-check ${verifyEnabled ? (verifyPass ? 'PASS ✓' : 'fail') : 'n/a'}` +
      `  ·  spec ${cov.keys} field(s)`,
    );

    if (visualOk && reproOk && verifyOk) {
      console.log(`\n✓ refine: thresholds met after ${round} round(s) — the scene is both convincing and reproducible.`);
      return;
    }
  }

  console.log(`\n△ refine: reached ${maxRounds} round(s) without clearing every threshold.`);
  console.log(`  best — visual ${visual ?? '?'}/${visualGoal}, reproducibility ${repro ?? '?'}/${reproGoal}.`);
  console.log(`  re-run with more rounds (--rounds N) or inspect: visually check ${id}`);
}
