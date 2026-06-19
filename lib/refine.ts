// `visually refine <scene>` — the REFINE leg: the closed loop that drives a scene
// toward a convincing, source-faithful, formally-verified design. Each round:
//
//   1. visualize — keep the ground-truth evidence cached and improve the 3D model
//                  GROUNDED in the real source (lib/visualize.ts);
//   2. verify    — formally check the REAL source with the backend (lib/verify.ts).
//
// refine owns only the LOOP concerns: the visual-budget taper, the goal check
// (visual cleared + verify passes), and the ratchet that never lets the scene end
// worse than the best round seen. Both legs are reusable on their own.

import { writeFileSync, readFileSync } from 'node:fs';
import { visualizeStep } from './visualize.js';
import { verifyStep } from './verify.js';
import { latestVisualScore } from './history.js';
import { repairArithmeticClaims } from './arith-audit.js';
import { resolveScene, sceneIdFromPath } from './paths.js';

interface RefineOpts {
  positional: string[];
  rounds?: number;
  visual?: number;
  iters?: number;
  driver?: string;
  model?: string;
  backend?: string;
  noEvidence?: boolean;
  noRefs?: boolean;
}

function parseArgs(argv: string[]): RefineOpts {
  const opts: RefineOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rounds') opts.rounds = Number(argv[++i]);
    else if (a === '--visual') opts.visual = Number(argv[++i]);
    else if (a === '--iters') opts.iters = Number(argv[++i]);
    else if (a === '--driver') opts.driver = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--backend') opts.backend = argv[++i];
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
    throw new Error('usage: visually refine <scene> [--rounds N] [--visual 90] [--iters 1] [--driver claude|codex] [--model <m>] [--backend <id>] [--no-evidence] [--no-refs]');
  }
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);

  const maxRounds = opts.rounds && opts.rounds > 0 ? opts.rounds : 3;
  const visualGoal = Number.isFinite(opts.visual) ? (opts.visual as number) : 90;
  const iters = opts.iters && opts.iters > 0 ? opts.iters : 1;

  console.log(`visually refine: ${id} — closed loop (visualize → verify)`);
  console.log(`  goals: visual ≥ ${visualGoal}/100 and the source verifies (z3/sim pass)`);
  console.log(`  up to ${maxRounds} round(s)\n`);

  let visual: number | null = null;
  let visualCleared = false;

  // Ratchet: keep the best scene seen (a passing verify dominates the visual
  // score), so a regressing round never leaves the canonical scene worse.
  let best: { score: number; snapshot: string; round: number; visual: number | null; pass: boolean } | null = null;
  let roundScore: number | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n════════ refine round ${round}/${maxRounds} ════════`);

    // 1. VISUALIZE — ground-truth evidence (cached) + a source-grounded visual
    // pass. Budget taper: improve while visual is below the goal; once cleared,
    // stop spending the heavy visual pass (verify keeps running).
    const roundIters = visualCleared ? 0 : iters;
    if (roundIters > 0) {
      console.log(`\n▶ visualize (${roundIters} iteration(s))…`);
      try {
        await visualizeStep(id, {
          iters: roundIters,
          model: opts.model,
          driver: opts.driver,
          noEvidence: opts.noEvidence,
          refs: !opts.noRefs,
        });
      } catch (err) {
        console.log(`  ⚠ visualize stopped: ${(err as Error).message}`);
      }
    } else {
      console.log(`\n▶ visualize — skipped (visual ≥ ${visualGoal})`);
    }
    visual = latestVisualScore(id);
    visualCleared = visual != null && visual >= visualGoal;

    // Snapshot the scored scene for the ratchet.
    let scoredSnapshot = '';
    try { scoredSnapshot = readFileSync(target, 'utf8'); } catch { /* ignore */ }

    // 2. VERIFY — formal verification of the real source.
    console.log(`\n▶ verify…`);
    let verifyPass = false;
    let verifyKind = 'n/a';
    try {
      const r = await verifyStep(id, { model: opts.model, backend: opts.backend });
      verifyPass = r.pass;
      verifyKind = r.kind;
    } catch (err) {
      console.log(`  ⚠ verify stopped: ${(err as Error).message}`);
    }

    const visualOk = visual != null && visual >= visualGoal;
    console.log(
      `\n  round ${round} — visual ${visual ?? '?'}/${visualGoal} ${visualOk ? '✓' : '…'}` +
      `  ·  verify ${verifyPass ? 'PASS ✓' : verifyKind}`,
    );

    if (visualOk && verifyPass) {
      console.log(`\n✓ refine: goals met after ${round} round(s) — convincing, source-faithful, and verified.`);
      return;
    }

    if (scoredSnapshot) {
      roundScore = (verifyPass ? 1000 : 0) + (visual ?? 0);
      if (!best || roundScore > best.score) {
        best = { score: roundScore, snapshot: scoredSnapshot, round, visual, pass: verifyPass };
        console.log(`  ↑ new best (round ${round}): visual ${visual ?? '?'}, verify ${verifyPass ? 'pass' : 'fail'}`);
      }
    }
  }

  console.log(`\n△ refine: reached ${maxRounds} round(s) without clearing every goal.`);
  if (best && roundScore != null && roundScore < best.score) {
    writeSceneSanitized(target, best.snapshot);
    console.log(`  final round regressed — kept the best round (${best.round}): visual ${best.visual ?? '?'}/${visualGoal}, verify ${best.pass ? 'pass' : 'fail'}.`);
  } else {
    console.log(`  best — visual ${visual ?? '?'}/${visualGoal}.`);
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
