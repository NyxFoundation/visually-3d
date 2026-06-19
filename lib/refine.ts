// `visually refine <scene>` — the REFINE leg: the closed loop that drives a scene
// toward the goals (and, ultimately, toward a better / SOTA design). Each round:
//
//   1. visualize — fetch/keep the ground-truth evidence and improve the 3D model
//                  GROUNDED in the real source (lib/visualize.ts);
//   2. verify    — formally check it with the backend and fold the findings back
//                  into the spec (lib/verify.ts).
//
// refine owns only the LOOP concerns: the visual-budget taper, the goal check,
// and the ratchet that never lets the scene end worse than the best round seen.
// The two legs are reusable on their own (`visualize` / `verify` commands).

import { writeFileSync, readFileSync } from 'node:fs';
import { visualizeStep } from './visualize.js';
import { verifyStep } from './verify.js';
import { latestVisualScore } from './history.js';
import { specCoverage } from './scene.js';
import { repairArithmeticClaims } from './arith-audit.js';
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
  noEvidence?: boolean;
  noRefs?: boolean;
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
    else if (a === '--no-evidence') opts.noEvidence = true;
    else if (a === '--no-refs') opts.noRefs = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function refine(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) {
    throw new Error('usage: visually refine <scene> [--rounds N] [--visual 90] [--repro 80] [--iters 1] [--driver claude|codex] [--model <m>] [--backend <id>] [--no-verify] [--no-amend] [--no-evidence] [--no-refs]');
  }
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);

  const maxRounds = opts.rounds && opts.rounds > 0 ? opts.rounds : 3;
  const visualGoal = Number.isFinite(opts.visual) ? (opts.visual as number) : 90;
  const reproGoal = Number.isFinite(opts.repro) ? (opts.repro as number) : 80;
  const iters = opts.iters && opts.iters > 0 ? opts.iters : 1;

  console.log(`visually refine: ${id} — closed loop (visualize → verify)`);
  console.log(`  goals: visual ≥ ${visualGoal}/100, reproducibility ≥ ${reproGoal}/100, self-check passing`);
  console.log(`  up to ${maxRounds} round(s)\n`);

  let visual: number | null = null;
  let repro: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastReport: any = null;

  // Feedback-driven visual budget: the visual pass is the most token-heavy step,
  // so it is not run on a fixed schedule. Below the goal → one improving pass per
  // round; at/above the goal → run ONLY when last round's verify changed the spec
  // (so the visual layer folds in the new feedback), else skip entirely.
  let visualCleared = false;
  let lastAmendApplied = false;

  // Ratchet: keep the highest-scoring scene seen, so a regressing round never
  // leaves the canonical scene worse than the best round already achieved. A
  // passing self-check dominates the raw reproducibility number. (FunSearch /
  // AlphaEvolve / Darwin Gödel Machine: only the best individual survives.)
  let best: { score: number; snapshot: string; round: number; visual: number | null; repro: number | null } | null = null;
  let roundScore: number | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n════════ refine round ${round}/${maxRounds} ════════`);

    // 1. VISUALIZE — ground-truth evidence (fetched once, then cached) + a
    // source-grounded visual pass. Budget: below the goal → one pass; at/above →
    // only when last round's spec changed; otherwise skip.
    const roundIters = !visualCleared ? iters : (lastAmendApplied ? Math.min(1, iters) : 0);
    if (roundIters > 0) {
      console.log(`\n▶ visualize (${roundIters} iteration(s))…` +
        (visualCleared ? `  [feedback-driven — last round's spec changes to fold in]` : ''));
      try {
        await visualizeStep(id, {
          iters: roundIters,
          model: opts.model,
          driver: opts.driver,
          report: lastReport,
          noEvidence: opts.noEvidence,
          refs: !opts.noRefs,
        });
      } catch (err) {
        console.log(`  ⚠ visualize stopped: ${(err as Error).message}`);
      }
    } else {
      console.log(`\n▶ visualize — skipped (visual ≥ ${visualGoal}, no new spec feedback to fold in)`);
    }
    visual = latestVisualScore(id);
    visualCleared = visual != null && visual >= visualGoal;

    // Snapshot the scene exactly as it is about to be SCORED (post-visual,
    // pre-verify) — the unit the ratchet keeps or rolls back to.
    let scoredSnapshot = '';
    try { scoredSnapshot = readFileSync(target, 'utf8'); } catch { /* ignore */ }

    // 2. VERIFY — formal check + fold findings back into the spec.
    console.log(`\n▶ verify…`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let report: any = null;
    try {
      const r = await verifyStep(id, {
        model: opts.model,
        backend: opts.backend,
        noVerify: opts.noVerify,
        noAmend: opts.noAmend,
      });
      report = r.report;
      lastAmendApplied = r.amendApplied;
    } catch (err) {
      console.log(`  ⚠ verify stopped: ${(err as Error).message}`);
      lastAmendApplied = false;
    }
    const prevRepro = repro;
    repro = report && Number.isFinite(Number(report.reproducibility)) ? Number(report.reproducibility) : null;
    lastReport = report;

    const ev = report?.executable_verification;
    const verifyEnabled = !!ev?.enabled;
    const verifyPass = verifyEnabled ? ev.passed > 0 && ev.passed === ev.total : null;

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

    // Ratchet: remember the best-scoring SCORED scene (a clean self-check
    // outweighs the raw reproducibility number).
    if (report && scoredSnapshot) {
      roundScore = (verifyOk ? 1000 : 0) + (repro ?? 0);
      if (!best || roundScore > best.score) {
        best = { score: roundScore, snapshot: scoredSnapshot, round, visual, repro };
        console.log(`  ↑ new best (round ${round}): repro ${repro ?? '?'}, self-check ${verifyEnabled ? (verifyPass ? 'pass' : 'fail') : 'n/a'}`);
      }
    }
  }

  // Don't END worse than the best round.
  console.log(`\n△ refine: reached ${maxRounds} round(s) without clearing every threshold.`);
  if (best && roundScore != null && roundScore < best.score) {
    writeSceneSanitized(target, best.snapshot);
    console.log(`  final round regressed — kept the best round (${best.round}): visual ${best.visual ?? '?'}/${visualGoal}, reproducibility ${best.repro ?? '?'}/${reproGoal}.`);
  } else {
    console.log(`  best — visual ${visual ?? '?'}/${visualGoal}, reproducibility ${repro ?? '?'}/${reproGoal}.`);
  }
  console.log(`  re-run with more rounds (--rounds N) or inspect: visually check ${id}`);
}

// Write a scene snapshot back to disk, repairing any false numeric constant on
// the way out — so a ratchet rollback/restore can never re-commit one.
function writeSceneSanitized(target: string, sceneJson: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = JSON.parse(sceneJson);
    const { value } = repairArithmeticClaims(obj);
    writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
  } catch {
    writeFileSync(target, sceneJson);
  }
}
