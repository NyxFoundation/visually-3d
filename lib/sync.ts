// `visually sync <scene>` — mirror a scene's LOCAL workspace artifacts (its
// scene JSON, the full visualize/verify/refine run history, the gathered
// evidence, and the canonical impl) into the repo-tracked `examples/<id>/`, so a
// plain `git add examples && git commit && git push` carries the history as-is.
//
// Explicit on purpose: the loop writes to `~/.visually-3d` (outside any repo);
// this is the deliberate step that promotes a scene's history into version
// control. The curated `examples/<id>/notes.md` (if any) is preserved.

import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  resolveScene, sceneIdFromPath, scenePath, sceneRunsDir, evidenceDir,
  packagedExampleDir,
} from './paths.js';
import { implDir } from './impls.js';

// Copy a whole directory tree (as-is) into dest, replacing any prior copy so the
// mirror never keeps stale files. No-op when the source is absent.
function mirrorDir(src: string, dest: string): number {
  if (!existsSync(src)) return 0;
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  let n = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  walk(dest);
  return n;
}

export interface SyncResult { scene: boolean; runs: number; evidence: number; impl: number; dest: string }

// Mirror everything the loop produced for `id` into `dest` (defaults to the
// package's examples/<id>/). Pure-ish (filesystem only) so it is testable with a
// temp dest.
export function syncScene(id: string, opts: { dest?: string } = {}): SyncResult {
  const dest = opts.dest ?? packagedExampleDir(id);
  mkdirSync(dest, { recursive: true });

  // The canonical scene JSON (the version the loop has been improving).
  const sceneSrc = existsSync(scenePath(id)) ? scenePath(id) : (resolveScene(id) ?? '');
  let scene = false;
  if (sceneSrc && existsSync(sceneSrc)) {
    copyFileSync(sceneSrc, path.join(dest, 'scene.json'));
    scene = true;
  }

  const runs = mirrorDir(sceneRunsDir(id), path.join(dest, 'runs'));
  const evidence = mirrorDir(evidenceDir(id), path.join(dest, 'evidence'));
  const impl = mirrorDir(implDir(id), path.join(dest, 'impl'));
  return { scene, runs, evidence, impl, dest };
}

interface SyncCliOpts { positional: string[] }

function parseArgs(argv: string[]): SyncCliOpts {
  const opts: SyncCliOpts = { positional: [] };
  for (const a of argv) {
    if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function sync(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) throw new Error('usage: visually sync <scene>   (mirror its history into examples/<id>/ for git push)');
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);

  console.log(`visually sync: ${id} — mirroring workspace history into examples/${id}/ (for git push)`);
  const r = syncScene(id);
  console.log(`  scene.json: ${r.scene ? 'copied' : '(none)'}`);
  console.log(`  runs:       ${r.runs} file(s)`);
  console.log(`  evidence:   ${r.evidence} file(s)`);
  console.log(`  impl:       ${r.impl} file(s)`);
  console.log(`  → ${r.dest}`);
  console.log('\n  next: git add examples && git commit -m "samples: sync ' + id + ' history" && git push');
}
