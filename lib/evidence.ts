// Source evidence — gather GROUND-TRUTH for a scene and cache it as Markdown, so
// the loop can stop guessing the parts a summary can't pin down. There is NO
// standalone command: `refine` invokes `gatherEvidence()` autonomously, mid-loop,
// the first time it stalls below the reproducibility goal on source-dependent
// gaps (see lib/refine.ts).
//
// Why this exists: `reproduce` measures whether the SPEC alone is enough to
// rebuild a system; when it isn't, `amend` writes the missing facts back. But a
// scene only carries a paper URL + a short summary, so the paper's *signature*
// structures (e.g. a conflict-free memory map, an addressing function, an FSM)
// are simply absent — no number of rounds can invent them, and `amend` correctly
// tags them `[source-missing]`. This step fetches the real source (the paper,
// optionally corroborating reference implementations), transcribes the technical
// sections to Markdown, and caches them. `amend` then QUOTES that evidence to
// pin the SPECIFIC system's values, lifting both reproducibility and fidelity.
//
// CRITICAL invariant: evidence flows into `amend` ONLY, never into reproduce's
// reverse-implementers. reproduce must keep measuring "rebuild from the SPEC
// alone"; handing the engineers the paper would measure paper-completeness
// instead. Evidence enriches the spec; reproduce then grades the richer spec.
//
// Tooling: unlike the tool-less core loop, gathering opts INTO web access
// (WebFetch/WebSearch) via the runner's `tools` option.

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  resolveScene, evidenceDir, packagedExampleDir,
  runDir as makeRunDir, ensureWorkspace,
} from './paths.js';
import { runClaudeStreaming } from './runner.js';

// ── on-disk index (zod boundary) ─────────────────────────────────────────────
const EvidenceItemSchema = z.object({
  kind: z.enum(['paper', 'ref-impl', 'notes']),
  title: z.string().optional(),
  url: z.string().optional(),
  file: z.string(),
}).loose();

// One autonomous gathering attempt — the policy's persistent memory. Lets a
// later round (or a later `refine` run) ESCALATE (paper → refs) instead of
// re-fetching the same source, and stop once every method is exhausted.
const EvidenceAttemptSchema = z.object({
  method: z.enum(['paper', 'refs']),
  at: z.string(),
  gaps: z.array(z.string()).optional(),
  bytes: z.number().optional(),
}).loose();

export const EvidenceIndexSchema = z.object({
  id: z.string(),
  fetchedAt: z.string().optional(),
  sources: z.array(z.object({ title: z.string().optional(), url: z.string().optional() }).loose()).optional(),
  items: z.array(EvidenceItemSchema).optional(),
  attempts: z.array(EvidenceAttemptSchema).optional(),
}).loose();

export type EvidenceIndex = z.infer<typeof EvidenceIndexSchema>;

export interface LoadedEvidence {
  id: string;
  // The transcribed source (paper) Markdown, if any.
  paper: string | null;
  // Curated, hand-written learnings shipped with an example (honest about gaps).
  notes: string | null;
  // Where it came from: the user's workspace (fetched), the package examples
  // (seed), or nothing at all.
  origin: 'workspace' | 'examples' | 'none';
}

const PAPER_CAP = 24000; // chars kept from a fetched paper for prompt injection
const NOTES_CAP = 8000;

function readIfExists(file: string, cap: number): string | null {
  try {
    if (!existsSync(file)) return null;
    const s = readFileSync(file, 'utf8').trim();
    return s ? s.slice(0, cap) : null;
  } catch {
    return null;
  }
}

// Read a scene's accumulated evidence. The workspace store holds the fetched,
// growing transcription (paper.md is appended to, never overwritten); the
// package example ships a curated notes.md seed. We MERGE them: the workspace
// paper wins for the transcription, but the curated notes are always carried
// (a fetch must never drop the hand-distilled learnings). origin reflects the
// strongest source present so callers can tell fetched from seed-only.
export function loadEvidence(id: string): LoadedEvidence {
  const ws = evidenceDir(id);
  const ex = packagedExampleDir(id);
  const paper = readIfExists(path.join(ws, 'paper.md'), PAPER_CAP)
    ?? readIfExists(path.join(ex, 'paper.md'), PAPER_CAP);
  const notes = readIfExists(path.join(ws, 'notes.md'), NOTES_CAP)
    ?? readIfExists(path.join(ex, 'notes.md'), NOTES_CAP);
  const origin: LoadedEvidence['origin'] =
    existsSync(path.join(ws, 'paper.md')) ? 'workspace'
      : (paper || notes) ? 'examples'
        : 'none';
  if (origin === 'none') return { id, paper: null, notes: null, origin };
  return { id, paper, notes, origin };
}

export function hasEvidence(id: string): boolean {
  return loadEvidence(id).origin !== 'none';
}

