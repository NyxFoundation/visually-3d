#!/usr/bin/env python3
"""
Self-checking MuJoCo build+sim of the CFNTT Radix-2/4 NTT accelerator (FPGA),
reconstructed FROM THE SCENE SPEC ALONE.

The real subject is a static FPGA datapath, so there are no genuine moving
parts. We faithfully place every major block as a rigid body/geom, then add 3
synthetic articulated DOFs that stand in for the only "motions" implied by the
spec's exploded/assembly views plus operand dataflow:
  * heatsink explode      (slide, vertical)
  * exploded BU cluster   (slide, vertical)
  * operand "shuttle"     (slide, along the read/return datapath bus)  <- task DOF

Verifies L0 build, L1 stable physics, L2 actuated DOFs, L3 the shuttle reaches
both extremes of the datapath bus (toolhead-reaches-build-volume style check).
"""

import sys
import math
import mujoco
import numpy as np


# ---- spec Y-up -> MuJoCo Z-up : (x, y, z) -> (x, z, y) -------------------
def rp(p):
    x, y, z = p
    return (x, z, y)


def half(shape, size):
    """Return geom 'size' attribute string (MuJoCo half-extents / r,halfh)."""
    if shape == "box":
        sx, sy, sz = size
        # remap full dims (x,y,z)->(x,z,y), then halve
        return f"{sx/2:.5f} {sz/2:.5f} {sy/2:.5f}"
    else:  # cylinder / capsule / cone(approx as cylinder)
        r, h = size[0], size[1]
        return f"{r:.5f} {h/2:.5f}"


def gtype(shape):
    return {"box": "box", "cylinder": "cylinder", "capsule": "capsule",
            "cone": "cylinder"}.get(shape, "box")


def geom(shape, size, rgba="0.6 0.6 0.65 1"):
    return (f'<geom type="{gtype(shape)}" size="{half(shape,size)}" '
            f'contype="0" conaffinity="0" rgba="{rgba}"/>')


# ---- part table (id, shape, spec-pos, size) ------------------------------
# Movable-group members are built separately and excluded from the static loop.
LANE_Z = [-3.85, -2.75, -1.65, -0.55, 0.55, 1.65, 2.75, 3.85]

static = []
static.append(("pcb_substrate", "box", (0, 0.2, 0), (14, 0.4, 9)))
static.append(("fpga_die", "box", (0, 0.46, 0), (12, 0.08, 7.4)))
for i, z in enumerate(LANE_Z):
    static.append((f"bram_{i}", "box", (-5.8, 1, z), (1.3, 1.2, 0.85)))
static.append(("input_fifo", "capsule", (-6.8, 0.95, 3.2), (0.45, 1.8)))
static.append(("output_fifo", "capsule", (-6.8, 0.95, -3.2), (0.45, 1.8)))
static.append(("crossbar_network", "box", (-4.2, 0.9, 0), (1.2, 1.0, 8.4)))
static.append(("intt_scale", "box", (-3.25, 0.7, 3), (0.85, 0.6, 1.0)))
static.append(("bu_array_base", "box", (0, 0.475, 0), (3.6, 0.15, 8.4)))
for i, z in enumerate(LANE_Z):
    static.append((f"bu_mult_{i}", "cylinder", (-1.1, 0.95, z), (0.35, 0.9)))
    static.append((f"bu_add_{i}", "box", (0.5, 0.72, z - 0.24), (1.1, 0.66, 0.42)))
    static.append((f"bu_sub_{i}", "box", (0.5, 0.72, z + 0.24), (1.1, 0.66, 0.42)))
    static.append((f"bu_reg_{i}", "box", (1.5, 0.68, z), (0.4, 0.52, 0.8)))
