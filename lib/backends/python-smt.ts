// Python + Z3 (SMT) verification backend.
//
// One unified, executable substrate for both algorithms and circuits:
//   - algorithm: a Python implementation checked against an independent golden
//     model via property tests and/or z3 over a bounded domain;
//   - circuit: the bit-precise semantics modelled as z3 BitVec functions and
//     proved equivalent to a golden model over ALL inputs (combinational) or up
//     to a bounded depth (sequential).
//
// It is a *backend* behind a common interface (see ./index.js) so other
// substrates — Lean 4 proofs, a Verilog simulator, CBMC — can be added later
// without touching the reproduce / co-improve loop.
//
// z3 is auto-provisioned: plain `python3` if it already imports z3, else
// `uv run --with z3-solver python3` (no system install needed).

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Backend, VerifyKind, VerifyResult } from '../types.js';

const exec = promisify(execFile);

// Classify a non-zero run into a HARNESS error (the check never produced a
// verdict) vs a semantic FAIL (it ran and reported a real counterexample). Pure
// so it is unit-testable. `killed`/SIGTERM is execFile's timeout signature.
export function classifyFailure(
  err: { killed?: boolean; signal?: string | null; message?: string },
  stdout: string,
  stderr: string,
): VerifyKind {
  const out = `${stdout}\n${stderr}`;
  if (err.killed || err.signal === 'SIGTERM' || /timed out|ETIMEDOUT/i.test(err.message || '')) {
    return 'timeout';
  }
  if (/\b(SyntaxError|IndentationError|TabError)\b/.test(out)) return 'syntax';
  // A clean self-check failure prints a "FAIL:" counterexample and exits 1.
  if (/\bFAIL\b/.test(stdout)) return 'fail';
  // An uncaught Python exception (traceback) is a broken check, not a verdict.
  if (/Traceback \(most recent call last\)/.test(stderr)) return 'error';
  return 'fail';
}

type Runner = { bin: string; pre: string[] };

let cachedRunner: Runner | null | undefined; // undefined = unprobed, null = unavailable

async function probe(bin: string, pre: string[]): Promise<Runner | null> {
  try {
    await exec(bin, [...pre, '-c', 'import z3'], { timeout: 120000 });
    return { bin, pre };
  } catch {
    return null;
  }
}

async function resolveRunner(): Promise<Runner | null> {
  if (cachedRunner !== undefined) return cachedRunner;
  cachedRunner =
    (await probe('python3', [])) ||
    (await probe('uv', ['run', '--with', 'z3-solver', 'python3'])) ||
    null;
  return cachedRunner;
}

export const pythonSmtBackend: Backend = {
  id: 'python-smt',
  label: 'Python + Z3 (SMT)',
  language: 'python',

  async available() {
    const r = await resolveRunner();
    if (!r) {
      return { ok: false, reason: 'needs python3 with z3 (`pip install z3-solver`) or `uv`' };
    }
    return { ok: true, runner: r.bin === 'uv' ? 'uv (--with z3-solver)' : 'python3 (z3 installed)' };
  },

  // Appended to the reimplementer prompt: what runnable artifact to produce.
  // (The reproduce prompt specifies HOW to deliver it — a fenced ```python block
  // — because embedding a whole program inside a JSON string mangles newlines.)
  implementInstructions() {
    return `The runnable program must be a SINGLE self-contained, self-checking Python 3
script (only stdlib + z3 allowed). Whatever the subject is — an algorithm, a
digital circuit, a data structure, a protocol — verify it with the SAME thinking
pattern, split into TWO TIERS, so the run always terminates fast with a real
verdict instead of timing out:

TIER 1 — SIZE-INDEPENDENT properties (this is where real generality comes from).
DECOMPOSE correctness into the local facts that must hold for EVERY size, and
prove each with z3 over bounded domains AT THE REAL BIT-WIDTHS / over every stride
or stage class — NOT at a toy size. Proven once, they hold for all N. The SAME
tactic spans subjects, e.g.: decode(encode(x)) == x for a codec; a sort step
preserves a permutation; one reducer over its full legal input range; one
butterfly / ALU op mod q; one FSM transition; one address/bank mapping is
conflict-free for every power-of-two stride; a data-structure invariant preserved
by an operation. These FAST, FINITE checks are exactly where large-N-only bugs
(overflow, address wrap, stride collisions) are caught — at full width,
symbolically, instead of by running big sizes.

TIER 2 — WHOLE-SYSTEM equivalence against an INDEPENDENT golden/reference model.
This is the only part whose cost grows with size, so run it ONLY at the SMALLEST
instance that still preserves the structure (valid roots, >= 2 stages, >= 2
banks/lanes) — a reduced N <= 16 (N <= 32 at most), with a small valid modulus if
needed. If the spec carries metadata.spec.verification.e2e_N, use THAT exact size.
NEVER build an O(N^2) golden — nor an exhaustive full-state search, nor an
all-input simulation — at the spec's PRODUCTION size, EVEN WHEN N is pinned large
(e.g. 1024). That is the #1 cause of timeouts and is forbidden by default.

PRODUCTION size: only structural invariants plus O(N log N) round-trip /
edge-case / randomized tests. Any genuinely full-size O(N^2)+ deep check must be
gated behind os.environ.get("DEEP_VERIFY") == "1" and skipped by default.

The script implements the system as plain Python functions, builds the
INDEPENDENT golden (derived from the spec, NOT copied from the implementation),
runs Tier 1 then Tier 2, and prints exactly "VERIFIED" and exits 0 once ALL
default checks pass, or "FAIL: <reason and a concrete counterexample>" and exits 1
at the first mismatch. Default verification must be deterministic and must
finish within ~60s on a cold run; never print "VERIFIED" before a required check
has completed, and never enable the expensive optional deep checks by default.`;
  },

  // Write the script and run it; pass = it printed VERIFIED and exited 0.
  async verify(script: string, dir: string): Promise<VerifyResult> {
    const r = await resolveRunner();
    if (!r) return { pass: false, ran: false, kind: 'no-runner', stderr: 'no python+z3 runner available' };
    if (typeof script !== 'string' || !script.trim()) {
      return { pass: false, ran: false, kind: 'no-script', stderr: 'no script produced' };
    }
    const file = path.join(dir, 'check.py');
    writeFileSync(file, script);
    try {
      const { stdout, stderr } = await exec(r.bin, [...r.pre, file],
        { timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
      const pass = stdout.includes('VERIFIED');
      return { pass, ran: true, kind: pass ? 'pass' : 'fail', stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; code?: number; killed?: boolean; signal?: string | null };
      const stdout = e.stdout || '';
      const stderr = e.stderr || e.message || '';
      const kind = classifyFailure(e, stdout, stderr);
      // Only a clean "FAIL" verdict means the check actually ran to a decision.
      return { pass: false, ran: kind === 'fail', kind, stdout, stderr, code: e.code ?? 1 };
    }
  },
};
