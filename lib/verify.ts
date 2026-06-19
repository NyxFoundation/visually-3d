// `visually verify <scene>` — the VERIFY leg of the loop. Formally checks the
// system with the auto-selected backend (z3/SMT for circuits & algorithms, a
// physics sim for machines) and folds the findings back into the scene's spec.
//
// Assumes `visualize` has already cached the ground-truth evidence and built the
// 3D model. Loosely coupled: refine calls verifyStep() per round; the CLI wrapper
// adds resolve + a usage error.

import { reproduce } from './reproduce.js';
import { amendScene } from './amend.js';
import { resolveScene, sceneIdFromPath } from './paths.js';

export interface VerifyStepOpts {
  model?: string;
  backend?: string;
  n?: number;
  noVerify?: boolean; // skip executable verification (judge-only)
  noAmend?: boolean; // verify but do not fold findings back into the spec
}

// Run the verification pass and fold its findings into the spec. Returns the
// report plus whether amend actually changed the spec (the loop uses the latter
// to decide whether the visual layer needs to catch up next round).
export async function verifyStep(
  id: string,
  opts: VerifyStepOpts = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ report: any; amendApplied: boolean }> {
  const reproArgs = [id];
  if (opts.model) reproArgs.push('--model', opts.model);
  if (opts.backend) reproArgs.push('--backend', opts.backend);
  if (opts.n !== undefined && Number.isFinite(opts.n)) reproArgs.push('--n', String(opts.n));
  if (opts.noVerify) reproArgs.push('--no-verify');
  const report = await reproduce(reproArgs);

  let amendApplied = false;
  if (report && !opts.noAmend) {
    const target = resolveScene(id);
    if (target) {
      console.log('\n▶ folding verification findings into the spec…');
      try {
        const res = await amendScene(target, report, { model: opts.model });
        amendApplied = res.applied;
        if (res.applied) console.log(`  ✓ spec grown: ${res.before} → ${res.after} fields written back`);
        else console.log(`  · spec unchanged (${res.reason})`);
      } catch (err) {
        console.log(`  ⚠ amend stopped: ${(err as Error).message}`);
      }
    }
  }
  return { report, amendApplied };
}

interface VerifyCliOpts {
  positional: string[];
  model?: string; backend?: string; n?: number; noVerify?: boolean; noAmend?: boolean;
}

function parseArgs(argv: string[]): VerifyCliOpts {
  const opts: VerifyCliOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opts.model = argv[++i];
    else if (a === '--backend') opts.backend = argv[++i];
    else if (a === '--n') opts.n = Number(argv[++i]);
    else if (a === '--no-verify') opts.noVerify = true;
    else if (a === '--no-amend') opts.noAmend = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function verify(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) {
    throw new Error('usage: visually verify <scene> [--n 2] [--model <m>] [--backend <id>] [--no-verify] [--no-amend]');
  }
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);
  console.log(`visually verify: ${id} — formal verification + fold findings into the spec`);
  await verifyStep(id, opts);
}
