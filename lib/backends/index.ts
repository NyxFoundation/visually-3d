// Pluggable implementation/verification backends for `reproduce` (and the
// future 3D ⇄ implementation co-improvement loop).
//
// A backend turns "implement this spec and check it" into a concrete language
// plus an executable verifier, behind one interface so the loop stays
// substrate-agnostic. Today: python-smt. Later, drop in more by registering
// them here — they must implement the same shape:
//
//   {
//     id, label, language,
//     available():            Promise<{ ok, runner?, reason? }>   // toolchain probe
//     implementInstructions(): string   // appended to the implementer prompt
//     verify(artifact, dir):  Promise<{ pass, ran, stdout?, stderr?, code? }>
//   }
//
// Planned backends (same interface, additive):
//   - lean        — Lean 4: implementer writes Lean + a correctness theorem;
//                   verify runs `lake build` / `lean` so the proof must check.
//   - verilog-sim — iverilog/verilator against a golden testbench.
//   - cbmc        — SAT-based bounded model checking of C/Verilog.

import type { Backend } from '../types.js';
import { pythonSmtBackend } from './python-smt.js';
import { simMujocoBackend } from './sim-mujoco.js';

const REGISTRY: Record<string, Backend> = {
  [pythonSmtBackend.id]: pythonSmtBackend, // algorithms / circuits → proof / SMT
  [simMujocoBackend.id]: simMujocoBackend, // robots / 3D printers / machines → physics sim
};

export const DEFAULT_BACKEND = 'python-smt';

// Pick the natural verification substrate for a generation mode: algorithms get
// SMT/execution; physical machines (hardware/architecture) get physics sim.
// Always overridable with --backend.
export function defaultBackendFor(mode: string): string {
  return mode === 'algorithm' ? 'python-smt' : 'sim';
}

export function getBackend(id: string = DEFAULT_BACKEND): Backend {
  const backend = REGISTRY[id];
  if (!backend) {
    throw new Error(`unknown backend "${id}" (available: ${Object.keys(REGISTRY).join(', ')})`);
  }
  return backend;
}

export function listBackends(): string[] {
  return Object.keys(REGISTRY);
}
