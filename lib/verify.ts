// `visually verify <scene>` — the VERIFY leg. Formally checks the REAL system
// using its gathered ground-truth SOURCE (the paper + reference code that
// `visualize` cached) as the reference, via the auto-selected backend (z3/SMT for
// circuits & algorithms, physics sim for machines).
//
// This is NOT reverse-implementation from the spec: the source exists, so we
// verify ITS properties directly. No source → error (run `visualize` first). One
// agent writes the self-checking program grounded in the source; the backend runs
// it (the two-tier z3 discipline lives in the backend's implementInstructions).

import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveScene, sceneIdFromPath, runDir as makeRunDir, ensureWorkspace } from './paths.js';
import { runClaudeStreaming } from './runner.js';
import { parseImpl } from './reproduce.js';
import { getBackend, selectBackend } from './backends/index.js';
import { loadEvidence, evidenceExcerpt, type LoadedEvidence } from './evidence.js';
import { saveImpl } from './impls.js';

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Relative paths of the cloned source files (excluding .git), so the prompt can
// list what the agent may Read.
function listSourceFiles(root: string, base = '', out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.git' || out.length >= 300) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) listSourceFiles(path.join(root, e.name), rel, out);
    else out.push(rel);
  }
  return out;
}

// Read a curated subset of the cloned source to INLINE in the prompt, so the
// agent can write the verification directly instead of burning its tool-turn /
// rate-limit budget on many serial Reads. Prioritise the files the proofs NEED
// (the conflict-free map, address generators, modular units, butterfly, twiddle,
// FSM, and the model golden) by name, then model code, then small modules — up to
// a byte budget; skip testbenches & data files.
const KEY_FILE_RE = /(conflict|memory_map|address|modular|_mul|_add|_sub|half|butterfly|compact_bf|\bpe\d|twiddle|tf_|fsm|poly|model|ntt)/i;
function inlineKeySources(root: string, files: string[], maxFiles = 14, maxBytes = 26000): { path: string; content: string }[] {
  const isSrc = (f: string) => /\.(py|v|sv|svh|vh)$/i.test(f) && !/(^|\/)(tb_|testbench|sim_)/i.test(f);
  const cand = files.filter(isSrc).map((f) => {
    let size = 0;
    try { size = statSync(path.join(root, f)).size; } catch { /* skip */ }
    // The conflict-free map (the headline theorem, both radices) comes first;
    // then other needed modules; then .py golden; then the rest.
    const base = path.basename(f);
    const rel = /conflict|memory_map/i.test(base) ? 0
      : KEY_FILE_RE.test(base) ? 1
        : /\.py$/i.test(f) ? 2 : 3;
    return { f, size, rel };
  }).sort((a, b) => a.rel - b.rel || a.size - b.size);

  const out: { path: string; content: string }[] = [];
  let budget = maxBytes;
  for (const c of cand) {
    if (out.length >= maxFiles || budget <= 200) break;
    let content: string;
    try { content = readFileSync(path.join(root, c.f), 'utf8'); } catch { continue; }
    if (!content.trim()) continue;
    const slice = content.slice(0, Math.min(content.length, budget));
    out.push({ path: c.f, content: slice });
    budget -= slice.length;
  }
  return out;
}

