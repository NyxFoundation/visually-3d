// Resolves package-internal paths and the user-writable workspace.
//
// A globally-installed `visually-3d` has no repo checkout, so anything the
// user *creates* (scenes, self-improve run histories) must live outside the
// package. The workspace defaults to ~/.visually-3d and can be relocated with
// $VISUALLY_HOME (handy for tests or per-project workspaces).

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PKG_ROOT = path.join(here, '..');
export const DIST = path.join(PKG_ROOT, 'dist');
export const SCRIPTS = path.join(PKG_ROOT, 'scripts');
export const PROMPTS = path.join(PKG_ROOT, 'prompts');
export const BUNDLED_SAMPLES = path.join(DIST, 'samples');

export const VISUALLY_HOME =
  process.env.VISUALLY_HOME || path.join(os.homedir(), '.visually-3d');
export const SCENES_DIR = path.join(VISUALLY_HOME, 'scenes');
export const RUNS_DIR = path.join(VISUALLY_HOME, 'runs');
// Canonical per-scene implementations distilled from `reproduce` runs: the
// chosen source + its recorded verification, keyed by scene id. The detail
// page reads these to show "source ⇄ 3D" and to re-run the tests live.
export const IMPLS_DIR = path.join(VISUALLY_HOME, 'impls');

export function ensureWorkspace(): void {
  fs.mkdirSync(SCENES_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(IMPLS_DIR, { recursive: true });
  migrateLegacyRuns();
}

// All runs for a scene live under runs/<id>/ (one folder per scene), each run a
// "<type>-<stamp>" subdir. Groups create/improve/reproduce history together and
// avoids the id prefix-collision the old flat layout had.
export function sceneRunsDir(id: string): string {
  return path.join(RUNS_DIR, id);
}

export function runDir(id: string, type: string, stamp: string): string {
  return path.join(RUNS_DIR, id, `${type}-${stamp}`);
}

// Trailing run stamp: YYYYMMDD-HHMMSS.
const RUN_STAMP_RE = /-(\d{8}-\d{6})$/;

// One-time, idempotent, non-destructive migration of legacy *flat* run dirs
// (create-<id>-<stamp>, reproduce-<id>-<stamp>, and bare <id>-<stamp> for
// improve) into the per-scene tree runs/<id>/<type>-<stamp>. Only moves; never
// overwrites an existing destination. A scene-id dir (no trailing stamp) is
// skipped, so re-runs are no-ops once everything is migrated.
export function migrateLegacyRuns(): void {
  let entries: string[];
  try { entries = fs.readdirSync(RUNS_DIR); } catch { return; }
  for (const name of entries) {
    const m = RUN_STAMP_RE.exec(name);
    if (!m) continue; // not a stamped legacy run (e.g. an already-migrated <id> dir)
    const full = path.join(RUNS_DIR, name);
    try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }

    const stamp = m[1];
    const base = name.slice(0, name.length - stamp.length - 1); // strip "-<stamp>"
    let type: string;
    let id: string;
    if (base.startsWith('create-')) { type = 'create'; id = base.slice('create-'.length); }
    else if (base.startsWith('reproduce-')) { type = 'reproduce'; id = base.slice('reproduce-'.length); }
    else { type = 'improve'; id = base; }
    if (!id) continue;

    const dest = runDir(id, type, stamp);
    if (fs.existsSync(dest)) continue; // already migrated / collision — leave it
    try {
      fs.mkdirSync(path.join(RUNS_DIR, id), { recursive: true });
      fs.renameSync(full, dest);
    } catch { /* non-fatal: leave the legacy dir in place */ }
  }
}

export function scenePath(id: string): string {
  return path.join(SCENES_DIR, `${id}.json`);
}

// Resolve a user-supplied scene reference to an absolute path.
// Accepts a bare id ("quadcopter"), a workspace filename, or an explicit
// path. Falls back to the bundled gallery so `improve`/`check`/`upload` work
// on shipped samples too.
export function resolveScene(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (ref.includes('/') || ref.includes(path.sep) || ref.endsWith('.json')) {
    const p = path.resolve(ref);
    if (fs.existsSync(p)) return p;
  }
  const id = ref.replace(/\.json$/, '');
  const inWorkspace = scenePath(id);
  if (fs.existsSync(inWorkspace)) return inWorkspace;
  const bundled = path.join(BUNDLED_SAMPLES, `${id}.json`);
  if (fs.existsSync(bundled)) return bundled;
  return null;
}

export function sceneIdFromPath(p: string): string {
  return path.basename(p).replace(/\.json$/, '');
}