// Assemble the bounded evidence block injected into the amend prompt. Returns ''
// when there is nothing, so callers can cheaply test presence.
export function evidenceExcerpt(ev: LoadedEvidence, limit = 18000): string {
  if (ev.origin === 'none') return '';
  const parts: string[] = [];
  if (ev.notes) parts.push(`# Curated learnings (honest about what is settled vs missing)\n${ev.notes}`);
  if (ev.paper) parts.push(`# Transcribed source\n${ev.paper}`);
  return parts.join('\n\n').slice(0, limit);
}

// A smaller, architecture-framed excerpt used to GROUND the 3D-improvement pass
// in the real source, so the visualization depicts the actual modules / memory /
// datapath / control instead of a guess. '' when there is no evidence.
export function sourceGrounding(ev: LoadedEvidence, limit = 4000): string {
  return evidenceExcerpt(ev, limit);
}

// ── source extraction from a scene ───────────────────────────────────────────
export interface SourceRef { title?: string; url?: string }

// Pull the citable sources out of a scene's metadata (info.sources[] + the
// top-level reference). Defensive: metadata is a loose record.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sceneSources(scene: any): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  const push = (title: unknown, url: unknown): void => {
    const t = typeof title === 'string' ? title : undefined;
    const u = typeof url === 'string' ? url : undefined;
    const key = `${t ?? ''}|${u ?? ''}`;
    if ((!t && !u) || seen.has(key)) return;
    seen.add(key);
    out.push({ title: t, url: u });
  };
  const info = scene?.metadata?.info ?? {};
  const list = Array.isArray(info.sources) ? info.sources : [];
  for (const s of list) push(s?.title, s?.url);
  const ref = scene?.metadata?.reference;
  if (typeof ref === 'string') push(undefined, ref);
  else if (ref && typeof ref === 'object') push(ref.title, ref.url);
  return out;
}

// ── the gathering prompt ─────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildEvidencePrompt(scene: any, sources: SourceRef[], opts: { refs: boolean; openGaps?: string[] }): string {
  const subject = scene?.machine_name || scene?.metadata?.info?.english_name || 'the system';
  const domain = scene?.metadata?.domain ? ` (domain: ${scene.metadata.domain})` : '';
  const summary = typeof scene?.metadata?.info?.summary === 'string'
    ? scene.metadata.info.summary.slice(0, 800) : '';
  const sourceList = sources.length
    ? sources.map((s, i) => `${i + 1}. ${s.title ? `${s.title} — ` : ''}${s.url ?? '(no url)'}`).join('\n')
    : '(no sources listed in the scene)';

  // Gap-targeted: tell the gatherer EXACTLY which open facts to hunt for, so each
  // fetch accumulates the missing pieces instead of re-transcribing the abstract.
  const gaps = (opts.openGaps || []).filter(Boolean).slice(0, 16);
  const gapBlock = gaps.length ? `

PRIORITY — the downstream loop is specifically blocked on these facts. Hunt for
each one and, if found, transcribe it precisely; if the source genuinely does not
state it, say so per item:
${gaps.map((g) => `- ${g}`).join('\n')}` : '';

  const refsBlock = opts.refs ? `

ALSO, search for REFERENCE IMPLEMENTATIONS (e.g. on GitHub) of "${subject}". For
each promising repository:
- give the repo URL and the file/function that is relevant;
- CAPTURE THE KEY SOURCE FILES VERBATIM in fenced code blocks, each headed by a
  comment line \`// file: <repo-relative path>\`, so the REAL code (RTL/model) is
  preserved as ground truth — not only described. Prefer the modules that realize
  the architecture (memory mapping, address/twiddle generators, FSM, butterfly /
  reducer datapath, top-level wiring);
- summarize the algorithmic/architectural choices these files make for the pieces
  the paper leaves implicit (memory mapping, addressing, scheduling, FSM, exact
  butterfly/datapath equations, parameter values);
- mark these clearly as SECONDARY. A reference implementation may DIFFER from the
  paper; never present its choices as the paper's. Tag every such fact
  \`[ref-impl:<repo-url>]\`.` : '';

  return `You are gathering GROUND-TRUTH evidence about a specific engineered system so a
downstream tool can pin its real parameters and structures. Use your web tools
(WebFetch on each source URL; WebSearch when a URL is not enough). Then write a
faithful Markdown transcription.

SUBJECT: ${subject}${domain}
${summary ? `\nScene summary (for context only — do NOT just repeat it):\n${summary}\n` : ''}
SOURCES to fetch (the authoritative paper/datasheet for this system):
${sourceList}${gapBlock}

Do this:
1. Fetch each source URL. If a URL is a PDF, fetch and read it. If a source is
   paywalled or unreachable, try an open mirror (arXiv / eprint / the project
   site) found via search; if still unavailable, record that explicitly.
2. TRANSCRIBE — do not summarize away — the technical sections that PIN DOWN the
   system, especially the parts a short abstract omits and the PRIORITY gaps:
   - exact parameters (sizes, moduli, bit-widths, counts, constants);
   - datapath / core equations (e.g. butterfly, reduction, the actual formulas);
   - memory organization and any addressing / bank / mapping functions;
   - control: scheduling, loop structure, FSM states & transitions, pipeline;
   - I/O ordering and interface;
   - any QUANTIFIED claims (resource/area/timing/throughput) with their basis.
3. Tag every transcribed fact with its origin section, e.g.
   \`[paper:Sec III.B]\`, so the downstream tool can cite it.
4. NEVER invent. If the source does not state something, write it under a
   "## Not stated in the source" list rather than guessing a plausible value.${refsBlock}

OUTPUT: a SINGLE Markdown document and nothing else (no preamble, no closing
remarks). Start with "# Evidence: ${subject}". Use clear section headings. This
text is saved verbatim and APPENDED to any evidence already gathered.`;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Read the workspace index (the policy's persistent memory). null if none yet.
export function readIndex(id: string): EvidenceIndex | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(evidenceDir(id), 'index.json'), 'utf8'));
    return EvidenceIndexSchema.parse(raw);
  } catch {
    return null;
  }
}

