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
import { repairArithmeticClaims } from './arith-audit.js';
import { getBackend, selectBackend } from './backends/index.js';
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

// The implementation language the reimplementer should target. When a
// verification backend is active it DICTATES the language (the self-check runs
// in it), so the prompt must not tell the engineer "Verilog" while the backend
// demands a Python script. With no backend, fall back to the mode default.
function implLang(mode: string, backendLanguage: string | null): { label: string; fence: string } {
  if (backendLanguage) {
    return backendLanguage === 'python'
      ? { label: 'runnable Python', fence: 'python' }
      : { label: `synthesizable ${backendLanguage}`, fence: backendLanguage };
  }
  return mode === 'algorithm'
    ? { label: 'runnable Python', fence: 'python' }
    : { label: 'synthesizable Verilog', fence: 'verilog' };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reimplementerPrompt(scene: any, perspective: string, backendInstructions: string | null, lang: { label: string; fence: string }): string {
  return `You are REVERSE-IMPLEMENTING a system from a SPEC ALONE. You do NOT have the
original paper, datasheet, RTL, or source code — only the JSON spec below. Your
job is to test whether the spec is complete enough to reproduce the real system.

The spec is a "scene descriptor". Its fields shape / position / size / rotation
/ material are 3D-RENDERING DECORATION — IGNORE them entirely. Implement only
from: machine_name, each part's name + role, the connections graph, and the
FUNCTIONAL SPEC fields — \`spec\` on each part and \`metadata.spec\` at the top
level (params, widths, ports, ops, fsm, notes) — plus metadata.info.

The \`spec\` fields are AUTHORITATIVE: when a part's \`spec\` gives a width, a
parameter value, an operation, a port direction, or an FSM, use it verbatim and
do NOT count it as a guess. Only treat as guessed/underspecified what \`spec\`
(and the rest of the descriptor) does NOT pin down.

Subject: ${scene.machine_name}
Implementation target: ${lang.label}.
Reviewer perspective: ${perspective}

SPEC (the only thing you may use):
\`\`\`json
${JSON.stringify({ machine_name: scene.machine_name, assembly_instructions: scene.assembly_instructions, metadata: scene.metadata, parts: scene.parts }, null, 1)}
\`\`\`

Do this:
1. Implement the system as ${lang.label}, as completely as the spec allows —
   modules/functions, interfaces, datapaths, control, parameters, wiring.
2. Be brutally honest: every time the spec did NOT give you something you NEEDED
   — a bit width, a port, an exact operation/equation, a parameter value, a
   connection direction, an FSM/control sequence, a loop bound, a tensor
   shape/dtype, a pipeline depth — you must GUESS it and record the guess.

${backendInstructions ? `\nThe runnable program you must produce:\n${backendInstructions}\n` : ''}
Return your answer in exactly two parts:

PART 1 — a JSON object (metadata only), first, no markdown fence around it:
{
  "language": "${lang.fence}",
  "guessed": ["<the thing you had to guess> -> <the value/behavior you assumed>", ...],
  "underspecified": ["<concrete info the spec should have contained but didn't>", ...],
  "confidence": <0-100, how confident this matches the REAL system>
}

PART 2 — ${backendInstructions ? 'the runnable self-checking program' : 'your full implementation'} in ONE fenced code block (this is run verbatim, so put REAL newlines, not "\\n"):
\`\`\`${lang.fence}
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
function judgePrompt(scene: any, langLabel: string, impls: any[]): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaries = impls.map((im: any, i: number) => `### Implementation ${i + 1} (confidence ${im?.confidence ?? '?'})
guessed: ${JSON.stringify(im?.guessed ?? [])}
underspecified: ${JSON.stringify(im?.underspecified ?? [])}
code (first 1500 chars):
${String(im?.implementation ?? '').slice(0, 1500)}`).join('\n\n');

  // The REFERENCE (the paper/datasheet the scene depicts) is the ground truth
  // for FIDELITY: not "does the impl work" but "is it the SAME system the source
  // describes". Pulled from metadata so the judge can compare claimed params and
  // named properties against what the implementations actually did.
  const reference = JSON.stringify({
    reference: scene.metadata?.reference,
    domain: scene.metadata?.domain,
    info: scene.metadata?.info,
    spec: scene.metadata?.spec,
  }, null, 1).slice(0, 6000);

  return `You are assessing two DIFFERENT things about a system's SPEC and the
${impls.length} implementations independently reverse-implemented from it alone
(in ${langLabel}):

  A. REPRODUCIBILITY — is the spec complete enough to rebuild the system at all?
  B. FIDELITY — do the implementations match the SPECIFIC system in the
     REFERENCE (the paper/datasheet), not merely "a correct one"? Many distinct
     correct implementations exist; fidelity asks whether THIS one is the one the
     source actually describes — same parameters, same named properties, same
     architecture. Judge this with your own expertise (an LLM-as-judge call); you
     do not need to run anything.

Subject: ${scene.machine_name}

REFERENCE (ground truth for FIDELITY — the source this system comes from):
\`\`\`json
${reference}
\`\`\`

SPEC (what the engineers were given):
\`\`\`json
${JSON.stringify({ machine_name: scene.machine_name, assembly_instructions: scene.assembly_instructions, metadata: { spec: scene.metadata?.spec }, parts: scene.parts }, null, 1).slice(0, 9000)}
\`\`\`

INDEPENDENT IMPLEMENTATIONS:
${summaries}

Assess REPRODUCIBILITY:
- reproducibility 0-100: could a competent engineer rebuild the SAME system
  (same behavior, interfaces, parameters) from the spec ALONE, no guessing?
- Where the ${impls.length} implementations DIVERGE, the spec is ambiguous.
- List the concrete missing fields the spec should have carried.

Note: each part may carry a \`spec\` block (params/widths/ports/ops/fsm/notes)
and there may be a top-level \`metadata.spec\`. Anything pinned down there is
SPECIFIED — do not list it as missing. For every missing field, set \`where\` to
the exact part \`id\` (so it can be written into that part's \`spec\`), or
"global" for a system-level fact (→ \`metadata.spec\`).

Assess FIDELITY against the REFERENCE:
- parameter_fidelity: for each parameter the reference pins down or implies
  (e.g. modulus, transform size, bit-widths, parallelism, reduction algorithm),
  compare the value the implementations used. Mark match true/false; if the
  reference itself does not state it, set reference_value to "unstated".
- property_checks: for each NAMED property/claim the reference makes (e.g. a
  "conflict-free" mapping, no bit-reversal, a quantified resource saving, a
  round-trip/inverse identity), judge whether the implementations actually
  exhibit it: "satisfied" | "violated" | "unverifiable" (and why).
- structural_findings: where the implementations' ARCHITECTURE diverges from the
  structure the reference describes (topology, datapath ordering, scheduling),
  even if the I/O behavior would still be correct.
- fidelity 0-100: how faithfully, overall, the implementations reproduce the
  SPECIFIC system in the reference (100 = same params + properties + structure;
  low = merely a generic correct version, or wrong params/structure).

Return ONLY this JSON, no fences, no prose:
{
  "reproducibility": <0-100>,
  "verdict": "reproducible" | "ambiguous" | "underspecified",
  "divergences": ["<where independent impls differ → which detail the spec left open>", ...],
  "missing_fields": [
    { "item": "<specific missing info>", "kind": "port|width|param|operation|connection|dtype|shape|control|timing", "where": "<part id, or 'global'>" }
  ],
  "fidelity": <0-100>,
  "fidelity_report": {
    "parameter_fidelity": [
      { "param": "<name>", "reference_value": "<from source, or 'unstated'>", "impl_value": "<what the impls used>", "match": true|false, "where": "<part id or 'global'>" }
    ],
    "property_checks": [
      { "property": "<named claim from the reference>", "status": "satisfied|violated|unverifiable", "evidence": "<one line>", "where": "<part id or 'global'>" }
    ],
    "structural_findings": ["<architectural divergence from the reference's described structure>", ...]
  },
  "summary": "<2-3 sentences: the biggest reproducibility gap AND the biggest fidelity gap>"
}`;
}

// A check that fails to RUN (syntax error, uncaught exception) carries no
// semantic signal — counting it as "the implementation is wrong" is what let a
// codegen typo (e.g. an invalid hex literal) silently halve a round's
// self-check score. Ask the model to repair ONLY what stops it running, once.
function fixHarnessPrompt(lang: { label: string; fence: string }, script: string, kind: string, stderr: string): string {
  return `The ${lang.label} self-checking program below failed to RUN because of a
${kind} error — NOT a logic failure. Fix ONLY what prevents it from executing.
Do NOT change the verification logic or the implementation's behavior. It must
still print exactly "VERIFIED" and exit 0 on success, or "FAIL: <reason and a
concrete counterexample>" and exit 1 on mismatch.

ERROR:
${(stderr || '').slice(0, 1500)}

PROGRAM:
\`\`\`${lang.fence}
${script}
\`\`\`

Return ONLY the corrected program in ONE fenced ${lang.fence} code block.`;
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

  // Arithmetic guard (the verifier's geom must be sound): before the engineers
  // ever read the spec, repair any fully-numeric derived constant that is
  // arithmetically wrong (e.g. a bad modular inverse). Otherwise a false fact in
  // the spec forces every faithful impl to either fail the self-check or
  // "diverge" — the loop could never reach a passing self-check. See arith-audit.
  let specRepairs: { path: string; claim: string; before: string; after: string }[] = [];
  {
    const audit = repairArithmeticClaims(scene);
    if (audit.repairs.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Object.assign(scene, audit.value as any);
      specRepairs = audit.repairs;
    }
  }
  const mode: string = scene.metadata?.mode || 'hardware';
  const n = opts.n !== undefined && Number.isFinite(opts.n) && opts.n > 0 ? Math.min(opts.n, 4) : 2;

  ensureWorkspace();
  const runDir = makeRunDir(id, 'reproduce', stamp());
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify(scene, null, 2));

  // Resolve the executable-verification backend automatically from the scene:
  // a CPU/GPU/FPGA/ASIC or any digital-compute design → SMT; a physical machine
  // → physics sim. `--backend` still forces a choice; selectBackend() also
  // honors an explicit metadata.backend override. No manual mode needed.
  const backendId = opts.backend || selectBackend(scene);
  const backend = getBackend(backendId);
  const avail: Availability = opts.noVerify
    ? { ok: false, reason: 'disabled via --no-verify' }
    : await backend.available();
  const backendInstructions = avail.ok ? backend.implementInstructions() : null;
  const lang = implLang(mode, avail.ok ? backend.language : null);

  console.log(`visually reproduce: ${id} (mode=${mode}) — ${n} independent reimplementations`);
  console.log(`  target language: ${lang.label}`);
  const how = opts.backend ? 'forced' : (scene.metadata?.backend ? 'from scene' : 'auto-selected');
  console.log(`  verify backend: ${backend.label} (${how}) — ${avail.ok ? `enabled (${avail.runner})` : `off (${avail.reason})`}`);
  console.log(`  run log → ${runDir}`);
  if (specRepairs.length) {
    console.log(`  ⚠ arithmetic guard corrected ${specRepairs.length} false constant(s) in the spec before reimplementation:`);
    for (const r of specRepairs) console.log(`      · ${r.path}: "${r.before}" → "${r.after}"`);
  }
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
        reimplementerPrompt(scene, perspectives[i % perspectives.length], backendInstructions, lang),
        opts.model,
        path.join(runDir, `impl-${i + 1}.txt`),
        parseImpl,
      ),
    ),
  );

  // Executable verification: actually run each implementation's self-check
  // through the backend (real ground truth, not just the judge's opinion).
  // We keep the counterexamples a failing check prints: those are exactly the
  // facts `amend` must write back into the spec, so the loop closes on hard
  // evidence, not only the judge's opinion.
  let verifiedCount = 0;
  let harnessErrors = 0; // checks that never produced a verdict (syntax/timeout/…)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const verifyFindings: any[] = [];
  for (let i = 0; i < impls.length; i++) {
    const im = impls[i];
    const ext = (im?.language === 'python') ? 'py' : 'v';
    if (typeof im?.implementation === 'string') {
      writeFileSync(path.join(runDir, `impl-${i + 1}.${ext}`), im.implementation);
    }
    let verdict = '';
    if (avail.ok && im && typeof im.script === 'string') {
      let res = await backend.verify(im.script, runDir);
      // ⑤ Harness recovery: a syntax/exception failure produced no verdict.
      // Repair it once so a codegen typo doesn't masquerade as a wrong impl.
      if (res.kind === 'syntax' || res.kind === 'error') {
        console.log(`  impl ${i + 1}: self-check ${res.kind} error — attempting one harness repair…`);
        try {
          const { text } = await runClaudeStreaming({
            prompt: fixHarnessPrompt(lang, im.script, res.kind, res.stderr || ''),
            model: opts.model, quiet: true,
          });
          const fixed = deescapeIfNeeded(extractFencedCode(text));
          if (fixed && fixed.trim()) {
            const res2 = await backend.verify(fixed, runDir);
            if (res2.kind === 'pass' || res2.kind === 'fail') {
              res = res2; im.script = fixed; im.implementation = fixed;
              // Keep the on-disk artifact consistent with what actually ran.
              writeFileSync(path.join(runDir, `impl-${i + 1}.${ext}`), fixed);
            }
          }
        } catch { /* keep the original (harness) result */ }
      }
      const kind = res.kind ?? (res.pass ? 'pass' : res.ran ? 'fail' : 'error');
      im._verify = { pass: res.pass, ran: res.ran, kind };
      const log = `pass=${res.pass} ran=${res.ran} kind=${kind}\n--- stdout ---\n${res.stdout || ''}\n--- stderr ---\n${(res.stderr || '').slice(0, 4000)}`;
      im._verifyLog = log;
      writeFileSync(path.join(runDir, `impl-${i + 1}-verify.txt`), log);
      if (res.pass) verifiedCount++;
      else if (kind !== 'fail') harnessErrors++;
      // The actionable signal a failing self-check carries: the "FAIL: …" line
      // (a concrete counterexample) the backend was instructed to print. A
      // harness error is NOT a counterexample — don't feed it to amend as if
      // the spec were wrong.
      const out = `${res.stdout || ''}\n${res.stderr || ''}`;
      const fail = out.split('\n').find((l) => /\bFAIL\b|counterexample|mismatch|assert/i.test(l));
      verifyFindings.push({
        impl: i + 1, pass: res.pass, ran: res.ran, kind,
        confidence: im?.confidence ?? null,
        counterexample: res.pass || kind !== 'fail' ? null : (fail ? fail.trim().slice(0, 400) : null),
      });
      const lbl = res.pass ? 'PASS ✓' : (kind === 'fail' ? 'FAIL' : `did not run (${kind})`);
      verdict = ` | self-verify: ${lbl}`;
    }
    console.log(`  impl ${i + 1}: confidence ${im?.confidence ?? '?'}, ` +
      `${(im?.guessed || []).length} guesses, ${(im?.underspecified || []).length} underspecified${verdict}`);
  }
  if (avail.ok) {
    const ran = impls.length - harnessErrors;
    console.log(`  executable self-verification: ${verifiedCount}/${impls.length} implementations passed` +
      (harnessErrors ? ` (${harnessErrors} did not run — harness error; ${verifiedCount}/${ran} of those that ran)` : ''));
  }

  console.log('  judging reproducibility + fidelity…');
  const report = await runAgent(judgePrompt(scene, lang.label, impls), opts.model,
    path.join(runDir, 'report.raw.txt'));
  report.backend = backend.id;
  report.executable_verification = avail.ok
    ? {
        enabled: true,
        passed: verifiedCount,
        total: impls.length,
        ran: impls.length - harnessErrors, // checks that reached a verdict
        harness_errors: harnessErrors, // syntax/timeout/exception — not semantic
      }
    : { enabled: false, reason: avail.reason };
  // Surface any false constants the arithmetic guard had to repair, so the loop
  // (and a human) can see the spec carried a self-inconsistent value.
  if (specRepairs.length) report.spec_repairs = specRepairs;
  // Hand the loop everything `amend` needs to write facts back into the spec:
  // what each implementer had to guess + the verifier's counterexamples. Keeps
  // refine from re-reading run files; works for every mode/backend.
  report.verify_findings = verifyFindings;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  report.guessed = (impls as any[]).flatMap((im) => im?.guessed || []).slice(0, 24);
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
        fidelity: Number.isFinite(Number(report.fidelity)) ? Number(report.fidelity) : undefined,
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
  console.log(`  ── reproducibility: ${report.reproducibility ?? '?'}/100  (${report.verdict ?? '?'})  ·  fidelity: ${report.fidelity ?? '?'}/100`);
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
  // Fidelity to the source (the "is it truly as in the paper?" axis).
  const fr = report.fidelity_report || {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paramMiss = (fr.parameter_fidelity || []).filter((p: any) => p && p.match === false);
  if (paramMiss.length) {
    console.log('\n  parameter fidelity (impl value ≠ what the source specifies):');
    for (const p of paramMiss.slice(0, 8)) console.log(`    · ${p.param}: source=${p.reference_value} vs impl=${p.impl_value}${p.where ? `  (${p.where})` : ''}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const propBad = (fr.property_checks || []).filter((p: any) => p && p.status !== 'satisfied');
  if (propBad.length) {
    console.log('\n  property checks (named claims from the source):');
    for (const p of propBad.slice(0, 8)) console.log(`    · [${p.status}] ${p.property}${p.evidence ? ` — ${p.evidence}` : ''}`);
  }
  if ((fr.structural_findings || []).length) {
    console.log('\n  structural findings (architecture vs the source):');
    for (const s of fr.structural_findings.slice(0, 8)) console.log(`    · ${s}`);
  }
  console.log(`\n  full report + each implementation → ${runDir}`);
  return report;
}
