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
import type { Backend, VerifyResult } from '../types.js';

const exec = promisify(execFile);

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
script (only stdlib + z3 allowed) that:
- implements the system as plain Python functions;
- builds an INDEPENDENT golden/reference model of the intended behavior;
- VERIFIES the implementation against that golden — for finite / bit-bounded
  logic, prove equivalence over ALL inputs with z3 ("from z3 import *"); for
  larger domains, run thorough randomized + edge-case property tests;
- prints exactly "VERIFIED" and exits 0 on success, or prints "FAIL: <reason and
  a concrete counterexample>" and exits 1 on any mismatch.
It must be deterministic and finish within ~60s.`;
  },

  // Write the script and run it; pass = it printed VERIFIED and exited 0.
  async verify(script: string, dir: string): Promise<VerifyResult> {
    const r = await resolveRunner();
    if (!r) return { pass: false, ran: false, stderr: 'no python+z3 runner available' };
    if (typeof script !== 'string' || !script.trim()) {
      return { pass: false, ran: false, stderr: 'no script produced' };
    }
    const file = path.join(dir, 'check.py');
    writeFileSync(file, script);
    try {
      const { stdout, stderr } = await exec(r.bin, [...r.pre, file],
        { timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
      return { pass: stdout.includes('VERIFIED'), ran: true, stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
      return {
        pass: false, ran: true,
        stdout: e.stdout || '', stderr: e.stderr || e.message || '', code: e.code ?? 1,
      };
    }
  },
};
