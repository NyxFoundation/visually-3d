// `visually upload <scene>` — publish a scene's work into the WEB GALLERY
// (`public/samples/`, which is what the site at /samples reads): the refined
// scene JSON, its gallery index entry, and its full run history under
// `public/samples/runs/<id>/`. ONE verb, two paths chosen by HOW it runs:
//
//   • In a repo checkout (dev: `bun bin/visually.js`, PKG_ROOT has a .git) —
//     write into public/samples, commit those paths, and PUSH to origin.
//   • Installed via npx/npm (no .git at PKG_ROOT) — fork+clone upstream, write
//     into its public/samples, push a branch, open a PR (the user's own `gh`).
//
// (examples/<id>/ is a SEPARATE thing — the curated evidence seed the loop reads;
// the web never serves it, so publishing goes to public/samples instead.)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync,
  mkdtempSync, readdirSync, statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveScene, sceneIdFromPath, RUNS_DIR, PKG_ROOT } from './paths.js';
import { validateScene, deriveIndexEntry } from './scene.js';

const exec = promisify(execFile);
const DEFAULT_REPO = 'NyxFoundation/visually-3d';

// Heavy raw traces the gallery never shows — skipped only with --scrub.
const HISTORY_SKIP = /(-events\.jsonl|\.err|raw\.txt|raw\.md|prompt\.txt|reasoning\.log|report\.raw\.txt|stream\.jsonl|^impl-\d+\.txt)$/;

// The lean set the STATIC gallery's history timeline actually renders
// (iteration renders + reviews, verify logs + the self-check source): the
// `web` publish profile keeps only these — ~1-2 MB for a long history
// instead of tens of MB.
const WEB_KEEP = /(-render\.png|-review\.json)$|^verify-\d+\.txt$|^check-\d+\.[a-z]+$/;

// What of a run's history gets published: 'full' ships everything, 'scrub'
// drops the heavy raw traces, 'web' keeps only what the static site shows.
export type HistoryProfile = 'full' | 'scrub' | 'web';

function keepInProfile(file: string, profile: HistoryProfile): boolean {
  if (profile === 'web') return WEB_KEEP.test(file);
  if (profile === 'scrub') return !HISTORY_SKIP.test(file);
  return true;
}

async function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await exec(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts });
  return stdout.trim();
}

// True when the running package is a git checkout (the maintainer's dev clone),
// not an installed npx/npm package. Decides direct-push vs PR.
export function isRepoCheckout(root: string = PKG_ROOT): boolean {
  return existsSync(path.join(root, '.git'));
}

