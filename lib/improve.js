// `visually improve <scene> [iters]` — recursively self-improve a scene with
// visual (VLM) feedback, driven by the user's Claude or Codex CLI. Thin
// wrapper over scripts/self-improve.sh that targets the workspace scene and
// keeps run histories under the workspace (the package dir may be read-only
// for a global install).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveScene, SCRIPTS, RUNS_DIR, ensureWorkspace } from './paths.js';

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--driver') opts.driver = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
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
    throw new Error('usage: visually improve <scene> [iterations] [--driver codex|claude] [--model <m>]');
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

  return new Promise((resolve, reject) => {
    const child = spawn('sh', [script, target, iters], { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`self-improve exited with code ${code}`));
    });
  });
}
