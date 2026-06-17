// `visually create <machine name>` — generate a MachineSceneDescriptor from
// scratch using the user's own Claude or Codex CLI, and persist it to the
// workspace so `check`, `improve` and `upload` can act on it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt } from '../server/analyst.js';
import { extractScene, validateScene, slugify } from './scene.js';
import { ensureWorkspace, scenePath } from './paths.js';

const exec = promisify(execFile);

function parseArgs(argv) {
  const opts = { driver: 'claude', positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--driver') opts.driver = argv[++i];
    else if (a === '--id') opts.id = argv[++i];
    else if (a === '--hint') opts.hint = argv[++i];
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

async function runClaude(prompt, model) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const { stdout } = await exec(
    bin,
    ['-p', prompt, '--model', model || process.env.CLAUDE_MODEL || 'opus', '--tools', ''],
    { maxBuffer: 64 * 1024 * 1024, timeout: 600000 },
  );
  return stdout;
}

async function runCodex(prompt) {
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
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function create(argv) {
  const opts = parseArgs(argv);
  const name = opts.positional.join(' ').trim();
  if (!name && !opts.url) {
    throw new Error('usage: visually create "<machine name>" [--hint <text>] [--url <url>] [--driver claude|codex] [--id <id>]');
  }

  const id = opts.id || slugify(name || opts.url);
  ensureWorkspace();
  const out = scenePath(id);
  if (existsSync(out) && !opts.force) {
    throw new Error(`scene "${id}" already exists at ${out} — pass --force to overwrite, or --id <name> for a different id`);
  }

  const machineName = opts.hint ? `${name} (${opts.hint})` : name;
  const prompt = await buildPrompt({ url: opts.url, machineName });

  console.log(`visually create: generating "${name || opts.url}" via ${opts.driver}…`);
  const raw = opts.driver === 'codex' ? await runCodex(prompt) : await runClaude(prompt, opts.model);

  const scene = extractScene(raw);
  const errors = validateScene(scene);
  if (errors.length) {
    throw new Error(`generated scene failed validation:\n  - ${errors.join('\n  - ')}`);
  }

  writeFileSync(out, JSON.stringify(scene, null, 2) + '\n');
  console.log(`\n  ✓ ${id} → ${out} (${scene.parts.length} parts)`);
  console.log('\n  next:');
  console.log(`    visually check ${id}            # open it in the browser`);
  console.log(`    visually improve ${id}          # recursively refine it`);
  console.log(`    visually upload ${id}           # open a PR to the samples gallery`);
  return out;
}
