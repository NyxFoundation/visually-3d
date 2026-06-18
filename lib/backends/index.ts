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
// Always overridable with --backend. Coarse (mode-only) — prefer selectBackend()
// which also looks at WHAT the hardware is.
export function defaultBackendFor(mode: string): string {
  return mode === 'algorithm' ? 'python-smt' : 'sim';
}

// Whether a "hardware" subject is a DIGITAL/COMPUTE design (CPU/GPU/FPGA/ASIC,
// a datapath, a crypto/DSP core) — whose substance is bit-precise logic best
// checked by SMT — versus a PHYSICAL/MECHANICAL machine (robot, printer,
// turbine) whose substance is motion, checked by the physics sim.
const DIGITAL_RE = /\b(cpu|gpu|gpgpu|fpga|asic|soc|npu|tpu|vpu|dpu|ipu|processor|microprocessor|microcontroller|micro-?architecture|accelerator|datapath|\balu\b|register[ -]?file|pipeline|opcode|systolic|tensor[ -]?core|\bntt\b|\bintt\b|\bfft\b|crypto|cipher|\baes\b|sha-?\d|keccak|poly1305|risc-?v|\brisc\b|\bisa\b|verilog|vhdl|\brtl\b|netlist|logic[ -]?gate|lookup[ -]?table|\blut\b|\bdsp\b|\bbram\b|\bsram\b|butterfly|barrett|montgomery|crossbar|arithmetic[ -]?logic|register[ -]?transfer|\bpll\b|transformer|attention|convolution[ -]?engine|inference[ -]?engine|matrix[ -]?multiply|\bgemm\b|\bsimd\b|chiplet|\bvlsi\b|semiconductor|out-?of-?order|superscalar|\bcore\b)\b/i;
const MECHANICAL_RE = /\b(robot|gripper|manipulator|prosthetic|exoskeleton|3d[ -]?printer|extruder|turbine|\bengine\b|motor|gearbox|\bgear\b|drone|quadcopter|quadrotor|aircraft|helicopter|rover|tractor|locomotive|\bvehicle\b|\bcar\b|\bev\b|chassis|piston|valve|pump|actuator|linkage|mechanism|hydraulic|pneumatic|bearing|propeller|\brotor\b|suspension|crankshaft|camshaft|nozzle|conveyor|servo|spindle|lathe|\bmill\b|wing|landing[ -]?gear|fuselage|ventilator|submarine|excavator|crane|spacecraft|satellite|cubesat|turbofan)\b/i;

// The SUBJECT of the scene — its title/identity. This dominates classification:
// a physical machine (a drone, a tractor) routinely contains a microcontroller,
// but its substance is motion, not logic. The incidental digital parts must not
// flip it; the noun in the name decides.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function subjectText(scene: any): string {
  const info = scene?.metadata?.info ?? {};
  return [scene?.machine_name, info.english_name, info.japanese_name, scene?.metadata?.domain]
    .filter(Boolean).join(' ').toLowerCase();
}

// The full text (subject + summaries + part names/roles) — the tie-breaker when
// the subject noun alone is ambiguous.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fullText(scene: any): string {
  const info = scene?.metadata?.info ?? {};
  const partWords = Array.isArray(scene?.parts)
    ? scene.parts.map((p: { name?: string; role?: string }) => `${p?.name ?? ''} ${p?.role ?? ''}`).join(' ')
    : '';
  return [subjectText(scene), info.summary, info.description, info.description2, partWords]
    .filter(Boolean).join(' ').toLowerCase();
}

// Auto-select the verification substrate from the scene itself, so a user never
// has to pick: a mechanical blueprint → physics sim, a CPU/GPU/FPGA/ASIC or any
// digital-compute design → SMT. Precedence:
//   1. an explicit scene override (metadata.backend) — manual escape hatch;
//   2. algorithm mode → SMT (code); architecture → sim (buildings);
//   3. the SUBJECT noun decides — mechanical title → sim, digital title → SMT
//      (so a drone with a flight controller stays sim);
//   4. ambiguous subject → full text, digital wins (an accelerator board with a
//      heatsink is still logic);
//   5. anything unclassifiable → the mode default.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function selectBackend(scene: any): string {
  const override = scene?.metadata?.backend;
  if (typeof override === 'string' && override) return override;

  const mode: string = scene?.metadata?.mode || 'hardware';
  if (mode === 'algorithm') return 'python-smt';
  if (mode === 'architecture') return 'sim';

  // The subject noun is decisive: physical machines embed controllers but are
  // still physical; a clearly-digital title is still digital.
  const subject = subjectText(scene);
  const subjMech = MECHANICAL_RE.test(subject);
  const subjDigital = DIGITAL_RE.test(subject);
  if (subjMech && !subjDigital) return 'sim';
  if (subjDigital && !subjMech) return 'python-smt';

  // Subject ambiguous (or mixed) → fall to full text, digital wins ties.
  const text = fullText(scene);
  if (DIGITAL_RE.test(text)) return 'python-smt';
  if (MECHANICAL_RE.test(text)) return 'sim';
  return defaultBackendFor(mode);
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
