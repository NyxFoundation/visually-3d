// Unified scene revision timeline (read-only, derive-on-read).
//
// Instead of grouping run history by command, we flatten every scene snapshot
// across all runs into one chronological version chain — create's scene.json is
// v0, each improve iteration's iter-NN.json is the next version — and pin
// reproduce runs onto the same timeline as verification markers. A revision's
// detail pairs the LLM's reasoning (the critique that drove the change) with
// the structural diff of the scene descriptor (what actually changed), the way
// a git commit shows message + diff.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveRunsDir } from './paths.js';
import { splitRunId, stampToIso, readJson, verifyPass } from './runs.js';
import type {
  FieldChange, FrameDetail, PartChange, PartRef, RevisionEntry,
  RunImplHighlight, StructuralDiff, TimelineEntry, VerificationEntry,
} from './types.js';

type RawRun = { runId: string; type: string; stamp: string; dir: string; files: string[] };

type RevNode = {
  key: string;
  runId: string;
  dir: string;
  stamp: string;
  iter: number;
  source: RevisionEntry['source'];
  sceneFile: string;
  render: string | null;
  reviewFile: string | null;
  traceFile: string | null;
  sortKey: string;
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function scanRuns(id: string): RawRun[] {
  const base = resolveRunsDir(id);
  if (!existsSync(base)) return [];
  const out: RawRun[] = [];
  for (const name of readdirSync(base)) {
    const dir = path.join(base, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { /* empty */ }
    out.push({ runId: name, ...splitRunId(name), dir, files });
  }
  return out;
}

// Flatten create + improve runs into the ordered version chain.
function buildRevisions(runs: RawRun[]): RevNode[] {
  const byStamp = (a: RawRun, b: RawRun) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0);
  const creates = runs.filter((r) => r.type === 'create').sort(byStamp);
  const improves = runs.filter((r) => r.type === 'improve').sort(byStamp);
  const nodes: RevNode[] = [];

  for (const c of creates) {
    const sceneFile = c.files.includes('scene.json') ? 'scene.json'
      : c.files.includes('scene.invalid.json') ? 'scene.invalid.json' : null;
    if (!sceneFile) continue;
    nodes.push({
      key: `${c.runId}:0`, runId: c.runId, dir: c.dir, stamp: c.stamp, iter: 0,
      source: 'created', sceneFile, render: null, reviewFile: null,
      traceFile: c.files.includes('reasoning.log') ? 'reasoning.log' : c.files.includes('raw.txt') ? 'raw.txt' : null,
      sortKey: `${c.stamp}#000`,
    });
  }

  for (const r of improves) {
    const iters = [...new Set(
      r.files.map((f) => { const m = /^iter-(\d+)\.json$/.exec(f); return m ? Number(m[1]) : null; })
        .filter((n): n is number => n != null && n > 0),
    )].sort((a, b) => a - b);
    for (const n of iters) {
      const pad = String(n).padStart(2, '0');
      nodes.push({
        key: `${r.runId}:${n}`, runId: r.runId, dir: r.dir, stamp: r.stamp, iter: n,
        source: 'refined',
        sceneFile: `iter-${pad}.json`,
        render: r.files.includes(`iter-${pad}-render.png`) ? `iter-${pad}-render.png` : null,
        reviewFile: r.files.includes(`iter-${pad}-review.json`) ? `iter-${pad}-review.json` : null,
        traceFile: r.files.includes(`iter-${pad}-events.jsonl`) ? `iter-${pad}-events.jsonl` : null,
        sortKey: `${r.stamp}#${pad.padStart(3, '0')}`,
      });
    }
  }

  nodes.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  // No create v0 but improves exist → synthesize a baseline v0 from the earliest
  // improve run's iter-00.json so v1 has a predecessor to diff against.
  if (!nodes.some((n) => n.iter === 0) && improves.length && improves[0].files.includes('iter-00.json')) {
    const f = improves[0];
    nodes.unshift({
      key: `${f.runId}:0`, runId: f.runId, dir: f.dir, stamp: f.stamp, iter: 0,
      source: 'baseline', sceneFile: 'iter-00.json', render: null, reviewFile: null, traceFile: null,
      sortKey: `${f.stamp}#000`,
    });
  }

  return nodes;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function partsById(scene: any): Map<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = new Map<string, any>();
  const parts = Array.isArray(scene?.parts) ? scene.parts : [];
  for (const p of parts) if (p && p.id != null) m.set(String(p.id), p);
  return m;
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function structuralDiff(oldS: any, newS: any, initial: boolean): StructuralDiff {
  const o = partsById(oldS);
  const n = partsById(newS);
  const added: PartRef[] = [];
  const removed: PartRef[] = [];
  const changed: PartChange[] = [];

  for (const [id, p] of n) if (!o.has(id)) added.push({ id, name: p.name, shape: p.shape });
  for (const [id, p] of o) if (!n.has(id)) removed.push({ id, name: p.name, shape: p.shape });
  for (const [id, np] of n) {
    const op = o.get(id);
    if (!op) continue;
    const fields: FieldChange[] = [];
    for (const f of new Set([...Object.keys(op), ...Object.keys(np)])) {
      if (f === 'id') continue;
      if (!deepEq(op[f], np[f])) fields.push({ field: f, before: op[f], after: np[f] });
    }
    if (fields.length) changed.push({ id, name: np.name, fields });
  }

  const meta: FieldChange[] = [];
  for (const f of ['machine_name', 'assembly_instructions']) {
    if (!deepEq(oldS?.[f], newS?.[f])) meta.push({ field: f, before: oldS?.[f], after: newS?.[f] });
  }
  return { initial, added, removed, changed, meta };
}

// Compact LCS-based unified line diff (context + '-'/'+' lines). Capped so a
// pathological scene can't blow up the O(n·m) table.
function unifiedDiff(a: string, b: string): string {
  const aL = a.length ? a.split('\n') : [];
  const bL = b.length ? b.split('\n') : [];
  if (aL.length > 1500 || bL.length > 1500) return '(diff too large to render)';
  const m = aL.length;
  const k = bL.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) {
      dp[i][j] = aL[i] === bL[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < k) {
    if (aL[i] === bL[j]) { out.push(`  ${aL[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`- ${aL[i]}`); i++; }
    else { out.push(`+ ${bL[j]}`); j++; }
  }
  while (i < m) out.push(`- ${aL[i++]}`);
  while (j < k) out.push(`+ ${bL[j++]}`);
  return out.join('\n');
}

function verificationFor(r: RawRun): VerificationEntry {
  const report = (r.files.includes('report.json') ? readJson(path.join(r.dir, 'report.json')) : null) as
    { reproducibility?: unknown; verdict?: unknown; executable_verification?: { passed?: unknown; total?: unknown; enabled?: unknown } } | null;
  const impls: RunImplHighlight[] = [];
  for (const f of r.files.slice().sort()) {
    const m = /^impl-(\d+)\.(py|v)$/.exec(f);
    if (!m) continue;
    const n = Number(m[1]);
    const verifyFile = r.files.includes(`impl-${n}-verify.txt`) ? `impl-${n}-verify.txt` : undefined;
    impls.push({
      n, lang: m[2] === 'py' ? 'python' : 'verilog',
      pass: verifyFile ? verifyPass(r.dir, verifyFile) : null,
      codeFile: f, verifyFile,
      logFile: r.files.includes(`impl-${n}.txt`) ? `impl-${n}.txt` : undefined,
    });
  }
  const ev = report?.executable_verification;
  return {
    kind: 'verification',
    key: `${r.runId}:v`,
    runId: r.runId,
    startedAt: stampToIso(r.stamp),
    reproducibility: num(report?.reproducibility),
    verdict: typeof report?.verdict === 'string' ? report.verdict : undefined,
    verify: ev?.enabled ? { passed: Number(ev.passed) || 0, total: Number(ev.total) || 0 } : undefined,
    impls,
  };
}

// The full chronological timeline (oldest → newest): numbered revisions
// interleaved with verification markers.
export function listTimeline(id: string): TimelineEntry[] {
  const runs = scanRuns(id);
  const nodes = buildRevisions(runs);
  const scores = nodes.map((nd) => (nd.reviewFile ? num((readJson(path.join(nd.dir, nd.reviewFile)) as { total?: unknown } | null)?.total) : null));

  const items: { sortKey: string; entry: TimelineEntry }[] = [];
  nodes.forEach((nd, idx) => {
    items.push({
      sortKey: nd.sortKey,
      entry: {
        kind: 'revision',
        key: nd.key, runId: nd.runId, startedAt: stampToIso(nd.stamp),
        version: idx, source: nd.source, iter: nd.iter,
        score: scores[idx],
        delta: idx > 0 && scores[idx] != null && scores[idx - 1] != null ? (scores[idx]! - scores[idx - 1]!) : null,
        scene: { runId: nd.runId, file: nd.sceneFile },
        render: nd.render ? { runId: nd.runId, file: nd.render } : null,
        hasReasoning: !!nd.reviewFile,
      },
    });
  });
  for (const r of runs.filter((x) => x.type === 'reproduce')) {
    items.push({ sortKey: `${r.stamp}#999`, entry: verificationFor(r) });
  }

  items.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  return items.map((it) => it.entry);
}

const pretty = (s: unknown) => JSON.stringify(s ?? {}, null, 2);

// A revision frame: REASONING = the iter's critique; CHANGES = the descriptor
// diff (which is what moved the 3D / screenshot).
function revisionDetail(id: string, key: string): FrameDetail | null {
  const nodes = buildRevisions(scanRuns(id));
  const idx = nodes.findIndex((n) => n.key === key);
  if (idx === -1) return null;
  const node = nodes[idx];
  const prev = idx > 0 ? nodes[idx - 1] : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const thisScene = readJson(path.join(node.dir, node.sceneFile)) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prevScene = prev ? readJson(path.join(prev.dir, prev.sceneFile)) as any : null;

  const rawDiff = prev
    ? unifiedDiff(pretty(prevScene), pretty(thisScene))
    : pretty(thisScene).split('\n').map((l) => `+ ${l}`).join('\n');

  const review = node.reviewFile ? (readJson(path.join(node.dir, node.reviewFile)) as
    { critique?: unknown; remaining_gaps?: unknown; verdict?: unknown; total?: unknown } | null) : null;
  const score = num(review?.total);
  const prevScore = prev?.reviewFile ? num((readJson(path.join(prev.dir, prev.reviewFile)) as { total?: unknown } | null)?.total) : null;

  return {
    kind: 'revision',
    key: node.key,
    version: idx,
    startedAt: stampToIso(node.stamp),
    label: node.source,
    score,
    delta: score != null && prevScore != null ? score - prevScore : null,
    reasoning: {
      text: typeof review?.critique === 'string' ? review.critique : undefined,
      gaps: Array.isArray(review?.remaining_gaps) ? review.remaining_gaps.map(String) : undefined,
      verdict: typeof review?.verdict === 'string' ? review.verdict : undefined,
    },
    changeKind: 'scene',
    structural: structuralDiff(prevScene ?? {}, thisScene ?? {}, !prev),
    rawDiff,
  };
}

function bestImplOf(r: RawRun): { file: string; lang: string } | null {
  const impls = verificationFor(r).impls;
  const im = impls.find((i) => i.pass === true) ?? impls[0];
  return im ? { file: im.codeFile, lang: im.lang } : null;
}

function readText(dir: string, file: string): string {
  try { return readFileSync(path.join(dir, file), 'utf8'); } catch { return ''; }
}

// A verification frame: REASONING = the judge's summary + verdict + the missing
// fields it found; CHANGES = the diff of this run's best implementation against
// the previous verification's (the impl is what moved here).
function verificationDetail(id: string, key: string): FrameDetail | null {
  const runId = key.slice(0, key.length - 2); // strip ":v"
  const runs = scanRuns(id).filter((r) => r.type === 'reproduce').sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
  const idx = runs.findIndex((r) => r.runId === runId);
  if (idx === -1) return null;
  const r = runs[idx];
  const v = verificationFor(r);

  const best = bestImplOf(r);
  const code = best ? readText(r.dir, best.file) : '';
  const prev = idx > 0 ? runs[idx - 1] : null;
  const prevBest = prev ? bestImplOf(prev) : null;
  const prevCode = prev && prevBest ? readText(prev.dir, prevBest.file) : '';
  const rawDiff = prev
    ? unifiedDiff(prevCode, code)
    : code.split('\n').map((l) => `+ ${l}`).join('\n');

  const report = (r.files.includes('report.json') ? readJson(path.join(r.dir, 'report.json')) : null) as
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { summary?: unknown; missing_fields?: any[] } | null;
  const gaps = Array.isArray(report?.missing_fields)
    ? report.missing_fields.slice(0, 12).map((m) => (m && typeof m === 'object' ? `${m.kind ? `[${m.kind}] ` : ''}${m.item ?? ''}`.trim() : String(m)))
    : undefined;

  return {
    kind: 'verification',
    key,
    version: null,
    startedAt: stampToIso(r.stamp),
    label: 'verification',
    score: v.reproducibility,
    delta: null,
    reasoning: { text: typeof report?.summary === 'string' ? report.summary : undefined, gaps, verdict: v.verdict },
    changeKind: 'impl',
    structural: null,
    rawDiff,
    lang: best?.lang,
  };
}

export function getFrameDetail(id: string, key: string): FrameDetail | null {
  return key.endsWith(':v') ? verificationDetail(id, key) : revisionDetail(id, key);
}
