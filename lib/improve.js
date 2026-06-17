// `visually improve <scene> [iters]` — recursively self-improve a scene with
// visual (VLM) feedback, driven by the user's Claude or Codex CLI. Thin
// wrapper over scripts/self-improve.sh that targets the workspace scene and
// keeps run histories under the workspace (the package dir may be read-only
// for a global install).

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveScene, sceneIdFromPath, SCRIPTS, RUNS_DIR, ensureWorkspace } from './paths.js';
import { collectPriorReflection } from './history.js';

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--driver') opts.driver = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--no-memory') opts.noMemory = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function improve(argv) {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  const iters = opts.positional[1] || '4';
  if (!ref) {
    throw new Error('usage: visually improve <scene> [iterations] [--driver codex|claude] [--model <m>] [--no-memory]');
  }

  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);

  const script = path.join(SCRIPTS, 'self-improve.sh');
  if (!existsSync(script)) throw new Error(`self-improve script not found at ${script}`);

  ensureWorkspace();
  const env = {
    ...process.env,
    DRIVER: opts.driver || process.env.DRIVER || 'claude',
    VISUALLY_RUNS_DIR: RUNS_DIR,
  };
  if (opts.model) env.CLAUDE_MODEL = opts.model;

  // Cross-run memory: seed iteration 1 with the unfinished gaps from prior
  // create/improve runs of this scene, so the loop continues the trial-and-
  // error instead of restarting cold. (--no-memory opts out.)
  if (!opts.noMemory) {
    const id = sceneIdFromPath(target);
    const seed = collectPriorReflection(id);
    if (seed) {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'visually-seed-'));
      const seedPath = path.join(tmp, 'seed-review.json');
      writeFileSync(seedPath, JSON.stringify(seed, null, 2));
      env.VISUALLY_SEED_REVIEW = seedPath;
      const n = (seed.prior_remaining_gaps || []).length;
      console.log(`visually improve: seeding from prior runs (${seed.source}) — ${n} carried-over gap(s)`);
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn('sh', [script, target, iters], { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`self-improve exited with code ${code}`));
    });
  });
}