// Pure (no I/O) so it is unit-testable. Embeds the spec for naming/structure. The
// REAL SOURCE is the ground truth: when a cloned reference tree exists, point the
// agent at it (it has Read/Grep) so it reads the ACTUAL files; otherwise fall back
// to the transcribed paper excerpt.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildSourceVerifyPrompt(scene: any, ev: LoadedEvidence, backendInstructions: string, sourceFiles: string[] = [], inlined: { path: string; content: string }[] = []): string {
  const spec = JSON.stringify({
    machine_name: scene?.machine_name,
    metadata: { spec: scene?.metadata?.spec },
    parts: (scene?.parts || []).map((p: { id?: string; name?: string; role?: string; spec?: unknown }) =>
      ({ id: p.id, name: p.name, role: p.role, spec: p.spec })),
  }, null, 1).slice(0, 8000);

  const fileList = sourceFiles.slice(0, 200).map((f) => `    ${f}`).join('\n');
  const inlinedBlock = inlined.map((s) => `\`\`\`\n// file: ${s.path}\n${s.content}\n\`\`\``).join('\n\n');
  const sourceBlock = ev.sourceDir
    ? `THE REAL SOURCE is a cloned reference checkout at ${ev.sourceDir} (${sourceFiles.length} files).
The KEY files are INLINED below — write your verification DIRECTLY from them; model
the golden/reference and the properties on THESE real functions, parameters and
tables. Use the Read/Grep tools ONLY if you truly need a file that is NOT inlined —
do NOT read many files (you have a limited tool budget); never write or run files.

KEY SOURCE FILES (inlined):
${inlinedBlock || '(none inlined — Read the files below)'}

Full file list (relative to the dir above):
${fileList}
${ev.paper ? `\nHigh-level notes (transcribed paper):\n\`\`\`markdown\n${evidenceExcerpt({ ...ev, sourceDir: null }, 5000)}\n\`\`\`` : ''}`
    : `THE REAL SOURCE — ground truth (transcribe its actual maps/equations/parameters
into your golden model and properties; do not invent beyond it):
\`\`\`markdown
${evidenceExcerpt(ev, 16000)}
\`\`\``;

  return `You are FORMALLY VERIFYING a REAL, existing system. Its actual SOURCE — the
paper and the reference implementation code — is the GROUND TRUTH. You are NOT
reverse-implementing or guessing: model your golden/reference and the properties
you check on the SOURCE's real functions, parameters, and equations, and confirm
the system's key properties hold.

${backendInstructions}

SYSTEM (names / structure for context):
\`\`\`json
${spec}
\`\`\`

${sourceBlock}

GROUNDING APPROACH — verify the system's PROPERTIES USING the source's real
tables / parameters / functions AS-IS. Do NOT make "I regenerated this table/ROM
and it equals the source's" a pass/fail gate — ordering/format conventions
(bit-reversal, Montgomery, merged-twist) make exact reproduction a FALSE mismatch;
READ the real values and use them.

VERIFICATION RIGOR — this is FORMAL verification, so "VERIFIED" must mean PROVEN,
not "tested on a few inputs". EVERY property must be discharged ONE of two ways,
and nothing else counts as a pass:
  (a) a z3 PROOF — assert the negation, require unsat. For bit-vector obligations
      (a modular multiply / Barrett) BIT-BLAST so z3 decides, e.g.
      Then('simplify','bit-blast','smt').solver() over QF_BV (no Int/BV mixing). If
      z3 returns 'unknown', strengthen/split the encoding until it decides — do NOT
      downgrade to sampling.
  (b) EXHAUSTIVE enumeration of the FULL finite domain (e.g. every x in [0,q)).
A randomized / sampled check (N random vectors; a subset of a ~10^8 domain) is a
SMOKE test, NOT verification — it must NEVER be the basis for printing VERIFIED.

Prove LINEAR/bilinear properties via STRUCTURE, not samples: an NTT/INTT is a
linear map, so checking INTT(NTT(e_i)) == e_i on every standard BASIS vector
e_0..e_{N-1} (at a small structure-preserving N) PROVES INTT∘NTT = identity for
ALL inputs; the convolution theorem (bilinear) is proven on basis pairs. Use the
source's real twiddle table for these.

REQUIRED checks — ALL must be present and pass:
  1. each modular unit (add, sub, the /2, the Barrett multiply-reduce) equals its
     exact mod-q function — z3-proved or exhaustive over the full domain;
  2. the CONFLICT-FREE memory map — the source's HEADLINE theorem; prove it in its
     GENERAL form, not one case. For EVERY supported radix (read them from the
     source; at least {2,4}), EVERY supported parallel-BU count (powers of two up to
     the design's max; at least {1,2,4,8}), and EVERY power-of-two stride, the
     operands accessed in one cycle land in DISTINCT banks — z3-proved over the
     SYMBOLIC address from the source's real bank/offset map. Print the exact
     (radix, #BU, stride) space you covered. (z3 cannot do truly unbounded radix/#BU;
     covering the full SUPPORTED set is what "arbitrary" means for this design — and
     if you can, add a symbolic-parameter argument for extra generality.);
  3. INVERTIBILITY at the PRODUCTION size: INTT∘NTT == identity proved on the FULL
     basis (ALL N unit vectors) at the real N=1024 — proves every input at full
     size by linearity (1024 transforms is cheap; do NOT sample random vectors);
  4. the transform DIAGONALISES negacyclic convolution — proved on basis pairs at
     a small structure-preserving N (bilinearity);
  5. NATURAL-ORDER output — if the source claims no bit-reversal pass, prove the
     real address/scheduling yields natural order (a permutation identity).

OUTPUT CONTRACT — return the complete program as your FINAL message in ONE fenced
code block (real newlines), and NOTHING else. Do NOT write it to a file, do NOT
run it, do NOT use a heredoc — the harness saves and runs it:
\`\`\`python
<the full self-checking program>
\`\`\``;
}

