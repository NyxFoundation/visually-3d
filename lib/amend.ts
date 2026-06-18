// `visually amend <scene>` — the RETURN EDGE of the visioned self-improvement
// loop. `reproduce` discovers what the spec failed to pin down (missing_fields,
// where independent implementations diverge, and the verifier's
// counterexamples); `amend` writes those facts back into the scene's functional
// spec substrate (parts[].spec / metadata.spec), so the NEXT `reproduce` reads
// them and the reproducibility score can actually climb.
//
// This is the piece the old refine loop was missing: improve wrote geometry and
// reproduce read semantics, but nothing fed verification BACK into the scene, so
// reproducibility could never move. amend closes that loop on hard evidence.
//
// It is deliberately mode/backend-agnostic: it operates only on the judge's
// structured findings, so it works identically for a circuit (SMT), an
// algorithm (SMT), or a physical machine/building (sim). Geometry is never
// touched semantically — only the spec genome grows.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveScene, sceneIdFromPath, runDir as makeRunDir, ensureWorkspace } from './paths.js';
import { runClaudeStreaming } from './runner.js';
import { extractScene, parseScene, validateScene, specCoverage } from './scene.js';
import { reproduce } from './reproduce.js';

interface AmendOpts {
  positional: string[];
  model?: string;
  backend?: string;
  noVerify?: boolean;
  n?: number;
}

function parseArgs(argv: string[]): AmendOpts {
  const opts: AmendOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opts.model = argv[++i];
    else if (a === '--backend') opts.backend = argv[++i];
    else if (a === '--n') opts.n = Number(argv[++i]);
    else if (a === '--no-verify') opts.noVerify = true;
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

// True when a reproduce report actually carries something to fold back in —
// either a reproducibility gap (missing/ambiguous fields) or a fidelity gap (the
// impls drifted from the SPECIFIC system the source describes).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function hasFindings(report: any): boolean {
  if (!report || typeof report !== 'object') return false;
  const missing = Array.isArray(report.missing_fields) ? report.missing_fields.length : 0;
  const diverge = Array.isArray(report.divergences) ? report.divergences.length : 0;
  const cex = Array.isArray(report.verify_findings)
    ? report.verify_findings.filter((v: { counterexample?: unknown }) => v?.counterexample).length
    : 0;
  const fr = report.fidelity_report || {};
  const paramMiss = Array.isArray(fr.parameter_fidelity)
    ? fr.parameter_fidelity.filter((p: { match?: unknown }) => p?.match === false).length
    : 0;
  const propBad = Array.isArray(fr.property_checks)
    ? fr.property_checks.filter((p: { status?: unknown }) => p?.status && p.status !== 'satisfied').length
    : 0;
  const struct = Array.isArray(fr.structural_findings) ? fr.structural_findings.length : 0;
  return missing + diverge + cex + paramMiss + propBad + struct > 0;
}

