// `visually upload <scene>` — publish a scene's work (the scene + its full
// visualize/verify/refine history + evidence + impl) into the repo's
// `examples/<id>/`. ONE verb, two paths chosen by HOW the tool is running:
//
//   • In a repo checkout (dev: `bun bin/visually.js`, PKG_ROOT has a .git) —
//     mirror into examples/<id>, commit, and PUSH directly to origin.
//   • Installed via npx/npm (no .git at PKG_ROOT) — fork+clone the upstream,
//     mirror into examples/<id> there, push a branch, and open a PR (the user's
//     own `gh` auth; this tool holds no keys).
//
// The mirror itself (scene + runs + evidence + impl, as-is) is `syncScene`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveScene, sceneIdFromPath, PKG_ROOT } from './paths.js';
import { validateScene } from './scene.js';
import { syncScene } from './sync.js';

const exec = promisify(execFile);
const DEFAULT_REPO = 'NyxFoundation/visually-3d';

async function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await exec(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts });
  return stdout.trim();
}

// True when the running package is a git checkout (the maintainer's dev clone),
// as opposed to an installed npx/npm package. Decides direct-push vs PR.
export function isRepoCheckout(root: string = PKG_ROOT): boolean {
  return existsSync(path.join(root, '.git'));
}

interface UploadOpts {
  positional: string[];
  repo?: string;
  title?: string;
  message?: string;
  dryRun?: boolean;
  noPush?: boolean;
}

function parseArgs(argv: string[]): UploadOpts {
  const opts: UploadOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--message') opts.message = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-push') opts.noPush = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function upload(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) throw new Error('usage: visually upload <scene> [--repo owner/name] [--title <t>] [--no-push] [--dry-run]');
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene: any = JSON.parse(readFileSync(target, 'utf8'));
  const errors = validateScene(scene);
  if (errors.length) {
    throw new Error(`scene "${id}" is invalid — fix it before uploading:\n  - ${errors.join('\n  - ')}`);
  }

  if (isRepoCheckout()) return uploadInRepo(id, opts);
  return uploadViaPR(id, scene, opts);
}

// Dev path: mirror into this repo's examples/<id>, commit just that path, push.
async function uploadInRepo(id: string, opts: UploadOpts): Promise<void> {
  console.log(`visually upload: ${id} → examples/${id}/ in this repo (direct push)`);
  const r = syncScene(id); // dest = PKG_ROOT/examples/<id>
  console.log(`  mirrored: scene ${r.scene ? '✓' : '—'}, runs ${r.runs}, evidence ${r.evidence}, impl ${r.impl} file(s)`);
  const rel = path.relative(PKG_ROOT, r.dest);

  await run('git', ['add', '--', rel], { cwd: PKG_ROOT });
  const staged = await run('git', ['diff', '--cached', '--name-only', '--', rel], { cwd: PKG_ROOT });
  if (!staged) { console.log('  · nothing changed — already up to date.'); return; }

  if (opts.dryRun) {
    console.log('\n' + await run('git', ['diff', '--cached', '--stat', '--', rel], { cwd: PKG_ROOT }));
    console.log('\n  dry run — nothing committed or pushed.');
    return;
  }
  const msg = opts.title || `samples: sync ${id} history`;
  await run('git', ['commit', '-m', msg, '--', rel], { cwd: PKG_ROOT });
  if (opts.noPush) { console.log(`  ✓ committed ${rel} (not pushed — --no-push).`); return; }
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: PKG_ROOT });
  console.log(`  · pushing ${branch} → origin…`);
  await run('git', ['push', 'origin', branch], { cwd: PKG_ROOT });
  console.log(`  ✓ pushed examples/${id} to origin/${branch}.`);
}

// Installed path: fork+clone upstream, mirror into its examples/<id>, open a PR.
async function uploadViaPR(id: string, scene: { machine_name?: string; parts?: unknown[] }, opts: UploadOpts): Promise<void> {
  try { await run('gh', ['--version']); } catch {
    throw new Error('GitHub CLI (`gh`) is required to upload from an installed copy — install it from https://cli.github.com');
  }
  try { await run('gh', ['auth', 'status']); } catch {
    throw new Error('not logged in to GitHub — run `gh auth login` first');
  }
  const upstream = opts.repo || DEFAULT_REPO;
  const user = await run('gh', ['api', 'user', '-q', '.login']);
  const branch = `add-scene-${id}`;
  const title = opts.title || `samples: add ${scene.machine_name || id}`;
  const body = opts.message ||
    `Adds the \`${id}\` scene${Array.isArray(scene.parts) ? ` (${scene.parts.length} parts)` : ''} and its history to examples/.\n\nGenerated and refined locally with visually-3d.`;

  console.log(`visually upload: ${id} → PR to ${upstream} (as ${user})`);
  if (opts.dryRun) console.log('  (dry run — will not push or open a PR)');

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visually-upload-'));
  try {
    console.log('  · forking + cloning…');
    await run('gh', ['repo', 'fork', upstream, '--clone', '--remote=false'], { cwd: tmp });
    const repoName = upstream.split('/')[1];
    const cwd = path.join(tmp, repoName);
    if (!existsSync(cwd)) throw new Error(`clone not found at ${cwd}`);
    await run('git', ['checkout', '-B', branch], { cwd });

    const r = syncScene(id, { dest: path.join(cwd, 'examples', id) });
    console.log(`  · mirrored into examples/${id}/ (scene ${r.scene ? '✓' : '—'}, runs ${r.runs}, evidence ${r.evidence}, impl ${r.impl})`);

    await run('git', ['add', '--', path.join('examples', id)], { cwd });
    await run('git', ['-c', 'user.name=visually-3d', '-c', 'user.email=visually-3d@users.noreply.github.com',
      'commit', '-m', title], { cwd });

    if (opts.dryRun) {
      console.log('\n' + await run('git', ['show', '--stat', 'HEAD'], { cwd }));
      console.log('\n  dry run complete — nothing pushed.');
      return;
    }
    console.log('  · pushing branch…');
    await run('git', ['push', '-u', 'origin', branch, '--force'], { cwd });
    console.log('  · opening pull request…');
    const prUrl = await run('gh', ['pr', 'create',
      '--repo', upstream, '--head', `${user}:${branch}`, '--title', title, '--body', body,
    ], { cwd });
    console.log(`\n  ✓ PR opened: ${prUrl}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
