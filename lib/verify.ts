// `visually verify <scene>` — the VERIFY leg. Formally checks the REAL system
// using its gathered ground-truth SOURCE (the paper + reference code that
// `visualize` cached) as the reference, via the auto-selected backend (z3/SMT for
// circuits & algorithms, physics sim for machines).
//
// This is NOT reverse-implementation from the spec: the source exists, so we
// verify ITS properties directly. No source → error (run `visualize` first). One
// agent writes the self-checking program grounded in the source; the backend runs
// it (the two-tier z3 discipline lives in the backend's implementInstructions).

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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

// Pure (no I/O) so it is unit-testable. Embeds the spec for naming/structure. The
// REAL SOURCE is the ground truth: when a cloned reference tree exists, point the
// agent at it (it has Read/Grep/Bash) so it reads the ACTUAL files; otherwise fall
// back to the transcribed paper excerpt.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildSourceVerifyPrompt(scene: any, ev: LoadedEvidence, backendInstructions: string): string {
  const spec = JSON.stringify({
    machine_name: scene?.machine_name,
    metadata: { spec: scene?.metadata?.spec },
    parts: (scene?.parts || []).map((p: { id?: string; name?: string; role?: string; spec?: unknown }) =>
      ({ id: p.id, name: p.name, role: p.role, spec: p.spec })),
  }, null, 1).slice(0, 8000);

  const sourceBlock = ev.sourceDir
    ? `THE REAL SOURCE is a cloned reference checkout at:
    ${ev.sourceDir}
Use your tools to read it: \`ls -R\`, \`cat\`, and \`grep\` the actual modules
(memory map, address/twiddle generators, FSM, butterfly/reducer datapath). Model
your golden/reference and the properties you check on THOSE real files — do not
invent beyond them.${ev.paper ? `\n\nHigh-level notes (transcribed paper):\n\`\`\`markdown\n${evidenceExcerpt({ ...ev, sourceDir: null }, 6000)}\n\`\`\`` : ''}`
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

${sourceBlock}`;
}

export interface VerifyStepOpts { model?: string; backend?: string }

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
  const prompt = buildSourceVerifyPrompt(scene, ev, backend.implementInstructions());
  writeFileSync(path.join(dir, 'prompt.txt'), prompt);

  console.log(`  verifying the real source with ${backend.label} (evidence: ${ev.origin}${ev.sourceDir ? ', cloned repo' : ''})…`);
  // When a cloned reference tree exists, let the agent read the ACTUAL files.
  const tools = ev.sourceDir ? ['Read', 'Grep', 'Bash'] : undefined;
  const { text } = await runClaudeStreaming({ prompt, model: opts.model, runDir: dir, quiet: true, tools });
  const impl = parseImpl(text);
  if (typeof impl.script !== 'string' || !impl.script.trim()) {
    console.log('  ✗ no verification program produced');
    return { pass: false, ran: false, kind: 'no-script', runDir: dir };
  }
  const ext = backend.language === 'python' ? 'py' : 'v';
  writeFileSync(path.join(dir, `check.${ext}`), impl.script);

  const res = await backend.verify(impl.script, dir);
  const kind = res.kind ?? (res.pass ? 'pass' : res.ran ? 'fail' : 'error');
  const log = `pass=${res.pass} ran=${res.ran} kind=${kind}\n--- stdout ---\n${res.stdout || ''}\n--- stderr ---\n${(res.stderr || '').slice(0, 4000)}`;
  writeFileSync(path.join(dir, 'verify.txt'), log);

  try {
    saveImpl(id, {
      code: impl.script,
      verifyLog: log,
      meta: {
        id, mode: scene?.metadata?.mode || 'hardware', language: backend.language, ext,
        backend: backend.id, verified: { pass: res.pass, ran: res.ran },
        savedAt: new Date().toISOString(), runDir: dir,
      },
    });
  } catch { /* impl store is best-effort */ }

  console.log(res.pass ? '  ✓ VERIFIED — the source\'s checked properties hold'
    : `  ✗ ${kind === 'fail' ? 'FAIL (counterexample)' : `did not run (${kind})`}`);
  return { pass: res.pass, ran: res.ran, kind, runDir: dir };
}

interface VerifyCliOpts { positional: string[]; model?: string; backend?: string }

function parseArgs(argv: string[]): VerifyCliOpts {
  const opts: VerifyCliOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opts.model = argv[++i];
    else if (a === '--backend') opts.backend = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function verify(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) throw new Error('usage: visually verify <scene> [--model <m>] [--backend <id>]');
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);
  console.log(`visually verify: ${id} — formal verification of the real source`);
  await verifyStep(id, opts);
}
