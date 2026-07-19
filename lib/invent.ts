// `visually invent <scene>` — the INVENT leg: a closed invention loop over a
// scene's ground-truth evidence. Each round:
//
//   1. hassou    — ideate concept candidates (C-expansions) from the evidence,
//                  generated with the five delta operators (subtraction, status
//                  change, re-representation, unification, decomposition) and a
//                  named contradiction; one atypical ingredient at a time;
//   2. jissou    — implement the chosen concept as a runnable self-checking
//                  program whose pass/fail tests the concept's PREDICTION;
//   3. verify    — the backend runs it: VERIFIED / falsified (an honest kill is
//                  a valid outcome, recorded) / inconclusive;
//   4. visualize — after a verified invention, the normal visual pass depicts
//                  it (the invention is appended to the scene's evidence notes
//                  so the source-grounded improve pass renders it).
//
// invent owns only the LOOP concerns: the concept log (never retry a tried
// concept — rotate operators instead), the variance budget (every third round
// relaxes the conventionality constraint), and honest outcome classification.
// Method background: lean4-speedup docs/invention-theory.md (protocol v2).

import { writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveScene, sceneIdFromPath, runDir as makeRunDir, ensureWorkspace, evidenceDir } from './paths.js';
import { runClaudeStreaming } from './runner.js';
import { parseImpl } from './reproduce.js';
import { getBackend, selectBackend } from './backends/index.js';
import { loadEvidence, evidenceExcerpt } from './evidence.js';
import { implDir } from './impls.js';
import { visualizeStep } from './visualize.js';

// ---------------------------------------------------------------------------
// Concept log (the boundary with model output is zod-parsed; the log on disk
// is too, since users may hand-edit it).

export const DELTA_OPERATORS = [
  'subtraction',
  'status-change',
  're-representation',
  'unification',
  'decomposition',
] as const;

const ConceptSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  operator: z.enum(DELTA_OPERATORS),
  phenomenon: z.string().min(1),   // the structure/regularity being harnessed
  delta: z.string().min(1),        // the ONE atypical ingredient vs the source
  prediction: z.string().min(1),   // falsifiable, checkable by a program
  sketch: z.string().min(1),       // how the implementation would work
}).loose();
export type Concept = z.infer<typeof ConceptSchema>;

const ConceptListSchema = z.object({ concepts: z.array(ConceptSchema).min(1) }).loose();

const LogEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  operator: z.string(),
  prediction: z.string(),
  status: z.enum(['verified', 'falsified', 'inconclusive', 'error']),
  round: z.number(),
  runDir: z.string(),
  savedAt: z.string(),
}).loose();
export type InventionLogEntry = z.infer<typeof LogEntrySchema>;
const LogSchema = z.array(LogEntrySchema);

export function inventionsDir(id: string): string {
  return path.join(implDir(id), 'inventions');
}

export function readInventionLog(id: string): InventionLogEntry[] {
  const f = path.join(inventionsDir(id), 'log.json');
  if (!existsSync(f)) return [];
  try {
    return LogSchema.parse(JSON.parse(readFileSync(f, 'utf8')));
  } catch {
    return [];
  }
}

