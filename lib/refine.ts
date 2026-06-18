// `visually refine <scene>` — the unified 3D ⇄ implementation self-improvement
// loop. Each round runs the *visual* self-improvement pass (improve: render →
// VLM critique → rewrite) and then the *implementation* verification pass
// (reproduce: reverse-implement from the spec + run the backend self-check),
// and stops once BOTH axes clear their thresholds: the visual rubric score and
// the reproducibility score, with the executable self-check passing.
//
// improve and reproduce stay as their own commands (and building blocks); refine
// is the loop that drives them together until the scene is both convincing and
// reproducible.

import { improve } from './improve.js';
import { reproduce } from './reproduce.js';
import { latestVisualScore } from './history.js';
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
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function refine(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) {
    throw new Error('usage: visually refine <scene> [--rounds N] [--visual 90] [--repro 80] [--iters 2] [--driver claude|codex] [--model <m>] [--backend <id>] [--no-verify]');
  }
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);

  const maxRounds = opts.rounds && opts.rounds > 0 ? opts.rounds : 3;
  const visualGoal = Number.isFinite(opts.visual) ? (opts.visual as number) : 90;
  const reproGoal = Number.isFinite(opts.repro) ? (opts.repro as number) : 80;
  const iters = opts.iters && opts.iters > 0 ? opts.iters : 2;

  console.log(`visually refine: ${id} — mutual 3D ⇄ implementation loop`);
  console.log(`  goals: visual ≥ ${visualGoal}/100, reproducibility ≥ ${reproGoal}/100, self-check passing`);
  console.log(`  up to ${maxRounds} round(s)\n`);

  let visual: number | null = null;
  let repro: number | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n════════ refine round ${round}/${maxRounds} ════════`);

    // 1. Visual self-improvement. Tolerate a failed pass (e.g. a render hiccup):
    // the saved scene is intact and the loop can still verify it.
    console.log(`\n▶ visual self-improvement (${iters} iteration(s))…`);
    try {
      const improveArgs = [id, String(iters)];
      if (opts.driver) improveArgs.push('--driver', opts.driver);
      if (opts.model) improveArgs.push('--model', opts.model);
      await improve(improveArgs);
    } catch (err) {
      console.log(`  ⚠ visual pass stopped: ${(err as Error).message}`);
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
    repro = report && Number.isFinite(Number(report.reproducibility)) ? Number(report.reproducibility) : null;

    const ev = report?.executable_verification;
    const verifyEnabled = !!ev?.enabled;
    const verifyPass = verifyEnabled ? ev.passed > 0 && ev.passed === ev.total : null;

    const visualOk = visual != null && visual >= visualGoal;
    const reproOk = repro != null && repro >= reproGoal;
    const verifyOk = !verifyEnabled || verifyPass === true;

    console.log(
      `\n  round ${round} — visual ${visual ?? '?'}/${visualGoal} ${visualOk ? '✓' : '…'}` +
      `  ·  repro ${repro ?? '?'}/${reproGoal} ${reproOk ? '✓' : '…'}` +
      `  ·  self-check ${verifyEnabled ? (verifyPass ? 'PASS ✓' : 'fail') : 'n/a'}`,
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
