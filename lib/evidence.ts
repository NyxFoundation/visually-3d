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
  resolveScene, sceneIdFromPath, evidenceDir, packagedExampleDir,
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

export const EvidenceIndexSchema = z.object({
  id: z.string(),
  fetchedAt: z.string().optional(),
  sources: z.array(z.object({ title: z.string().optional(), url: z.string().optional() }).loose()).optional(),
  items: z.array(EvidenceItemSchema).optional(),
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

// Read a scene's evidence: the workspace store wins (it is the freshest, fetched
// copy); otherwise fall back to the package's checked-in example seed.
export function loadEvidence(id: string): LoadedEvidence {
  for (const [origin, dir] of [
    ['workspace', evidenceDir(id)] as const,
    ['examples', packagedExampleDir(id)] as const,
  ]) {
    const paper = readIfExists(path.join(dir, 'paper.md'), PAPER_CAP);
    const notes = readIfExists(path.join(dir, 'notes.md'), NOTES_CAP);
    if (paper || notes) return { id, paper, notes, origin };
  }
  return { id, paper: null, notes: null, origin: 'none' };
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

// True when a reproduce report still shows SOURCE-DEPENDENT gaps — missing
// fields or fidelity mismatches that only the real paper/datasheet can resolve
// (as opposed to a self-check counterexample, which amend can fix from the
// findings alone). This is the signal refine uses to decide, autonomously, that
// gathering source evidence is worth it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function hasSourceGaps(report: any): boolean {
  if (!report || typeof report !== 'object') return false;
  const missing = Array.isArray(report.missing_fields) ? report.missing_fields.length : 0;
  const fr = report.fidelity_report || {};
  const paramMiss = Array.isArray(fr.parameter_fidelity)
    ? fr.parameter_fidelity.filter((p: { match?: unknown }) => p?.match === false).length : 0;
  const propBad = Array.isArray(fr.property_checks)
    ? fr.property_checks.filter((p: { status?: unknown }) => p?.status && p.status !== 'satisfied').length : 0;
  const struct = Array.isArray(fr.structural_findings) ? fr.structural_findings.length : 0;
  return missing + paramMiss + propBad + struct > 0;
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
export function buildEvidencePrompt(scene: any, sources: SourceRef[], opts: { refs: boolean }): string {
  const subject = scene?.machine_name || scene?.metadata?.info?.english_name || 'the system';
  const domain = scene?.metadata?.domain ? ` (domain: ${scene.metadata.domain})` : '';
  const summary = typeof scene?.metadata?.info?.summary === 'string'
    ? scene.metadata.info.summary.slice(0, 800) : '';
  const sourceList = sources.length
    ? sources.map((s, i) => `${i + 1}. ${s.title ? `${s.title} — ` : ''}${s.url ?? '(no url)'}`).join('\n')
    : '(no sources listed in the scene)';

  const refsBlock = opts.refs ? `

ALSO, search for REFERENCE IMPLEMENTATIONS (e.g. on GitHub) of "${subject}". For
each promising repository:
- give the repo URL and the file/function that is relevant;
- summarize ONLY the algorithmic/architectural choices it makes for the pieces
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
${sourceList}

Do this:
1. Fetch each source URL. If a URL is a PDF, fetch and read it. If a source is
   paywalled or unreachable, try an open mirror (arXiv / eprint / the project
   site) found via search; if still unavailable, record that explicitly.
2. TRANSCRIBE — do not summarize away — the technical sections that PIN DOWN the
   system, especially the parts a short abstract omits:
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
text is saved verbatim as the evidence file.`;
}

// ── arg parsing ──────────────────────────────────────────────────────────────
interface EvidenceOpts { positional: string[]; model?: string; refs: boolean }

function parseArgs(argv: string[]): EvidenceOpts {
  const opts: EvidenceOpts = { positional: [], refs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opts.model = argv[++i];
    else if (a === '--refs') opts.refs = true;
    else if (a === '--no-refs') opts.refs = false;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// CLI entry: fetch the scene's sources via the web-enabled runner and cache the
// transcription under the workspace evidence store.
export async function gatherEvidence(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) {
    throw new Error('usage: visually evidence <scene> [--refs] [--model <m>]');
  }
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene: any = JSON.parse(readFileSync(target, 'utf8'));
  const sources = sceneSources(scene);

  console.log(`visually evidence: ${id} — gathering source evidence (web tools enabled)`);
  if (!sources.length) {
    console.log('  ⚠ this scene lists no sources (metadata.info.sources / metadata.reference).');
    console.log('    add a paper/datasheet URL to the scene first, then re-run.');
    return;
  }
  console.log(`  sources: ${sources.length}${opts.refs ? '  · also searching for reference implementations' : ''}`);
  for (const s of sources) console.log(`    · ${s.title ? `${s.title} — ` : ''}${s.url ?? ''}`);

  ensureWorkspace();
  const dir = evidenceDir(id);
  mkdirSync(dir, { recursive: true });
  const logDir = makeRunDir(id, 'evidence', stamp());
  mkdirSync(logDir, { recursive: true });

  const prompt = buildEvidencePrompt(scene, sources, { refs: opts.refs });
  writeFileSync(path.join(logDir, 'prompt.txt'), prompt);

  console.log('  fetching + transcribing (this can take a few minutes)…');
  const { text } = await runClaudeStreaming({
    prompt,
    model: opts.model,
    runDir: logDir,
    quiet: true,
    tools: ['WebFetch', 'WebSearch'],
  });
  writeFileSync(path.join(logDir, 'raw.md'), text);

  const md = text.trim();
  if (!md || md.length < 80) {
    console.log(`  ⚠ no usable evidence returned (${md.length} chars) — see ${logDir}`);
    return;
  }
  const paperFile = path.join(dir, 'paper.md');
  writeFileSync(paperFile, md + '\n');
  // Validate the index at the write boundary too, so a malformed shape can never
  // be persisted (and the loose() index-signature type is satisfied by parse).
  const index = EvidenceIndexSchema.parse({
    id,
    fetchedAt: new Date().toISOString(),
    sources,
    items: [{ kind: 'paper', file: 'paper.md' }],
  });
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

  console.log(`  ✓ evidence cached → ${paperFile} (${md.length} chars)`);
  console.log('  re-run `visually amend` / `visually refine` — amend can now QUOTE the source.');
}

// List the evidence files present for a scene (used by tests / inspection).
export function evidenceFiles(id: string): string[] {
  const dir = evidenceDir(id);
  try { return readdirSync(dir).sort(); } catch { return []; }
}