function appendInventionLog(id: string, entry: InventionLogEntry): void {
  const dir = inventionsDir(id);
  mkdirSync(dir, { recursive: true });
  const log = readInventionLog(id);
  log.push(entry);
  writeFileSync(path.join(dir, 'log.json'), JSON.stringify(log, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Prompt builders (pure, unit-testable).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildIdeatePrompt(scene: any, evidence: string, tried: InventionLogEntry[], contradiction: string | undefined, wild: boolean): string {
  const triedBlock = tried.length
    ? `ALREADY TRIED (do NOT propose these again; prefer operators not yet used):\n${tried.map((t) => `  - [${t.status}] ${t.slug} (${t.operator}): ${t.prediction}`).join('\n')}`
    : '(nothing tried yet)';
  const usedOps = new Set(tried.map((t) => t.operator));
  const freshOps = DELTA_OPERATORS.filter((o) => !usedOps.has(o));
  const varianceBlock = wild
    ? `THIS IS A VARIANCE ROUND: the conventionality constraint is LIFTED. You may
combine two atypical ingredients, or negate an assumption the source treats as
untouchable. Expect a low hit rate; the goal is the tail, not the mean.`
    : `Keep a CONVENTIONAL core: exactly ONE atypical ingredient per concept
(the highest-impact pattern — Uzzi 2013). Everything else stays faithful to the
source's engineering.`;

  return `You are running the HASSOU (ideation) step of an invention loop over a real,
existing system. Your job is to generate INVENTION CONCEPTS: propositions that are
genuinely NEW relative to the source below (not bug fixes, not tuning), each
harnessing a nameable phenomenon and making a falsifiable prediction that a small
program can check.

THE SOURCE (ground truth — your conventional core):
\`\`\`markdown
${evidence}
\`\`\`

SYSTEM: ${String(scene?.machine_name ?? 'unknown')}

${contradiction ? `THE NAMED CONTRADICTION (invent at this site — resolve it WITHOUT compromise):\n  ${contradiction}` : `First, NAME the sharpest contradiction in this system (improving A degrades B),
then invent at that site.`}

GENERATORS — apply the five delta operators (the recurring deltas of great
inventions; use each unused one at least once${freshOps.length ? `; unused so far: ${freshOps.join(', ')}` : ''}):
  1. subtraction        — remove the component everyone assumes is necessary
  2. status-change      — promote a measured regularity of the workload/data to a
                          design axiom, and design as if it always holds (repair
                          the rare violations)
  3. re-representation  — restate the working system at a different abstraction
                          level so a new structure becomes visible
  4. unification        — find one mechanism where the source needs two
  5. decomposition      — operationalize a concept the source treats as atomic

${varianceBlock}

${triedBlock}

Return ONLY a JSON object in one fenced \`\`\`json block:
{"concepts": [{
  "slug": "kebab-case-id",
  "name": "short name",
  "operator": "subtraction|status-change|re-representation|unification|decomposition",
  "phenomenon": "the structure/symmetry/regularity being harnessed, stated precisely",
  "delta": "the ONE thing that differs from the source (or two, on a variance round)",
  "prediction": "a falsifiable, machine-checkable claim (numbers, equalities, bounds)",
  "sketch": "how a small program would implement and check it"
}, ...]}   — 3 to 6 concepts, strongest first.`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildImplementPrompt(scene: any, concept: Concept, evidence: string, backendInstructions: string): string {
  return `You are running the JISSOU (implementation) step of an invention loop. Implement
the invention concept below as a runnable, SELF-CHECKING program, and make its
pass/fail verdict test the concept's PREDICTION — honestly. If the prediction is
false, the program must FAIL with the counterexample: a falsified invention is a
valid, valuable outcome. Do NOT weaken the check to force a pass.

${backendInstructions}

THE INVENTION CONCEPT:
  name:        ${concept.name}
  operator:    ${concept.operator}
  phenomenon:  ${concept.phenomenon}
  delta:       ${concept.delta}
  prediction:  ${concept.prediction}
  sketch:      ${concept.sketch}

THE SOURCE it deviates from (ground truth for everything except the delta):
\`\`\`markdown
${evidence}
\`\`\`

SYSTEM: ${String(scene?.machine_name ?? 'unknown')}

CONTRACT — the program must:
  1. implement the invention faithfully to the concept (the delta is the point);
  2. implement the SOURCE's baseline where needed for comparison;
  3. check the PREDICTION rigorously (proof/exhaustive where feasible; measured
     comparison with stated margins where the claim is quantitative);
  4. print exactly "VERIFIED" (exit 0) if the prediction holds, or
     "FAIL: <reason + counterexample>" if it does not.

Return the complete program as your FINAL message in ONE fenced code block and
NOTHING else. Do NOT write it to a file, do NOT run it.`;
}

export function buildInventFixPrompt(concept: Concept, prevScript: string, output: string, backendInstructions: string): string {
  return `Your implementation of the invention "${concept.name}" did not run cleanly. Fix
IMPLEMENTATION problems (syntax errors, crashes, timeouts, wrong harness) — but do
NOT weaken the prediction check: if the run produced a genuine counterexample to
the prediction ("${concept.prediction}"), the invention is FALSIFIED and the
program SHOULD fail — leave the check honest and say so.

ITS OUTPUT:
${(output || '(no output)').slice(0, 3000)}

PREVIOUS PROGRAM:
\`\`\`
${prevScript.slice(0, 12000)}
\`\`\`

(Backend rules, unchanged:)
${backendInstructions}

Return ONLY the full corrected program in ONE fenced code block.`;
}

// Extract the fenced JSON concept list from the ideation reply.
export function parseConcepts(text: string): Concept[] {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/m.exec(text);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf('{');
  if (start < 0) return [];
  try {
    const parsed = ConceptListSchema.parse(JSON.parse(raw.slice(start)));
    return parsed.concepts;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The loop.

interface InventOpts {
  positional: string[];
  rounds?: number;
  contradiction?: string;
  concept?: string;
  model?: string;
  driver?: string;
  backend?: string;
  noVisual?: boolean;
  attempts?: number;
}

function parseArgs(argv: string[]): InventOpts {
  const opts: InventOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rounds') opts.rounds = Number(argv[++i]);
    else if (a === '--contradiction') opts.contradiction = argv[++i];
    else if (a === '--concept') opts.concept = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--driver') opts.driver = argv[++i];
    else if (a === '--backend') opts.backend = argv[++i];
    else if (a === '--attempts') opts.attempts = Number(argv[++i]);
    else if (a === '--no-visual') opts.noVisual = true;
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

// A verified invention becomes part of the scene's evidence, so the next
// visualize pass renders the invented structure (the perception channel).
function appendInventionToEvidence(id: string, concept: Concept, round: number): void {
  const dir = evidenceDir(id);
  mkdirSync(dir, { recursive: true });
  const block = `\n\n## Invented (verified) — ${concept.name} [round ${round}, ${new Date().toISOString().slice(0, 10)}]\n` +
    `- operator: ${concept.operator}\n- phenomenon: ${concept.phenomenon}\n` +
    `- delta vs source: ${concept.delta}\n- verified prediction: ${concept.prediction}\n`;
  appendFileSync(path.join(dir, 'notes.md'), block);
}

export async function inventStep(
  id: string,
  opts: Omit<InventOpts, 'positional'> = {},
): Promise<{ verified: Concept[]; rounds: number }> {
  const target = resolveScene(id);
  if (!target) throw new Error(`no such scene: ${id}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene: any = JSON.parse(readFileSync(target, 'utf8'));

  const ev = loadEvidence(id);
  if (ev.origin === 'none') {
    throw new Error(`no source evidence for "${id}" — run \`visually visualize ${id}\` first; invention needs a conventional core to deviate from.`);
  }
  const evidence = evidenceExcerpt(ev, 14000);

  const backend = getBackend(opts.backend || selectBackend(scene));
  const avail = await backend.available();
  if (!avail.ok) throw new Error(`invent backend unavailable: ${avail.reason}`);

  ensureWorkspace();
  const maxRounds = opts.rounds && opts.rounds > 0 ? opts.rounds : 3;
  const implAttempts = opts.attempts && opts.attempts > 0 ? Math.min(opts.attempts, 6) : 3;
  const ext = backend.language === 'python' ? 'py' : 'v';
  const verified: Concept[] = [];

  console.log(`visually invent: ${id} — invention loop (hassou → jissou → verify → visualize)`);
  console.log(`  backend ${backend.label} · up to ${maxRounds} round(s) · every 3rd round lifts the conventionality constraint\n`);

  for (let round = 1; round <= maxRounds; round++) {
    const wild = round % 3 === 0;
    const tried = readInventionLog(id);
    const dir = makeRunDir(id, 'invent', stamp());
    mkdirSync(dir, { recursive: true });
    console.log(`════════ invent round ${round}/${maxRounds}${wild ? ' (variance round)' : ''} ════════`);

    // 1. HASSOU — ideate (or take the forced concept on round 1).
    if (opts.concept && round === 1) {
      const prev = tried.find((t) => t.slug === opts.concept);
      if (prev) console.log(`  · --concept ${opts.concept} was already tried (${prev.status}) — re-running it`);
    }
    console.log(`▶ hassou — ideating…`);
    const ideatePrompt = buildIdeatePrompt(scene, evidence, tried, opts.contradiction, wild);
    writeFileSync(path.join(dir, 'ideate-prompt.txt'), ideatePrompt);
    const { text: ideaText } = await runClaudeStreaming({ prompt: ideatePrompt, model: opts.model, runDir: dir, quiet: true });
    const concepts = parseConcepts(ideaText);
    writeFileSync(path.join(dir, 'concepts.json'), JSON.stringify(concepts, null, 2) + '\n');
    if (!concepts.length) {
      console.log(`  ⚠ no parseable concepts returned — skipping round`);
      continue;
    }
    const triedSlugs = new Set(tried.map((t) => t.slug));
    const concept = (opts.concept && round === 1 ? concepts.find((c) => c.slug === opts.concept) : undefined)
      ?? concepts.find((c) => !triedSlugs.has(c.slug))
      ?? concepts[0];
    console.log(`  concept: ${concept.name} [${concept.operator}]`);
    console.log(`  prediction: ${concept.prediction}`);

    // 2. JISSOU + 3. VERIFY — implement, run, classify honestly.
    console.log(`▶ jissou — implementing + verifying (${implAttempts} attempt(s))…`);
    let status: InventionLogEntry['status'] = 'error';
    let prevScript = '';
    let lastLog = '';
    for (let attempt = 1; attempt <= implAttempts; attempt++) {
      const prompt = attempt === 1
        ? buildImplementPrompt(scene, concept, evidence, backend.implementInstructions())
        : buildInventFixPrompt(concept, prevScript, lastLog, backend.implementInstructions());
      writeFileSync(path.join(dir, `impl-prompt-${attempt}.txt`), prompt);
      const { text } = await runClaudeStreaming({ prompt, model: opts.model, runDir: dir, quiet: true });
      const impl = parseImpl(text);
      if (typeof impl.script !== 'string' || !impl.script.trim()) {
        lastLog = '(no fenced program returned)';
        console.log(`  · attempt ${attempt}/${implAttempts}: no program returned`);
        continue;
      }
      prevScript = impl.script;
      writeFileSync(path.join(dir, `impl-${attempt}.${ext}`), impl.script);
      const res = await backend.verify(impl.script, dir);
      lastLog = `${res.stdout || ''}\n${res.stderr || ''}`;
      if (res.pass) { status = 'verified'; break; }
      if (res.ran && /FAIL:/.test(res.stdout || '')) {
        // The program ran and the prediction check failed — an honest kill,
        // unless a later attempt shows it was an implementation bug.
        status = 'falsified';
        console.log(`  · attempt ${attempt}/${implAttempts}: prediction FAILED — ${attempt < implAttempts ? 'one repair pass to rule out impl bugs…' : 'recorded as falsified'}`);
      } else {
        status = 'inconclusive';
        console.log(`  · attempt ${attempt}/${implAttempts}: did not run cleanly — ${attempt < implAttempts ? 'revising…' : 'giving up'}`);
      }
    }

    // Persist the concept outcome.
    const slugDir = path.join(inventionsDir(id), concept.slug);
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(path.join(slugDir, `impl.${ext}`), prevScript);
    writeFileSync(path.join(slugDir, 'concept.json'), JSON.stringify(concept, null, 2) + '\n');
    writeFileSync(path.join(slugDir, 'verify.txt'), lastLog.slice(0, 20000));
    appendInventionLog(id, {
      slug: concept.slug, name: concept.name, operator: concept.operator,
      prediction: concept.prediction, status, round, runDir: dir,
      savedAt: new Date().toISOString(),
    });
    console.log(`  ${status === 'verified' ? '✓ VERIFIED' : status === 'falsified' ? '✗ falsified (honest kill — recorded)' : `△ ${status}`}: ${concept.slug}`);

    // 4. VISUALIZE — a verified invention joins the evidence and gets rendered.
    if (status === 'verified') {
      verified.push(concept);
      appendInventionToEvidence(id, concept, round);
      if (!opts.noVisual) {
        console.log(`▶ visualize — rendering the invented structure…`);
        try {
          await visualizeStep(id, { iters: 1, model: opts.model, driver: opts.driver });
        } catch (err) {
          console.log(`  ⚠ visualize stopped: ${(err as Error).message}`);
        }
      }
    }
  }

  const log = readInventionLog(id);
  console.log(`\ninvent: ${verified.length} verified / ${log.filter((l) => l.status === 'falsified').length} falsified / ${log.length} total concepts tried.`);
  if (verified.length) console.log(`verified inventions:\n${verified.map((c) => `  ✓ ${c.name} — ${c.prediction}`).join('\n')}`);
  else console.log(`no verified invention yet — falsifications are recorded in the log (they narrow the space); re-run for more rounds.`);
  return { verified, rounds: maxRounds };
}

export async function invent(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) {
    throw new Error('usage: visually invent <scene> [--rounds N] [--contradiction "…"] [--concept <slug>] [--attempts N] [--model <m>] [--driver claude|codex] [--backend <id>] [--no-visual]');
  }
  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  await inventStep(sceneIdFromPath(target), opts);
}