static.append(("twiddle_rail", "box", (-1.1, 1.65, 0), (0.28, 0.12, 8.0)))
static.append(("twiddle_feeder", "box", (1.2, 1.65, -2.5), (4.6, 0.12, 0.28)))
static.append(("read_bus", "box", (-2.65, 1.45, 0), (3.3, 0.1, 0.32)))
static.append(("read_arrow", "cone", (-0.95, 1.45, 0), (0.18, 0.5)))
static.append(("mod_red_mult", "cylinder", (2.2, 0.95, 0), (0.5, 8.0)))
static.append(("mod_red_subshift", "box", (3.1, 0.85, 0), (0.7, 0.9, 8.0)))
static.append(("return_bus", "box", (-0.55, 1.62, -4), (7.3, 0.1, 0.35)))
static.append(("return_arrow", "cone", (-3.95, 1.62, -4), (0.18, 0.5)))
static.append(("twiddle_rom", "box", (4.6, 1.15, -2.5), (2.2, 1.5, 2.6)))
static.append(("addr_gen_unit", "box", (4.6, 0.95, 2.5), (2.2, 1.1, 2.6)))
static.append(("config_radix_selector", "box", (6.1, 0.7, 1.2), (0.9, 0.6, 1.1)))
static.append(("schedule_controller", "box", (6.1, 0.85, 3.4), (1.0, 0.9, 1.3)))
static.append(("clock_pll", "cylinder", (6.2, 0.8, -1.2), (0.5, 0.8)))

# ---- movable group 1: heatsink (base + riser + 7 fins), slide Z ----------
HS_BASE = (4.6, 2.75, 0)
heatsink_children = [("heatsink_riser", "cylinder", (4.6, 1.6, 0), (0.08, 2.2))]
for i in range(7):
    xf = 3.25 + 0.45 * i
    heatsink_children.append((f"heatsink_fin_{i}", "box", (xf, 3.25, 0), (0.18, 0.85, 3.7)))

# ---- movable group 2: exploded butterfly cluster, slide Z ----------------
EX_BASE = (0, 2.3, 0.65)
ex_children = [
    ("ex_mult", "cylinder", (-1.1, 2.75, 0.65), (0.4, 0.9)),
    ("ex_add", "box", (0.5, 2.65, 0.41), (1.1, 0.65, 0.42)),
    ("ex_sub", "box", (0.5, 2.65, 0.89), (1.1, 0.65, 0.42)),
    ("ex_reg", "box", (1.5, 2.6, 0.65), (0.4, 0.55, 0.9)),
    ("ex_riser_a", "cylinder", (-1.5, 1.39, 0.65), (0.07, 1.7)),
    ("ex_riser_b", "cylinder", (1.5, 1.39, 0.65), (0.07, 1.7)),
]

# ---- shuttle: synthetic operand traveling the read/return bus, slide X ----
SHUTTLE_POS = (-2.65, 1.45, 0)   # rides the read bus line