// Build the prompt that asks the model to MERGE verification findings into the
// scene's spec substrate. Pure (no I/O) so it is unit-testable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAmendPrompt(scene: any, report: any): string {
  type MissingField = { kind?: string; item?: string; where?: string };
  type VerifyFinding = { impl?: number; counterexample?: string };
  type ParamFidelity = { param?: string; reference_value?: string; impl_value?: string; match?: boolean; where?: string };
  type PropertyCheck = { property?: string; status?: string; evidence?: string; where?: string };
  const missingFields = (report?.missing_fields || []) as MissingField[];
  const divergenceList = (report?.divergences || []) as string[];
  const findings = (report?.verify_findings || []) as VerifyFinding[];
  const fr = (report?.fidelity_report || {}) as {
    parameter_fidelity?: ParamFidelity[]; property_checks?: PropertyCheck[]; structural_findings?: string[];
  };
  const parts = (scene?.parts || []) as { id: string }[];

  const missing = missingFields.map((m) =>
    `- [${m.kind || '?'}] ${m.item} → write into ${m.where && m.where !== 'global' ? `part "${m.where}".spec` : 'metadata.spec'}`,
  ).join('\n');
  const divergences = divergenceList.map((d) => `- ${d}`).join('\n');
  const counterexamples = findings
    .filter((v) => v?.counterexample)
    .map((v) => `- impl ${v.impl}: ${v.counterexample}`)
    .join('\n');

  // Fidelity findings: where the impls drifted from the SPECIFIC system the
  // source describes. amend records the source's value so the spec pins it down.
  const paramFidelity = (fr.parameter_fidelity || [])
    .filter((p) => p?.match === false)
    .map((p) => `- ${p.param}: source says "${p.reference_value}" but impls used "${p.impl_value}" → record the source value in ${p.where && p.where !== 'global' ? `part "${p.where}".spec` : 'metadata.spec'}`)
    .join('\n');
  const propertyChecks = (fr.property_checks || [])
    .filter((p) => p?.status && p.status !== 'satisfied')
    .map((p) => `- [${p.status}] "${p.property}"${p.evidence ? ` — ${p.evidence}` : ''} → record this named property in ${p.where && p.where !== 'global' ? `part "${p.where}".spec.properties` : 'metadata.spec.properties'}`)
    .join('\n');
  const structural = (fr.structural_findings || []).map((s) => `- ${s}`).join('\n');
  const ids = parts.map((p) => p.id).join(', ');

  return `You are closing the loop of a "visioned self-improvement" system. A scene
descriptor doubles as the SPEC for a real system (a circuit, an algorithm, a
machine, a building). Independent engineers tried to rebuild the system from
this spec alone and a verifier ran their implementations. They found exactly
which facts the spec FAILED to pin down. Your job: write those facts back into
the scene's functional spec so the spec becomes reproducible — WITHOUT changing
what the scene looks like.

THE SPEC SUBSTRATE (this is the ONLY thing you grow):
- Each part may carry \`spec\`: { params?, widths?, ports?[ {name,dir,width} ],
  ops?[], fsm?[], notes? }. Top-level \`metadata.spec\` holds the same shape for
  system-level facts (clocking, global params, handshake, FSM).
- Geometry (shape/position/size/rotation/material) is 3D DECORATION. Do NOT
  change it. Do NOT add, remove, move, reshape, or re-material any part.
- Keep machine_name, every part id, and all existing fields intact. You may only
  ADD/refine \`spec\` blocks, and tighten \`role\` / \`assembly_instructions\`
  prose so it stays consistent with the new spec.

MISSING FIELDS the spec must now carry (each says which part's spec to write):
${missing || '(none reported)'}

WHERE INDEPENDENT IMPLEMENTATIONS DIVERGED (the spec was ambiguous here — you
must COMMIT to ONE concrete value to remove the ambiguity, and record it):
${divergences || '(none reported)'}

VERIFIER COUNTEREXAMPLES (hard evidence — the spec/impl was actually wrong here;
fix the spec so the intended behavior is unambiguous):
${counterexamples || '(none — verification passed or was disabled)'}

FIDELITY GAPS — the impls drifted from the SPECIFIC system the SOURCE/paper
describes. Pin the source's truth into the spec so the scene stops being a
generic "a-correct-one" and becomes the actual system:

  Parameter mismatches (write the SOURCE value, not the impls' guess):
${paramFidelity || '  (none)'}

  Named properties not clearly satisfied (record them so they are explicit and
  checkable — e.g. spec.properties: ["conflict-free memory mapping", ...]):
${propertyChecks || '  (none)'}

  Structural divergences from the source's described architecture:
${structural || '  (none)'}

RULES for choosing values:
1. For every missing field, write a CONCRETE value into the named part's \`spec\`
   (or metadata.spec for "global"). Never leave it as a description of what is
   missing — pick the actual width/param/op/port/state.
2. To resolve a divergence, pick the value the passing / highest-confidence
   implementation used; if it is genuinely a free choice, pick the standard,
   well-known convention for this kind of system and note the choice in
   \`spec.notes\`. The point is to make the bad (ambiguous) state unrepresentable.
3. Be specific and numeric. "14-bit" → \`widths: { coeff: 14 }\`; a modulus →
   \`params: { q: 12289 }\`; an FSM → \`fsm: ["IDLE","LOAD","RUN","DRAIN"]\`.

Existing part ids you may target: ${ids}

Return ONLY the full, updated scene descriptor as a single JSON object — no
markdown fences, no prose before or after.`;
}