// Repair prompt for the self-improvement loop: hand the agent its previous (not
// passing) program and the exact output, with diagnosis hints, so it revises and
// retries until VERIFIED. The source is published & working, so a non-pass almost
// always means the CHECK is wrong, not the system.
export function fixVerifyPrompt(prevScript: string, output: string, kind: string, backendInstructions: string): string {
  return `Your previous verification program did NOT pass (verdict: ${kind}). Revise it so
it correctly verifies the REAL source's properties and prints exactly "VERIFIED".

ITS OUTPUT (stdout + stderr — read it to see WHICH check failed and why):
${(output || '(no output)').slice(0, 3500)}

DIAGNOSE before editing. The reference source is published and working, so a
non-pass almost always means YOUR check is wrong — not the system:
- z3 returned 'unknown' → that is NOT a counterexample; make the obligation
  decidable (bit-blast, e.g. Then('simplify','bit-blast','smt').solver()) or fall
  back to exhaustive/randomized checks. NEVER FAIL on unknown.
- "regenerated <table/ROM/golden> != reference" → drop that equality gate; USE the
  source's real table/values as-is and verify the end-to-end property (round-trip,
  convolution) instead. Ordering/format conventions make exact reproduction a
  FALSE mismatch.
- a concrete counterexample → re-examine YOUR golden model and assumptions
  (index ordering, sign, mod/normalisation convention); align them to the source.
- syntax/exception/timeout → fix it; keep every check bounded so it finishes <60s.
RIGOR (do NOT relax to make it pass): a randomized/sampled check is NOT a proof —
every property must be z3-PROVED (bit-blast for bit-vector obligations; never
accept 'unknown') or EXHAUSTIVE over the full domain. Prove invertibility on the
FULL basis at N=1024 (not random vectors), the convolution theorem on basis pairs,
and the conflict-free map for the WHOLE supported (radix, #BU, stride) space — not
a single config. If a check is too slow, make it tighter/decidable, do NOT drop it
or downgrade it to sampling.
Keep the SAME contract: print "VERIFIED" (exit 0) or "FAIL: <reason+counterexample>".

PREVIOUS PROGRAM:
\`\`\`python
${prevScript}
\`\`\`

(Backend rules, unchanged:)
${backendInstructions}

Return ONLY the full corrected program in ONE fenced \`\`\`python code block — do
NOT write or run it yourself.`;
}

export interface VerifyStepOpts { model?: string; backend?: string; attempts?: number }

