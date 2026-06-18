// `visually create <name>` — generate a MachineSceneDescriptor from scratch
// using the user's own Claude or Codex CLI, and persist it to the workspace so
// `check`, `improve` and `upload` can act on it.
//
// The generation mode (hardware | algorithm | architecture) is auto-detected
// from the subject and selects the persona, quality bar, material vocabulary
// and modelling strategy. Override with --mode.
//
// Every run streams the model's reasoning live and is fully logged under
// ~/.visually-3d/runs/create-<id>-<stamp>/ for later inspection.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt, detectMode } from '../server/analyst.js';
import { MODE_IDS, modeLabel } from '../server/modes.js';
import { runClaudeStreaming } from './runner.js';
import { improve } from './improve.js';
import { extractScene, validateScene, slugify } from './scene.js';
import { ensureWorkspace, scenePath, RUNS_DIR } from './paths.js';

// Minimum built-in refinement loops: a one-shot generation is a first draft,
// not a finished scene. Like `improve`, create then runs the visual recursive
// self-improvement loop (render → VLM critique → rewrite) at least this many
// times before handing back. Override with --refine N, disable with --no-refine.
const MIN_REFINE = 3;

const exec = promisify(execFile);

interface CreateOpts {
  driver: string;
  positional: string[];
  id?: string;
  hint?: string;
  url?: string;
  model?: string;
  mode?: string;
  refine?: number;
  force?: boolean;
}

function parseArgs(argv: string[]): CreateOpts {
  const opts: CreateOpts = { driver: 'claude', positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--driver') opts.driver = argv[++i];
    else if (a === '--id') opts.id = argv[++i];
    else if (a === '--hint') opts.hint = argv[++i];
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--refine') opts.refine = Number(argv[++i]);
    else if (a === '--no-refine') opts.refine = 0;
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

// ISO-ish compact timestamp for run directory names: 20260617-140530.
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function runCodex(prompt: string, runDir: string): Promise<string> {
  const bin = process.env.CODEX_BIN || 'codex';
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visually-'));
  const out = path.join(tmp, 'msg.txt');
  try {
    await exec(
      bin,
      ['exec', '--sandbox', 'read-only', '--skip-git-repo-check',
       '--output-last-message', out, prompt],
      { maxBuffer: 64 * 1024 * 1024, timeout: 600000 },
    );
    const text = readFileSync(out, 'utf8');
    if (runDir) writeFileSync(path.join(runDir, 'reasoning.log'), text);
    return text;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function create(argv: string[]): Promise<string> {
  const opts = parseArgs(argv);
  const name = opts.positional.join(' ').trim();
  if (!name && !opts.url) {
    throw new Error('usage: visually create "<machine name>" [--hint <text>] [--url <url>] [--mode hardware|algorithm|architecture] [--driver claude|codex] [--id <id>]');
  }

  const id = opts.id || slugify(name || opts.url);
  ensureWorkspace();
  const out = scenePath(id);
  if (existsSync(out) && !opts.force) {
    throw new Error(`scene "${id}" already exists at ${out} — pass --force to overwrite, or --id <name> for a different id`);
  }

  // Resolve mode: explicit --mode wins, else auto-detect from the subject text.
  if (opts.mode && !MODE_IDS.includes(opts.mode)) {
    throw new Error(`unknown --mode "${opts.mode}" (choose: ${MODE_IDS.join(', ')})`);
  }
  const mode = opts.mode || detectMode(`${name || ''} ${opts.hint || ''} ${opts.url || ''}`);

  // Per-run log directory: everything about this generation lands here.
  const runDir = path.join(RUNS_DIR, `create-${id}-${stamp()}`);
  mkdirSync(runDir, { recursive: true });

  const t0 = Date.now();
  console.log(`visually create: "${name || opts.url}" — mode=${modeLabel(mode)}, driver=${opts.driver}`);
  console.log(`  run log → ${runDir}`);

  const machineName = opts.hint ? `${name} (${opts.hint})` : name;
  const prompt = await buildPrompt({ url: opts.url, machineName, mode });
  writeFileSync(path.join(runDir, 'prompt.txt'), prompt);

  // Generate the scene, streaming reasoning live (claude) or batch (codex).
  let raw: string;
  if (opts.driver === 'codex') {
    raw = await runCodex(prompt, runDir);
  } else {
    const { text } = await runClaudeStreaming({ prompt, model: opts.model, runDir });
    raw = text;
  }
  writeFileSync(path.join(runDir, 'raw.txt'), raw);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene: any = extractScene(raw);
  // Stamp the mode into metadata so the gallery/UI can show it.
  scene.metadata = scene.metadata || {};
  if (!scene.metadata.mode) scene.metadata.mode = mode;

  const errors = validateScene(scene);
  const meta = {
    id, name, mode, driver: opts.driver,
    model: opts.model || process.env.CLAUDE_MODEL || 'opus',
    url: opts.url || null, hint: opts.hint || null,
    parts: Array.isArray(scene.parts) ? scene.parts.length : 0,
    valid: errors.length === 0, errors,
    elapsed_ms: Date.now() - t0,
  };
  writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  if (errors.length) {
    writeFileSync(path.join(runDir, 'scene.invalid.json'), JSON.stringify(scene, null, 2) + '\n');
    throw new Error(`generated scene failed validation (see ${runDir}/scene.invalid.json):\n  - ${errors.join('\n  - ')}`);
  }

  writeFileSync(out, JSON.stringify(scene, null, 2) + '\n');
  writeFileSync(path.join(runDir, 'scene.json'), JSON.stringify(scene, null, 2) + '\n');

  console.log(`\n  ✓ draft ${id} → ${out} (${scene.parts.length} parts, mode=${modeLabel(mode)})`);

  // Built-in visual self-improvement: a draft is not a finished scene. Run the
  // recursive render→critique→rewrite loop at least MIN_REFINE times. It picks
  // up this create run's reasoning as cross-run memory (see lib/history.js).
  const refineN = opts.refine === undefined ? MIN_REFINE : Math.max(0, opts.refine | 0);
  if (refineN > 0) {
    console.log(`\n  refining: ${refineN} visual self-improvement loop(s) (render → critique → rewrite)…`);
    console.log(`  (skip with --no-refine; the draft above is already saved)\n`);
    try {
      const improveArgs = [id, String(refineN)];
      if (opts.driver) improveArgs.push('--driver', opts.driver);
      if (opts.model) improveArgs.push('--model', opts.model);
      await improve(improveArgs);
    } catch (err) {
      console.log(`\n  ⚠ refinement loop stopped: ${(err as Error).message}`);
      console.log(`     the draft scene is intact; re-run: visually improve ${id}`);
    }
  }

  console.log('\n  next:');
  console.log(`    visually check ${id}            # open it in the browser`);
  console.log(`    visually improve ${id}          # refine further (continues from this run's memory)`);
  console.log(`    visually upload ${id}           # open a PR to the samples gallery`);
  return out;
}