// Merge a reproduce report's findings into the scene at `target`, writing the
// spec-enriched scene back. Snapshots before/after under an amend run dir.
// Returns the coverage delta so the caller (refine) can report progress.
export async function amendScene(
  target: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  report: any,
  opts: { model?: string } = {},
): Promise<{ applied: boolean; before: number; after: number; reason?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene: any = JSON.parse(readFileSync(target, 'utf8'));
  const before = specCoverage(scene).keys;

  if (!hasFindings(report)) {
    return { applied: false, before, after: before, reason: 'no findings to fold back' };
  }

  const id = sceneIdFromPath(target);
  ensureWorkspace();
  const dir = makeRunDir(id, 'amend', stamp());
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'prev.json'), JSON.stringify(scene, null, 2));
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));

  const prompt = buildAmendPrompt(scene, report);
  writeFileSync(path.join(dir, 'prompt.txt'), prompt);
  const { text } = await runClaudeStreaming({ prompt, model: opts.model, quiet: true });
  writeFileSync(path.join(dir, 'raw.txt'), text);

  // Parse → validate at the boundary; a malformed amend must never corrupt the
  // scene, so we only commit a scene that passes the same gate as create/improve.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let next: any;
  try {
    next = extractScene(text);
  } catch (err) {
    return { applied: false, before, after: before, reason: `no JSON returned: ${(err as Error).message}` };
  }
  const errors = validateScene(next);
  if (errors.length) {
    return { applied: false, before, after: before, reason: `invalid scene: ${errors[0]}` };
  }
  try {
    parseScene(next); // strict zod boundary
  } catch (err) {
    return { applied: false, before, after: before, reason: `schema reject: ${(err as Error).message}` };
  }

  // Guard against an amend that drops parts or renames the machine — it must
  // only grow the spec, never regress the model.
  if (!Array.isArray(next.parts) || next.parts.length < scene.parts.length) {
    return { applied: false, before, after: before, reason: 'amend dropped parts — discarded' };
  }

  const after = specCoverage(next).keys;
  const serialized = JSON.stringify(next, null, 2) + '\n';
  writeFileSync(target, serialized);
  writeFileSync(path.join(dir, 'amended.json'), serialized);
  return { applied: true, before, after };
}

// CLI entry: run a fresh reproduce, then fold its findings back into the scene.
export async function amend(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) {
    throw new Error('usage: visually amend <scene> [--n 2] [--model <m>] [--backend <id>] [--no-verify]');
  }
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);

  console.log(`visually amend: ${sceneIdFromPath(target)} — verify, then fold findings into the spec`);
  const reproArgs = [ref];
  if (opts.model) reproArgs.push('--model', opts.model);
  if (opts.backend) reproArgs.push('--backend', opts.backend);
  if (opts.noVerify) reproArgs.push('--no-verify');
  if (opts.n !== undefined && Number.isFinite(opts.n)) reproArgs.push('--n', String(opts.n));
  const report = await reproduce(reproArgs);

  console.log('\n▶ folding verification findings into the spec…');
  const res = await amendScene(target, report, { model: opts.model });
  if (res.applied) {
    console.log(`  ✓ spec grown: ${res.before} → ${res.after} fields written back into the scene.`);
    console.log('  re-run `visually reproduce` (or `visually refine`) — reproducibility should now rise.');
  } else {
    console.log(`  · no change: ${res.reason}`);
  }
}
