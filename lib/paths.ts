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

export function ensureWorkspace(): void {
  fs.mkdirSync(SCENES_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
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
