// Read-only index over the per-scene run tree runs/<id>/<type>-<stamp>/.
//
// Derive-on-read: nothing is written here and no manifest is required. We scan
// whatever files a run left on disk and normalize them into a stable shape, so
// the web never parses filenames and an interrupted (killed) run simply shows
// the artifacts it managed to produce. The producers (create/reproduce/
// self-improve.sh) keep their own file conventions; this layer maps them.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sceneRunsDir, runDir } from './paths.js';
import type { RunArtifact, RunDetail, RunIteration, RunSummary, RunType } from './types.js';

const KNOWN_TYPES: RunType[] = ['create', 'improve', 'reproduce'];

function splitRunId(runId: string): { type: RunType; stamp: string } {
  const i = runId.indexOf('-');
  const head = i === -1 ? runId : runId.slice(0, i);
  const type = (KNOWN_TYPES as string[]).includes(head) ? (head as RunType) : 'unknown';
  return { type, stamp: i === -1 ? '' : runId.slice(i + 1) };
}

// "YYYYMMDD-HHMMSS" → "YYYY-MM-DDTHH:MM:SS" (local, for display only).
function stampToIso(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return stamp;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function readJson(p: string): unknown {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Improve iterations, keyed by N, gathered from iter-NN-*.{png,json,jsonl}.
function improveIterations(dir: string, files: string[]): RunIteration[] {
  const byN = new Map<number, RunIteration>();
  const get = (n: number) => {
    let it = byN.get(n);
    if (!it) { it = { n }; byN.set(n, it); }
    return it;
  };
  for (const f of files) {
    let m: RegExpExecArray | null;
    if ((m = /^iter-(\d+)-render\.png$/.exec(f))) get(Number(m[1])).render = f;
    else if ((m = /^iter-(\d+)\.json$/.exec(f))) get(Number(m[1])).scene = f;
    else if ((m = /^iter-(\d+)-events\.jsonl$/.exec(f))) get(Number(m[1])).log = f;
    else if ((m = /^iter-(\d+)-review\.json$/.exec(f))) {
      const it = get(Number(m[1]));
      it.review = f;
      const review = readJson(path.join(dir, f)) as { total?: unknown } | null;
      const total = num(review?.total);
      if (total != null) it.score = total;
    }
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

function artifactsFor(type: RunType, dir: string, files: string[]): RunArtifact[] {
  const has = (f: string) => files.includes(f);
  const out: RunArtifact[] = [];
  const push = (kind: RunArtifact['kind'], label: string, file: string, iter?: number) => {
    if (has(file)) out.push({ kind, label, file, ...(iter != null ? { iter } : {}) });
  };

  if (type === 'create') {
    push('prompt', 'prompt', 'prompt.txt');
    push('log', 'reasoning (raw)', 'raw.txt');
    push('log', 'reasoning (codex)', 'reasoning.log');
    push('scene', 'scene', 'scene.json');
    push('scene', 'scene (invalid)', 'scene.invalid.json');
    push('report', 'meta', 'meta.json');
    return out;
  }

  if (type === 'reproduce') {
    push('scene', 'spec', 'spec.json');
    push('report', 'report', 'report.json');
    push('log', 'judge (raw)', 'report.raw.txt');
    for (const f of files.slice().sort()) {
      let m: RegExpExecArray | null;
      if ((m = /^impl-(\d+)\.(py|v)$/.exec(f))) out.push({ kind: 'impl', label: `impl ${m[1]} (${m[2]})`, file: f, iter: Number(m[1]) });
      else if ((m = /^impl-(\d+)-verify\.txt$/.exec(f))) out.push({ kind: 'verify', label: `impl ${m[1]} verify`, file: f, iter: Number(m[1]) });
      else if ((m = /^impl-(\d+)\.txt$/.exec(f))) out.push({ kind: 'log', label: `impl ${m[1]} reasoning`, file: f, iter: Number(m[1]) });
    }
    return out;
  }

  if (type === 'improve') {
    push('log', 'run log', 'run.log');
    push('review', 'final review', 'last-review.json');
    for (const it of improveIterations(dir, files)) {
      if (it.render) out.push({ kind: 'screenshot', label: `iter ${it.n} render`, file: it.render, iter: it.n });
      if (it.scene) out.push({ kind: 'scene', label: `iter ${it.n} scene`, file: it.scene, iter: it.n });
      if (it.log) out.push({ kind: 'log', label: `iter ${it.n} LLM log`, file: it.log, iter: it.n });
      if (it.review) out.push({ kind: 'review', label: `iter ${it.n} review`, file: it.review, iter: it.n });
    }
    return out;
  }

  for (const f of files) out.push({ kind: 'other', label: f, file: f });
  return out;
}

function statusFor(type: RunType, dir: string, files: string[], iters: RunIteration[]): RunSummary['status'] {
  if (type === 'create') return files.some((f) => f === 'scene.json' || f === 'scene.invalid.json' || f === 'meta.json') ? 'done' : 'interrupted';
  if (type === 'reproduce') return files.includes('report.json') ? 'done' : 'interrupted';
  if (type === 'improve') {
    try {
      if (files.includes('run.log') && readFileSync(path.join(dir, 'run.log'), 'utf8').includes('self-improve: done')) return 'done';
    } catch { /* fall through */ }
    return iters.length ? 'interrupted' : 'unknown';
  }
  return 'unknown';
}

function scoreFor(type: RunType, dir: string, files: string[], iters: RunIteration[]): number | null {
  if (type === 'reproduce' && files.includes('report.json')) {
    const report = readJson(path.join(dir, 'report.json')) as { reproducibility?: unknown } | null;
    return num(report?.reproducibility);
  }
  if (type === 'improve') {
    let best: number | null = null;
    for (const it of iters) if (it.score != null) best = best == null ? it.score : Math.max(best, it.score);
    if (best == null && files.includes('last-review.json')) {
      best = num((readJson(path.join(dir, 'last-review.json')) as { total?: unknown } | null)?.total);
    }
    return best;
  }
  return null;
}

function summarize(id: string, runId: string, dir: string): RunSummary {
  const { type, stamp } = splitRunId(runId);
  let files: string[] = [];
  let mtimeMs = 0;
  try { files = readdirSync(dir); } catch { /* empty */ }
  try { mtimeMs = statSync(dir).mtimeMs; } catch { /* 0 */ }
  const iters = type === 'improve' ? improveIterations(dir, files) : [];
  const iterations = type === 'improve'
    ? iters.length
    : type === 'reproduce'
      ? files.filter((f) => /^impl-\d+\.(py|v)$/.test(f)).length
      : 0;
  return {
    id, runId, type, stamp,
    startedAt: stampToIso(stamp),
    mtimeMs,
    status: statusFor(type, dir, files, iters),
    score: scoreFor(type, dir, files, iters),
    iterations,
  };
}

// All runs for a scene, newest first.
export function listRunsForScene(id: string): RunSummary[] {
  const base = sceneRunsDir(id);
  if (!existsSync(base)) return [];
  const out: RunSummary[] = [];
  for (const name of readdirSync(base)) {
    const dir = path.join(base, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    out.push(summarize(id, name, dir));
  }
  // Newest first. The stamp is the run's canonical start time and sorts
  // lexically; mtime (which changes as a run writes) is only a tie-breaker.
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : b.mtimeMs - a.mtimeMs));
}

export function getRunDetail(id: string, runId: string): RunDetail | null {
  const dir = runDir(id, splitRunId(runId).type, splitRunId(runId).stamp);
  // runDir() rebuilds "<type>-<stamp>"; for an 'unknown' type fall back to the raw name.
  const actual = existsSync(dir) ? dir : path.join(sceneRunsDir(id), runId);
  if (!existsSync(actual)) return null;
  const summary = summarize(id, runId, actual);
  let files: string[] = [];
  try { files = readdirSync(actual); } catch { /* empty */ }
  return {
    ...summary,
    iters: summary.type === 'improve' ? improveIterations(actual, files) : [],
    artifacts: artifactsFor(summary.type, actual, files),
  };
}

// Resolve an artifact's on-disk path, jailed to the run dir (no escaping via
// "..", absolute paths, or symlink-y names). Returns null if outside.
export function resolveArtifact(id: string, runId: string, relFile: string): string | null {
  if (!relFile || relFile.includes('\0')) return null;
  const base = path.join(sceneRunsDir(id), runId);
  const resolved = path.resolve(base, relFile);
  const baseResolved = path.resolve(base);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) return null;
  if (!existsSync(resolved)) return null;
  try { if (!statSync(resolved).isFile()) return null; } catch { return null; }
  return resolved;
}