// Copy a scene's run history into <samplesDir>/runs/<id>/ and (re)write its
// manifest. Returns the number of files written.
export function publishHistory(id: string, samplesDir: string, profile: HistoryProfile = 'full'): number {
  const src = path.join(RUNS_DIR, id);
  if (!existsSync(src)) return 0;
  const destRoot = path.join(samplesDir, 'runs', id);
  rmSync(destRoot, { recursive: true, force: true }); // never keep stale files
  let copied = 0;
  for (const runName of readdirSync(src)) {
    const runSrc = path.join(src, runName);
    try { if (!statSync(runSrc).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(runSrc)) {
      if (!keepInProfile(f, profile)) continue;
      const fileSrc = path.join(runSrc, f);
      try { if (!statSync(fileSrc).isFile()) continue; } catch { continue; }
      mkdirSync(path.join(destRoot, runName), { recursive: true });
      copyFileSync(fileSrc, path.join(destRoot, runName, f));
      copied++;
    }
  }
  if (copied > 0) writeHistoryManifest(id, samplesDir);
  return copied;
}

// A published run in <samplesDir>/runs/<id>/manifest.json — what the static
// site's history timeline reads (static hosting cannot list directories).
export interface HistoryRun { dir: string; kind: string; at: string; files: string[] }

const RUN_STAMP = /(\d{8})-(\d{6})/;

// Scan the PUBLISHED runs dir (not the workspace) so extra runs placed there
// by hand are included, and (re)write manifest.json sorted chronologically.
export function writeHistoryManifest(id: string, samplesDir: string): HistoryRun[] {
  const destRoot = path.join(samplesDir, 'runs', id);
  if (!existsSync(destRoot)) return [];
  const runs: HistoryRun[] = [];
  for (const dir of readdirSync(destRoot)) {
    const abs = path.join(destRoot, dir);
    try { if (!statSync(abs).isDirectory()) continue; } catch { continue; }
    const files = readdirSync(abs).filter((f) => {
      try { return statSync(path.join(abs, f)).isFile(); } catch { return false; }
    }).sort();
    if (files.length === 0) continue;
    const stamp = RUN_STAMP.exec(dir);
    const at = stamp
      ? `${stamp[1].slice(0, 4)}-${stamp[1].slice(4, 6)}-${stamp[1].slice(6, 8)}T${stamp[2].slice(0, 2)}:${stamp[2].slice(2, 4)}:${stamp[2].slice(4, 6)}Z`
      : '';
    runs.push({ dir, kind: dir.split('-')[0] || 'other', at, files });
  }
  runs.sort((a, b) => (a.at + a.dir).localeCompare(b.at + b.dir));
  writeFileSync(
    path.join(destRoot, 'manifest.json'),
    JSON.stringify({ id, runs }, null, 2) + '\n',
  );
  return runs;
}

// Write the scene + register it in index.json + copy its history into the gallery
// dir. Returns what changed (relative to the gallery's repo root).
export function publishToGallery(
  id: string,
  sceneSrc: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scene: any,
  samplesDir: string,
  profile: HistoryProfile,
): { runs: number; registered: boolean } {
  mkdirSync(samplesDir, { recursive: true });
  copyFileSync(sceneSrc, path.join(samplesDir, `${id}.json`));

  const indexPath = path.join(samplesDir, 'index.json');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const index: any = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { categories: [{ id: 'all', label: 'All' }], samples: [] };
  index.samples = index.samples || [];
  let registered = false;
  if (!index.samples.some((s: { id: string }) => s.id === id)) {
    const { source, ...entry } = deriveIndexEntry(scene, id);
    void source;
    index.samples.push(entry);
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
    registered = true;
  }
  const runs = publishHistory(id, samplesDir, profile);
  return { runs, registered };
}

interface UploadOpts {
  positional: string[];
  repo?: string; title?: string; message?: string;
  dryRun?: boolean; noPush?: boolean; profile?: HistoryProfile;
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
    else if (a === '--scrub') opts.profile = 'scrub';
    else if (a === '--web') opts.profile = 'web';
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function upload(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) throw new Error('usage: visually upload <scene> [--repo owner/name] [--title <t>] [--scrub|--web] [--no-push] [--dry-run]');
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene: any = JSON.parse(readFileSync(target, 'utf8'));
  const errors = validateScene(scene);
  if (errors.length) {
    throw new Error(`scene "${id}" is invalid — fix it before uploading:\n  - ${errors.join('\n  - ')}`);
  }

  if (isRepoCheckout()) return uploadInRepo(id, target, scene, opts);
  return uploadViaPR(id, target, scene, opts);
}

// Dev path: write into this repo's public/samples, commit those paths, push.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function uploadInRepo(id: string, target: string, scene: any, opts: UploadOpts): Promise<void> {
  const samplesDir = path.join(PKG_ROOT, 'public', 'samples');
  if (!existsSync(samplesDir)) throw new Error(`no public/samples/ at ${PKG_ROOT} — is this the repo?`);
  console.log(`visually upload: ${id} → public/samples/ in this repo (web gallery, direct push)`);
  const r = publishToGallery(id, target, scene, samplesDir, opts.profile ?? 'full');
  console.log(`  scene.json + index ${r.registered ? '(registered)' : '(updated)'}, history ${r.runs} file(s)${opts.profile ? ` [${opts.profile}]` : ''}`);

  const paths = ['public/samples'];
  await run('git', ['add', '--', ...paths], { cwd: PKG_ROOT });
  const staged = await run('git', ['diff', '--cached', '--name-only', '--', ...paths], { cwd: PKG_ROOT });
  if (!staged) { console.log('  · nothing changed — already up to date.'); return; }
  if (opts.dryRun) {
    console.log('\n' + await run('git', ['diff', '--cached', '--stat', '--', ...paths], { cwd: PKG_ROOT }));
    console.log('\n  dry run — nothing committed or pushed.');
    return;
  }
  const msg = opts.title || `samples: publish ${id}`;
  await run('git', ['commit', '-m', msg, '--', ...paths], { cwd: PKG_ROOT });
  if (opts.noPush) { console.log('  ✓ committed public/samples (not pushed — --no-push).'); return; }
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: PKG_ROOT });
  console.log(`  · pushing ${branch} → origin…`);
  await run('git', ['push', 'origin', branch], { cwd: PKG_ROOT });
  console.log(`  ✓ pushed — ${id} will show on the web gallery after the next build/deploy.`);
}

// Installed path: fork+clone upstream, write into its public/samples, open a PR.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function uploadViaPR(id: string, target: string, scene: any, opts: UploadOpts): Promise<void> {
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
    `Adds the \`${id}\` scene (${Array.isArray(scene.parts) ? scene.parts.length : '?'} parts) and its history to the gallery.\n\nGenerated and refined locally with visually-3d.`;

  console.log(`visually upload: ${id} → PR to ${upstream} (as ${user})`);
  if (opts.dryRun) console.log('  (dry run — will not push or open a PR)');

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visually-upload-'));
  try {
    console.log('  · forking + cloning…');
    await run('gh', ['repo', 'fork', upstream, '--clone', '--remote=false'], { cwd: tmp });
    const cwd = path.join(tmp, upstream.split('/')[1]);
    if (!existsSync(cwd)) throw new Error(`clone not found at ${cwd}`);
    await run('git', ['checkout', '-B', branch], { cwd });

    const samplesDir = path.join(cwd, 'public', 'samples');
    if (!existsSync(samplesDir)) throw new Error(`${upstream} has no public/samples/ — is this the right repo?`);
    const r = publishToGallery(id, target, scene, samplesDir, opts.profile ?? 'full');
    console.log(`  · public/samples/${id}.json + index ${r.registered ? '(registered)' : '(updated)'}, history ${r.runs} file(s)`);

    await run('git', ['add', '--', 'public/samples'], { cwd });
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
