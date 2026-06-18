// Cross-run memory for the self-improvement loop (Reflexion across processes).
//
// Each `create` and `improve` run leaves a directory under ~/.visually-3d/runs.
// A fresh `improve` would otherwise start cold, re-discovering gaps that a
// previous create/improve already wrote down. collectPriorReflection() reads
// the prior runs for a scene and distills a seed reflection so the next loop
// *continues* the trial-and-error instead of restarting it.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sceneRunsDir } from './paths.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

type RunDir = { full: string; name: string; mtime: number };

// Run dirs for scene <id>: all of a scene's runs live under runs/<id>/ as
// "<type>-<stamp>" subdirs. Returned newest-first by mtime.
function priorRunDirs(id: string): RunDir[] {
  const base = sceneRunsDir(id);
  if (!existsSync(base)) return [];
  const dirs: RunDir[] = [];
  for (const name of readdirSync(base)) {
    const full = path.join(base, name);
    try {
      if (statSync(full).isDirectory()) dirs.push({ full, name, mtime: statSync(full).mtimeMs });
    } catch { /* skip */ }
  }
  return dirs.sort((a, b) => b.mtime - a.mtime);
}

// Returns a seed reflection object (or null if there's no prior history):
//   { source, mode, prior_remaining_gaps: [...], notes: [...] }
// Shaped to drop straight into the loop's "Carried-over reflection" block.
export type PriorReflection = {
  source: string;
  mode?: string;
  prior_remaining_gaps: string[];
  notes: string[];
};

// The most recent visual rubric score (0-100) for a scene, read from the
// newest improve run's last-review.json. Null if the scene has never been
// improved. Used by `refine` to threshold the visual axis of the loop.
export function latestVisualScore(id: string): number | null {
  for (const { full } of priorRunDirs(id)) {
    const review = readJson(path.join(full, 'last-review.json'));
    const total = review ? Number(review.total) : NaN;
    if (Number.isFinite(total)) return total;
  }
  return null;
}

export function collectPriorReflection(id: string): PriorReflection | null {
  const dirs = priorRunDirs(id);
  if (!dirs.length) return null;

  const gaps: string[] = [];
  const notes: string[] = [];
  let mode: string | undefined;
  const sources: string[] = [];

  for (const { full, name } of dirs) {
    // Latest review from a prior improve run → its unfinished gaps.
    const review = readJson(path.join(full, 'last-review.json'));
    if (review) {
      sources.push(name);
      if (review.critique) notes.push(`prev critique: ${String(review.critique).slice(0, 400)}`);
      for (const g of review.remaining_gaps || []) {
        if (gaps.length < 12 && !gaps.includes(g)) gaps.push(g);
      }
    }
    // Create run meta → mode + generation context.
    const meta = readJson(path.join(full, 'meta.json'));
    if (meta) {
      sources.push(name);
      if (!mode && meta.mode) mode = meta.mode;
      if (meta.meshParts != null && meta.parts != null) {
        notes.push(`generated as mode=${meta.mode}, ${meta.parts} parts (${meta.meshParts} mesh).`);
      }
    }
    // Cap how far back we look so the seed stays focused.
    if (sources.length >= 4) break;
  }

  if (!gaps.length && !notes.length) return null;
  return {
    source: [...new Set(sources)].slice(0, 4).join(', '),
    mode: mode || undefined,
    prior_remaining_gaps: gaps,
    notes: [...new Set(notes)].slice(0, 6),
  };
}