export type EvidenceMethod = 'paper' | 'refs';

// Run ONE gathering pass and ACCUMULATE it: append the transcription to paper.md
// (never overwrite) and record the attempt in index.json so the policy can
// escalate next time. Returns how many chars were added (0 = nothing usable).
export async function gatherEvidence(
  id: string,
  opts: { method: EvidenceMethod; openGaps?: string[]; refs?: boolean; model?: string },
): Promise<{ added: number; method: EvidenceMethod; methodsDone: EvidenceMethod[] }> {
  const target = resolveScene(id);
  if (!target) throw new Error(`no such scene: ${id}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene: any = JSON.parse(readFileSync(target, 'utf8'));
  const sources = sceneSources(scene);
  const doRefs = opts.method === 'refs' || !!opts.refs;

  ensureWorkspace();
  const dir = evidenceDir(id);
  mkdirSync(dir, { recursive: true });
  const logDir = makeRunDir(id, 'evidence', stamp());
  mkdirSync(logDir, { recursive: true });

  const prompt = buildEvidencePrompt(scene, sources, { refs: doRefs, openGaps: opts.openGaps });
  writeFileSync(path.join(logDir, 'prompt.txt'), prompt);
  const { text } = await runClaudeStreaming({
    prompt, model: opts.model, runDir: logDir, quiet: true, tools: ['WebFetch', 'WebSearch'],
  });
  writeFileSync(path.join(logDir, 'raw.md'), text);

  const md = text.trim();
  // What this pass consumed off the escalation ladder (so a paper+refs pass marks
  // both, and the ladder doesn't re-run refs separately).
  const methodsDone: EvidenceMethod[] = opts.method === 'refs' ? ['refs'] : (doRefs ? ['paper', 'refs'] : ['paper']);
  if (!md || md.length < 80) {
    // Still record the attempt so we don't spin on a dead source every round.
    persistAttempt(id, dir, sources, methodsDone, opts.openGaps, 0);
    return { added: 0, method: opts.method, methodsDone };
  }
  const paperFile = path.join(dir, 'paper.md');
  const prior = existsSync(paperFile) ? readFileSync(paperFile, 'utf8') : '';
  // Accumulate: a separator header keeps each pass attributable; never overwrite.
  const header = `## Evidence gathered ${stamp()} (method: ${methodsDone.join('+')}${(opts.openGaps || []).length ? `; targeting ${opts.openGaps?.length} gap(s)` : ''})\n\n`;
  const body = prior
    ? `${prior.replace(/\s+$/, '')}\n\n---\n\n${header}${md}\n`
    : `${md}\n`;
  writeFileSync(paperFile, body);
  persistAttempt(id, dir, sources, methodsDone, opts.openGaps, md.length);
  return { added: md.length, method: opts.method, methodsDone };
}

function persistAttempt(
  id: string, dir: string, sources: SourceRef[],
  methods: EvidenceMethod[], gaps: string[] | undefined, bytes: number,
): void {
  const prev = readIndex(id);
  const at = new Date().toISOString();
  const attempts = [...(prev?.attempts || []), ...methods.map((m) => ({ method: m, at, gaps: gaps?.slice(0, 16), bytes }))];
  const items = [...(prev?.items || [])];
  if (!items.some((it) => it.file === 'paper.md')) items.push({ kind: 'paper', file: 'paper.md' });
  const index = EvidenceIndexSchema.parse({ id, fetchedAt: at, sources, items, attempts });
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
}

// List the evidence files present for a scene (used by tests / inspection).
export function evidenceFiles(id: string): string[] {
  const dir = evidenceDir(id);
  try { return readdirSync(dir).sort(); } catch { return []; }
}
