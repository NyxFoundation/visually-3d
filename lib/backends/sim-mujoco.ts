// MuJoCo physics-simulation verification backend — the mechanical-hardware
// counterpart to python-smt. For robots, 3D printers, machines: "reproduce"
// means producing a buildable, simulatable model, and "verify" means running a
// headless physics rollout to check it actually loads, is physically valid, has
// real actuated DOF, and performs a basic task.
//
// Same pluggable interface as the other backends (see ./index.js). MuJoCo is
// auto-provisioned: plain `python3` if it imports mujoco, else
// `uv run --with mujoco python3` (no system install needed). Stepping physics is
// headless (no GL / no rendering required).

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Backend, VerifyResult } from '../types.js';
import { classifyFailure } from './python-smt.js';

const exec = promisify(execFile);

type Runner = { bin: string; pre: string[] };

let cachedRunner: Runner | null | undefined;

async function probe(bin: string, pre: string[]): Promise<Runner | null> {
  try {
    await exec(bin, [...pre, '-c', 'import mujoco'], { timeout: 180000 });
    return { bin, pre };
  } catch {
    return null;
  }
}

async function resolveRunner(): Promise<Runner | null> {
  if (cachedRunner !== undefined) return cachedRunner;
  cachedRunner =
    (await probe('python3', [])) ||
    (await probe('uv', ['run', '--with', 'mujoco', 'python3'])) ||
    null;
  return cachedRunner;
}

export const simMujocoBackend: Backend = {
  id: 'sim',
  label: 'MuJoCo (physics sim)',
  language: 'python',

  async available() {
    const r = await resolveRunner();
    if (!r) return { ok: false, reason: 'needs python3 with mujoco (`pip install mujoco`) or `uv`' };
    return { ok: true, runner: r.bin === 'uv' ? 'uv (--with mujoco)' : 'python3 (mujoco installed)' };
  },

  implementInstructions() {
    return `The runnable program must be a SINGLE self-contained, self-checking Python 3
script (stdlib + mujoco only) that BUILDS and SIMULATES the machine:
- Construct a MuJoCo MJCF model (an XML string) of the machine FROM THE SPEC:
  a <worldbody> with a floor and gravity; each major part -> a <body> with a
  <geom> (box/cylinder/sphere/capsule matching its shape & size); a <joint>
  (hinge/slide) wherever connected parts must move relative to each other; an
  <actuator> (motor/position) for each driven joint. Use
  <compiler inertiafromgeom="true"/> so masses/inertias come from the geoms.
- Load it HEADLESSLY: model = mujoco.MjModel.from_xml_string(MJCF);
  data = mujoco.MjData(model). DO NOT render / DO NOT import mujoco.viewer.
- Then VERIFY, in order, printing FAIL and sys.exit(1) at the first failure:
  L0 builds       — from_xml_string succeeds (valid kinematic tree, no errors).
  L1 valid physics— step ~1000 times under gravity; assert no NaN/Inf in
                    data.qpos/qvel and the model stays bounded (doesn't explode).
  L2 actuated DOF — commanding each actuator measurably moves its joint (the
                    degrees of freedom are real, not frozen/duplicated).
  L3 task         — a simple machine-appropriate function check, e.g. an arm's
                    end-effector reaches a target xyz within tolerance; a 3D
                    printer's toolhead body reaches the min & max of the build
                    volume on each axis; a legged/standing robot stays upright
                    (base height above a threshold) for the rollout.
- On success print exactly "VERIFIED" plus a one-line summary of L0-L3, exit 0.
Keep it deterministic and finish within ~60s.`;
  },

  async verify(script: string, dir: string): Promise<VerifyResult> {
    const r = await resolveRunner();
    if (!r) return { pass: false, ran: false, kind: 'no-runner', stderr: 'no mujoco runner available' };
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
      return { pass: false, ran: kind === 'fail', kind, stdout, stderr, code: e.code ?? 1 };
    }
  },
};