// Run source-grounded formal verification. Throws if there is no source yet.
export async function verifyStep(
  id: string,
  opts: VerifyStepOpts = {},
): Promise<{ pass: boolean; ran: boolean; kind: string; runDir: string }> {
  const target = resolveScene(id);
  if (!target) throw new Error(`no such scene: ${id}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene: any = JSON.parse(readFileSync(target, 'utf8'));

  const ev = loadEvidence(id);
  if (ev.origin === 'none') {
    throw new Error(`no source evidence for "${id}" — run \`visually visualize ${id}\` (or add a paper/source URL to the scene) first; verify checks the REAL source.`);
  }

  const backend = getBackend(opts.backend || selectBackend(scene));
  const avail = await backend.available();
  if (!avail.ok) {
    console.log(`  · verify backend unavailable: ${avail.reason}`);
    return { pass: false, ran: false, kind: 'no-runner', runDir: '' };
  }

  ensureWorkspace();
  const dir = makeRunDir(id, 'verify', stamp());
  mkdirSync(dir, { recursive: true });
  const sourceFiles = ev.sourceDir ? listSourceFiles(ev.sourceDir) : [];
  const inlined = ev.sourceDir ? inlineKeySources(ev.sourceDir, sourceFiles) : [];
  const ext = backend.language === 'python' ? 'py' : 'v';
  // Read/Grep let the agent inspect the ACTUAL cloned files; NO Bash, so it can't
  // sidetrack into writing/running the script itself — it must RETURN it as text.
  const tools = ev.sourceDir ? ['Read', 'Grep'] : undefined;
  const maxAttempts = opts.attempts && opts.attempts > 0 ? Math.min(opts.attempts, 8) : 4;
  // Formal proofs (bit-blasted modular multiply, conflict-free over a config
  // space, N=1024 invertibility) need more than the fast loop's 180s. Give the
  // backend headroom unless the caller already set a limit.
  if (!process.env.VISUALLY_VERIFY_TIMEOUT_MS) process.env.VISUALLY_VERIFY_TIMEOUT_MS = '600000';

  console.log(`  verifying the real source with ${backend.label} (evidence: ${ev.origin}${ev.sourceDir ? `, ${sourceFiles.length} cloned files` : ''}) — up to ${maxAttempts} attempt(s)…`);

  // Self-improvement loop: write a check, run it, and if it doesn't pass feed the
  // failure (output + previous program) back so the agent revises it — until it
  // VERIFIES or attempts run out. A non-pass is almost always a flaw in the CHECK,
  // not the (published, working) source.
  let prevScript = '';
  let lastKind = 'no-script';
  let lastLog = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = attempt === 1
      ? buildSourceVerifyPrompt(scene, ev, backend.implementInstructions(), sourceFiles, inlined)
      : fixVerifyPrompt(prevScript, lastLog, lastKind, backend.implementInstructions());
    writeFileSync(path.join(dir, `prompt-${attempt}.txt`), prompt);

    const { text } = await runClaudeStreaming({ prompt, model: opts.model, runDir: dir, quiet: true, tools });
    const impl = parseImpl(text);
    if (typeof impl.script !== 'string' || !impl.script.trim()) {
      lastKind = 'no-script';
      lastLog = '(the model returned no fenced program — return the FULL program in one ```python block, do not write/run it)';
      console.log(`  · attempt ${attempt}/${maxAttempts}: no program returned`);
      continue;
    }
    prevScript = impl.script;
    writeFileSync(path.join(dir, `check-${attempt}.${ext}`), impl.script);
    writeFileSync(path.join(dir, `check.${ext}`), impl.script);

    const res = await backend.verify(impl.script, dir);
    lastKind = res.kind ?? (res.pass ? 'pass' : res.ran ? 'fail' : 'error');
    lastLog = `${res.stdout || ''}\n${res.stderr || ''}`;
    const log = `attempt ${attempt}/${maxAttempts}\npass=${res.pass} ran=${res.ran} kind=${lastKind}\n--- stdout ---\n${res.stdout || ''}\n--- stderr ---\n${(res.stderr || '').slice(0, 4000)}`;
    writeFileSync(path.join(dir, 'verify.txt'), log);

    if (res.pass) {
      saveVerifyImpl(id, scene, backend, ext, impl.script, log, dir, true);
      console.log(`  ✓ VERIFIED on attempt ${attempt}/${maxAttempts} — the source's checked properties hold`);
      return { pass: true, ran: true, kind: 'pass', runDir: dir };
    }
    console.log(`  · attempt ${attempt}/${maxAttempts}: ${lastKind === 'fail' ? 'FAIL (counterexample)' : `did not run (${lastKind})`} — ${attempt < maxAttempts ? 'revising…' : 'giving up'}`);
  }

  // Exhausted: persist the last attempt and report.
  saveVerifyImpl(id, scene, backend, ext, prevScript, lastLog, dir, false);
  console.log(`  ✗ not verified after ${maxAttempts} attempt(s) (last: ${lastKind}). Inspect ${dir}`);
  return { pass: false, ran: lastKind === 'fail', kind: lastKind, runDir: dir };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function saveVerifyImpl(id: string, scene: any, backend: { id: string; language: string }, ext: string, code: string, log: string, dir: string, pass: boolean): void {
  if (!code) return;
  try {
    saveImpl(id, {
      code,
      verifyLog: log,
      meta: {
        id, mode: scene?.metadata?.mode || 'hardware', language: backend.language, ext,
        backend: backend.id, verified: { pass, ran: pass },
        savedAt: new Date().toISOString(), runDir: dir,
      },
    });
  } catch { /* impl store is best-effort */ }
}

interface VerifyCliOpts { positional: string[]; model?: string; backend?: string; attempts?: number }

function parseArgs(argv: string[]): VerifyCliOpts {
  const opts: VerifyCliOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opts.model = argv[++i];
    else if (a === '--backend') opts.backend = argv[++i];
    else if (a === '--attempts') opts.attempts = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function verify(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) throw new Error('usage: visually verify <scene> [--attempts N] [--model <m>] [--backend <id>]');
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);
  console.log(`visually verify: ${id} — formal verification of the real source (self-improving)`);
  await verifyStep(id, opts);
}
