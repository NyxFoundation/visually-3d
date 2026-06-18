// `visually reproduce <scene>` — measure whether a scene descriptor is a
// *reproducible spec*: can an AI rebuild the real system from the descriptor
// ALONE? This operationalizes the "implementability" bar for algorithm/circuit
// subjects, where the 3D arrangement is decoration and the substance is the
// netlist / compute-graph the descriptor must (but currently doesn't) capture.
//
// Mechanism (no external toolchain needed, works for circuits and algorithms):
//   1. N independent "reverse-implementer" agents see the descriptor ONLY and
//      try to implement it (Verilog for a circuit, Python for an algorithm),
//      recording everything they had to GUESS / that was underspecified.
//   2. A judge scores reproducibility, flags where the N independent
//      implementations DIVERGE (= spec ambiguity), and lists the concrete
//      missing fields the spec should have carried.
//
// The judge's `missing_fields` is the payload: the empirical list of what a
// reproducible spec IR must add. Everything is logged for inspection.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveScene, sceneIdFromPath, runDir as makeRunDir, ensureWorkspace } from './paths.js';
import { runClaudeStreaming } from './runner.js';
import { extractScene } from './scene.js';
import { getBackend, defaultBackendFor } from './backends/index.js';
import { saveImpl, implDir } from './impls.js';
import type { Availability } from './types.js';

interface ReproduceOpts {
  positional: string[];
  model?: string;
  n?: number;
  backend?: string;
  noVerify?: boolean;
}

