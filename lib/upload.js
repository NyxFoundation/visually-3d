// `visually upload <scene>` — contribute a scene to the samples gallery by
// opening a pull request, using the user's own `gh` auth (no API keys held by
// this tool). Forks the upstream repo if needed, adds the scene under
// public/samples/, registers it in index.json, and opens the PR.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveScene, sceneIdFromPath } from './paths.js';
import { validateScene, deriveIndexEntry } from './scene.js';

const exec = promisify(execFile);

const DEFAULT_REPO = 'NyxFoundation/visually-3d';

async function run(cmd, args, opts = {}) {
  const { stdout } = await exec(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts });
  return stdout.trim();
}

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--message') opts.message = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function upload(argv) {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) throw new Error('usage: visually upload <scene> [--repo owner/name] [--title <t>] [--dry-run]');

  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);

  const scene = JSON.parse(readFileSync(target, 'utf8'));
  const errors = validateScene(scene);
  if (errors.length) {
    throw new Error(`scene "${id}" is invalid — fix it before uploading:\n  - ${errors.join('\n  - ')}`);
  }

  // Preconditions: gh present and authenticated.
  try {
    await run('gh', ['--version']);
  } catch {
    throw new Error('GitHub CLI (`gh`) is required for upload — install it from https://cli.github.com');
  }
  try {
    await run('gh', ['auth', 'status']);
  } catch {
    throw new Error('not logged in to GitHub — run `gh auth login` first');
  }

  const upstream = opts.repo || DEFAULT_REPO;
  const user = await run('gh', ['api', 'user', '-q', '.login']);
  const branch = `add-scene-${id}`;
  const title = opts.title || `samples: add ${scene.machine_name || id}`;
  const body = opts.message ||
    `Adds the \`${id}\` scene (${scene.parts.length} parts) to the gallery.\n\nGenerated and refined locally with visually-3d.`;

  console.log(`visually upload: ${id} → PR to ${upstream} (as ${user})`);
  if (opts.dryRun) console.log('  (dry run — will not push or open a PR)');

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visually-upload-'));
  try {
    // Fork (idempotent) and clone the fork into the temp dir.
    console.log('  · forking + cloning…');
    await run('gh', ['repo', 'fork', upstream, '--clone', '--remote=false'], { cwd: tmp });
    const repoName = upstream.split('/')[1];
    const cwd = path.join(tmp, repoName);
    if (!existsSync(cwd)) throw new Error(`clone not found at ${cwd}`);

    await run('git', ['checkout', '-B', branch], { cwd });

    const samplesDir = path.join(cwd, 'public', 'samples');
    if (!existsSync(samplesDir)) throw new Error(`${upstream} has no public/samples/ — is this the right repo?`);
    copyFileSync(target, path.join(samplesDir, `${id}.json`));

    // Register in index.json (append if absent).
    const indexPath = path.join(samplesDir, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.samples = index.samples || [];
    if (!index.samples.some((s) => s.id === id)) {
      const { source, ...entry } = deriveIndexEntry(scene, id);
      index.samples.push(entry);
      writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
    } else {
      console.log(`  · ${id} already in index.json — updating scene only`);
    }

    await run('git', ['add', 'public/samples'], { cwd });
    await run('git', ['-c', 'user.name=visually-3d', '-c', 'user.email=visually-3d@users.noreply.github.com',
      'commit', '-m', title], { cwd });

    if (opts.dryRun) {
      const diff = await run('git', ['show', '--stat', 'HEAD'], { cwd });
      console.log('\n' + diff);
      console.log('\n  dry run complete — nothing pushed.');
      return;
    }

    console.log('  · pushing branch…');
    await run('git', ['push', '-u', 'origin', branch, '--force'], { cwd });

    console.log('  · opening pull request…');
    const prUrl = await run('gh', ['pr', 'create',
      '--repo', upstream,
      '--head', `${user}:${branch}`,
      '--title', title,
      '--body', body,
    ], { cwd });
    console.log(`\n  ✓ PR opened: ${prUrl}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