def build_mjcf():
    out = []
    out.append('<mujoco model="cfntt_ntt_accelerator">')
    out.append('  <compiler inertiafromgeom="true" angle="radian"/>')
    out.append('  <option timestep="0.002" gravity="0 0 -9.81"/>')
    out.append('  <worldbody>')
    out.append('    <geom name="floor" type="plane" size="40 40 0.1" '
               'rgba="0.2 0.2 0.22 1"/>')

    # static blocks: each welded to world (no joint => no DOF)
    for pid, shape, pos, size in static:
        x, y, z = rp(pos)
        out.append(f'    <body name="{pid}" pos="{x:.5f} {y:.5f} {z:.5f}">')
        out.append(f'      {geom(shape, size)}')
        out.append('    </body>')

    # heatsink group (slide Z)
    bx, by, bz = rp(HS_BASE)
    out.append(f'    <body name="heatsink_base" pos="{bx:.5f} {by:.5f} {bz:.5f}">')
    out.append('      <joint name="heatsink_jnt" type="slide" axis="0 0 1" '
               'limited="true" range="0 0.8" damping="12"/>')
    out.append(f'      {geom("box", (3, 0.2, 4), rgba="0.7 0.7 0.72 1")}')
    for pid, shape, pos, size in heatsink_children:
        cx, cy, cz = rp(pos)
        lx, ly, lz = cx - bx, cy - by, cz - bz
        out.append(f'      <body name="{pid}" pos="{lx:.5f} {ly:.5f} {lz:.5f}">')
        out.append(f'        {geom(shape, size)}')
        out.append('      </body>')
    out.append('    </body>')

    # exploded cluster (slide Z)
    ex, ey, ez = rp(EX_BASE)
    out.append(f'    <body name="ex_base" pos="{ex:.5f} {ey:.5f} {ez:.5f}">')
    out.append('      <joint name="ex_jnt" type="slide" axis="0 0 1" '
               'limited="true" range="0 0.6" damping="10"/>')
    out.append(f'      {geom("box", (3.6, 0.12, 1.6), rgba="0.7 0.7 0.72 1")}')
    for pid, shape, pos, size in ex_children:
        cx, cy, cz = rp(pos)
        lx, ly, lz = cx - ex, cy - ey, cz - ez
        out.append(f'      <body name="{pid}" pos="{lx:.5f} {ly:.5f} {lz:.5f}">')
        out.append(f'        {geom(shape, size)}')
        out.append('      </body>')
    out.append('    </body>')

    # operand shuttle (slide X) — the L3 "reach" DOF
    sx, sy, sz = rp(SHUTTLE_POS)
    out.append(f'    <body name="op_shuttle" pos="{sx:.5f} {sy:.5f} {sz:.5f}">')
    out.append('      <joint name="shuttle_jnt" type="slide" axis="1 0 0" '
               'limited="true" range="-3 3" damping="6"/>')
    out.append(f'      {geom("box", (0.4, 0.3, 0.3), rgba="0.9 0.5 0.1 1")}')
    out.append('    </body>')

    out.append('  </worldbody>')

    # position actuators for each DOF
    out.append('  <actuator>')
    out.append('    <position name="a_heatsink" joint="heatsink_jnt" kp="4000"/>')
    out.append('    <position name="a_ex" joint="ex_jnt" kp="4000"/>')
    out.append('    <position name="a_shuttle" joint="shuttle_jnt" kp="3000"/>')
    out.append('  </actuator>')
    out.append('</mujoco>')
    return "\n".join(out)


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def main():
    mjcf = build_mjcf()

    # ----- L0: build -----
    try:
        model = mujoco.MjModel.from_xml_string(mjcf)
    except Exception as e:
        fail(f"L0 build: from_xml_string raised: {e}")
    data = mujoco.MjData(model)
    nbodies = model.nbody
    nact = model.nu
    if model.njnt < 3 or nact < 3:
        fail(f"L0 build: expected >=3 joints/actuators, got "
             f"{model.njnt}/{nact}")

    # ----- L1: stable physics (hold-at-zero under gravity) -----
    data.ctrl[:] = 0.0
    for _ in range(1000):
        mujoco.mj_step(model, data)
    if not (np.all(np.isfinite(data.qpos)) and np.all(np.isfinite(data.qvel))):
        fail("L1 physics: NaN/Inf in qpos/qvel")
    if np.max(np.abs(data.qpos)) > 1e4 or np.max(np.abs(data.qvel)) > 1e4:
        fail("L1 physics: state exploded (unbounded)")

    # ----- L2: each actuator measurably moves its joint -----
    def act_id(n):
        return mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, n)

    def jnt_qadr(n):
        j = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, n)
        return model.jnt_qposadr[j]

    targets = {"a_heatsink": ("heatsink_jnt", 0.7),
               "a_ex": ("ex_jnt", 0.5),
               "a_shuttle": ("shuttle_jnt", 2.0)}
    for aname, (jname, tgt) in targets.items():
        d = mujoco.MjData(model)
        d.ctrl[:] = 0.0
        d.ctrl[act_id(aname)] = tgt
        adr = jnt_qadr(jname)
        before = d.qpos[adr]
        for _ in range(800):
            mujoco.mj_step(model, d)
        moved = abs(d.qpos[adr] - before)
        if moved < 0.05:
            fail(f"L2 actuated DOF: {aname} moved only {moved:.4f} (frozen)")

    # ----- L3: task — shuttle reaches both ends of the datapath bus -----
    bid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "op_shuttle")
    base_x = rp(SHUTTLE_POS)[0]
    reached = []
    for tgt in (-3.0, 3.0):
        d = mujoco.MjData(model)
        d.ctrl[:] = 0.0
        d.ctrl[act_id("a_shuttle")] = tgt
        for _ in range(2000):
            mujoco.mj_step(model, d)
        x = d.xpos[bid][0]
        err = abs(x - (base_x + tgt))
        if err > 0.1:
            fail(f"L3 task: shuttle target {tgt:+.1f} reached x={x:.3f} "
                 f"(err {err:.3f} > 0.1)")
        reached.append(x)

    print("VERIFIED")
    print(f"L0 build: {nbodies} bodies, {model.njnt} joints, {nact} actuators | "
          f"L1: 1000 steps stable, |qpos|max={np.max(np.abs(data.qpos)):.3e} | "
          f"L2: 3/3 DOFs actuated | "
          f"L3: operand shuttle spans bus x=[{reached[0]:.2f},{reached[1]:.2f}]")
    sys.exit(0)


if __name__ == "__main__":
    main()