function parseArgs(argv: string[]): ReproduceOpts {
  const opts: ReproduceOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opts.model = argv[++i];
    else if (a === '--n') opts.n = Number(argv[++i]);
    else if (a === '--backend') opts.backend = argv[++i];
    else if (a === '--no-verify') opts.noVerify = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const langFor = (mode: string): string => (mode === 'algorithm' ? 'runnable Python' : 'synthesizable Verilog');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reimplementerPrompt(scene: any, mode: string, perspective: string, backendInstructions: string | null): string {
  return `You are REVERSE-IMPLEMENTING a system from a SPEC ALONE. You do NOT have the
original paper, datasheet, RTL, or source code — only the JSON spec below. Your
job is to test whether the spec is complete enough to reproduce the real system.

The spec is a "scene descriptor". Its fields shape / position / size / rotation
/ material are 3D-RENDERING DECORATION — IGNORE them entirely. Implement only
from: machine_name, each part's name + role, the connections graph, any
parameters/behavioral fields, and metadata.info.

Subject: ${scene.machine_name}
Implementation target: ${langFor(mode)}.
Reviewer perspective: ${perspective}

SPEC (the only thing you may use):
\`\`\`json
${JSON.stringify({ machine_name: scene.machine_name, assembly_instructions: scene.assembly_instructions, metadata: scene.metadata, parts: scene.parts }, null, 1)}
\`\`\`

Do this:
1. Implement the system as ${langFor(mode)}, as completely as the spec allows —
   modules/functions, interfaces, datapaths, control, parameters, wiring.
2. Be brutally honest: every time the spec did NOT give you something you NEEDED
   — a bit width, a port, an exact operation/equation, a parameter value, a
   connection direction, an FSM/control sequence, a loop bound, a tensor
   shape/dtype, a pipeline depth — you must GUESS it and record the guess.

${backendInstructions ? `\nThe runnable program you must produce:\n${backendInstructions}\n` : ''}
Return your answer in exactly two parts:

PART 1 — a JSON object (metadata only), first, no markdown fence around it:
{
  "language": "${backendInstructions ? 'python' : (mode === 'algorithm' ? 'python' : 'verilog')}",
  "guessed": ["<the thing you had to guess> -> <the value/behavior you assumed>", ...],
  "underspecified": ["<concrete info the spec should have contained but didn't>", ...],
  "confidence": <0-100, how confident this matches the REAL system>
}

PART 2 — ${backendInstructions ? 'the runnable self-checking program' : 'your full implementation'} in ONE fenced code block (this is run verbatim, so put REAL newlines, not "\\n"):
\`\`\`${backendInstructions ? 'python' : (mode === 'algorithm' ? 'python' : 'verilog')}
<code here>
\`\`\``;
}

// Pull the program out of a fenced code block (robust against the model
// embedding a whole program inside a JSON string, which mangles newlines).
export function extractFencedCode(text: string): string | null {
  const re = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  if (!blocks.length) return null;
  // Prefer the longest block that isn't the metadata JSON.
  const code = blocks.filter((b) => !/^\s*\{[\s\S]*"confidence"/.test(b))
    .sort((a, b) => b.length - a.length)[0] || blocks.sort((a, b) => b.length - a.length)[0];
  return code;
}

// Last-resort: a program that arrived as a JSON string with literal "\n" instead
// of real newlines won't run — un-escape it.
export function deescapeIfNeeded(s: string | null): string | null {
  if (typeof s !== 'string') return s;
  const real = (s.match(/\n/g) || []).length;
  const lit = (s.match(/\\n/g) || []).length;
  if (lit > 4 && real < 3) {
    return s.replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

// Parse a reimplementer response: metadata JSON + the program from a fenced block.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseImpl(text: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let meta: any = {};
  try { meta = extractScene(text); } catch { /* maybe metadata absent */ }
  let script = extractFencedCode(text);
  if (!script && typeof meta.script === 'string') script = meta.script;
  if (!script && typeof meta.implementation === 'string') script = meta.implementation;
  script = deescapeIfNeeded(script);
  return { ...meta, script, implementation: script || meta.implementation };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgePrompt(scene: any, mode: string, impls: any[]): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaries = impls.map((im: any, i: number) => `### Implementation ${i + 1} (confidence ${im?.confidence ?? '?'})
guessed: ${JSON.stringify(im?.guessed ?? [])}
underspecified: ${JSON.stringify(im?.underspecified ?? [])}
code (first 1500 chars):
${String(im?.implementation ?? '').slice(0, 1500)}`).join('\n\n');

  return `You are assessing whether a system's SPEC is enough to REPRODUCE it. ${impls.length}
engineers independently reverse-implemented it from the SAME spec alone (in
${langFor(mode)}). Below is the spec, then each independent implementation with
the implementer's own notes on what they had to guess.

Subject: ${scene.machine_name}

SPEC:
\`\`\`json
${JSON.stringify({ machine_name: scene.machine_name, assembly_instructions: scene.assembly_instructions, parts: scene.parts }, null, 1).slice(0, 9000)}
\`\`\`

INDEPENDENT IMPLEMENTATIONS:
${summaries}

Assess:
- reproducibility 0-100: could a competent engineer rebuild the SAME system
  (same behavior, same interfaces, same parameters) from the spec ALONE, with no
  guessing? 100 = fully specified down to widths/ops/params; low = the
  implementers had to invent the substance.
- Where the ${impls.length} independent implementations DIVERGE, the spec is
  ambiguous — list those divergences.
- List the concrete missing fields the spec should have carried so it would be
  reproducible. Be specific and structural.

Return ONLY this JSON, no fences, no prose:
{
  "reproducibility": <0-100>,
  "verdict": "reproducible" | "ambiguous" | "underspecified",
  "divergences": ["<where independent impls differ → which detail the spec left open>", ...],
  "missing_fields": [
    { "item": "<specific missing info>", "kind": "port|width|param|operation|connection|dtype|shape|control|timing", "where": "<which part/node or 'global'>" }
  ],
  "summary": "<2-3 sentences: the single biggest reason this is or isn't reproducible>"
}`;
}

async function runAgent(
  prompt: string,
  model: string | undefined,
  logFile: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parser: (text: string) => any = extractScene,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { text } = await runClaudeStreaming({ prompt, model, quiet: true });
  if (logFile) writeFileSync(logFile, text);
  try {
    return parser(text);
  } catch (err) {
    return { _parseError: (err as Error).message, _raw: text.slice(0, 400) };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function reproduce(argv: string[]): Promise<any> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) throw new Error('usage: visually reproduce <scene> [--n 2] [--model <m>]');
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);

  const id = sceneIdFromPath(target);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene: any = JSON.parse(readFileSync(target, 'utf8'));
  const mode: string = scene.metadata?.mode || 'hardware';
  const n = opts.n !== undefined && Number.isFinite(opts.n) && opts.n > 0 ? Math.min(opts.n, 4) : 2;

  ensureWorkspace();
  const runDir = makeRunDir(id, 'reproduce', stamp());
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify(scene, null, 2));

  // Resolve the (optional, pluggable) executable-verification backend: SMT for
  // algorithms, physics sim for machines, overridable with --backend.
  const backend = getBackend(opts.backend || defaultBackendFor(mode));
  const avail: Availability = opts.noVerify
    ? { ok: false, reason: 'disabled via --no-verify' }
    : await backend.available();
  const backendInstructions = avail.ok ? backend.implementInstructions() : null;

  console.log(`visually reproduce: ${id} (mode=${mode}) — ${n} independent reimplementations`);
  console.log(`  target language: ${langFor(mode)}`);
  console.log(`  verify backend: ${backend.label} — ${avail.ok ? `enabled (${avail.runner})` : `off (${avail.reason})`}`);
  console.log(`  run log → ${runDir}`);
  console.log('  reimplementing from the spec alone…');

  const perspectives = [
    'a hardware/RTL engineer focused on interfaces and bit-widths',
    'a systems programmer focused on exact operations and control flow',
    'a verification engineer focused on parameters and corner cases',
    'a compiler engineer focused on dataflow and dependencies',
  ];

  const impls = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      runAgent(
        reimplementerPrompt(scene, mode, perspectives[i % perspectives.length], backendInstructions),
        opts.model,
        path.join(runDir, `impl-${i + 1}.txt`),
        parseImpl,
      ),
    ),
  );

  // Executable verification: actually run each implementation's self-check
  // through the backend (real ground truth, not just the judge's opinion).
  let verifiedCount = 0;
  for (let i = 0; i < impls.length; i++) {
    const im = impls[i];
    const ext = (im?.language === 'python') ? 'py' : 'v';
    if (typeof im?.implementation === 'string') {
      writeFileSync(path.join(runDir, `impl-${i + 1}.${ext}`), im.implementation);
    }
    let verdict = '';
    if (avail.ok && im && typeof im.script === 'string') {
      const res = await backend.verify(im.script, runDir);
      im._verify = { pass: res.pass, ran: res.ran };
      const log = `pass=${res.pass} ran=${res.ran}\n--- stdout ---\n${res.stdout || ''}\n--- stderr ---\n${(res.stderr || '').slice(0, 4000)}`;
      im._verifyLog = log;
      writeFileSync(path.join(runDir, `impl-${i + 1}-verify.txt`), log);
      if (res.pass) verifiedCount++;
      verdict = ` | self-verify: ${res.pass ? 'PASS ✓' : (res.ran ? 'FAIL' : 'did not run')}`;
    }
    console.log(`  impl ${i + 1}: confidence ${im?.confidence ?? '?'}, ` +
      `${(im?.guessed || []).length} guesses, ${(im?.underspecified || []).length} underspecified${verdict}`);
  }
  if (avail.ok) {
    console.log(`  executable self-verification: ${verifiedCount}/${impls.length} implementations passed`);
  }

  console.log('  judging reproducibility…');
  const report = await runAgent(judgePrompt(scene, mode, impls), opts.model,
    path.join(runDir, 'report.raw.txt'));
  report.backend = backend.id;
  report.executable_verification = avail.ok
    ? { enabled: true, passed: verifiedCount, total: impls.length }
    : { enabled: false, reason: avail.reason };
  writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));

  // Persist the best implementation as this scene's canonical impl, so the web
  // detail page can show source ⇄ 3D and re-run the tests. "Best" = verified
  // first (a passing self-check beats opinion), then highest confidence.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates = (impls as any[]).filter((im) => typeof im?.script === 'string' && im.script.length > 0);
  candidates.sort((a, b) => {
    const pa = a._verify?.pass ? 1 : 0;
    const pb = b._verify?.pass ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
  const best = candidates[0];
  if (best) {
    const language: string = best.language || (mode === 'algorithm' ? 'python' : 'verilog');
    saveImpl(id, {
      code: best.script,
      verifyLog: best._verifyLog,
      meta: {
        id,
        mode,
        language,
        ext: language === 'python' ? 'py' : 'v',
        backend: backend.id,
        confidence: best.confidence,
        reproducibility: report.reproducibility,
        verdict: report.verdict,
        verified: best._verify ?? null,
        savedAt: new Date().toISOString(),
        runDir,
      },
    });
    console.log(`  ✓ saved canonical implementation → ${implDir(id)}`);
  }

  console.log('');
  if (avail.ok) {
    console.log(`  ── executable self-verification: ${verifiedCount}/${impls.length} passed (${backend.label})`);
  }
  console.log(`  ── reproducibility: ${report.reproducibility ?? '?'}/100  (${report.verdict ?? '?'})`);
  if (report.summary) console.log(`  ${report.summary}`);
  if ((report.divergences || []).length) {
    console.log('\n  divergences (spec ambiguity — independent impls differ):');
    for (const d of report.divergences.slice(0, 8)) console.log(`    · ${d}`);
  }
  if ((report.missing_fields || []).length) {
    console.log('\n  missing fields (what a reproducible spec must add):');
    for (const m of report.missing_fields.slice(0, 12)) {
      console.log(`    · [${m.kind}] ${m.item}${m.where ? `  (${m.where})` : ''}`);
    }
  }
  console.log(`\n  full report + each implementation → ${runDir}`);
  return report;
}
