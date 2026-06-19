#!/usr/bin/env python3
"""
Self-checking MuJoCo build+sim of the CFNTT Radix-2/4 NTT accelerator FLOORPLAN.

The real subject is synthesizable Verilog (an FPGA NTT core); there is no
mechanism. We therefore model the spec's PHYSICAL floorplan as a rigid chip body
plus the two parts the spec explicitly draws as MOVABLE "exploded" assemblies:
  * the heatsink (lifted off the die on a riser stub), and
  * one butterfly cluster (lifted onto two riser posts above the array).
Each gets a vertical slide joint + position actuator. That gives us real DOFs to
exercise (L2) and a min/max travel task (L3), analogous to a 3D-printer toolhead
reaching its build-volume extremes.

Spec is Y-up; MuJoCo is Z-up, so we remap (x,y,z)->(x,z,y). Collisions are
disabled (abstract visualization); gravity is real and held by the actuators.
"""
import sys
import numpy as np
import mujoco

# ---------- coordinate / size mapping (spec Y-up -> MuJoCo Z-up) ----------
def mp(p):                      # position
    return (p[0], p[2], p[1])
def box_sz(s):                  # full (x,y,z) -> half (x,z,y)
    return (s[0] / 2.0, s[2] / 2.0, s[1] / 2.0)
def cyl_sz(s):                  # (radius, length) -> (radius, halflen)
    return (s[0], s[1] / 2.0)

DENS = "50"  # keep masses modest so position actuators can hold against gravity

def geom(shape, pos, size, rgba="0.55 0.6 0.68 1"):
    x, y, z = mp(pos)
    if shape == "box":
        sx, sy, sz = box_sz(size)
        return f'<geom type="box" pos="{x} {y} {z}" size="{sx} {sy} {sz}" density="{DENS}" rgba="{rgba}"/>'
    if shape in ("cylinder", "capsule", "cone"):
        # cone has no MuJoCo primitive -> approximate the small arrowheads as cylinders
        t = "capsule" if shape == "capsule" else "cylinder"
        r, h = cyl_sz(size)
        return f'<geom type="{t}" pos="{x} {y} {z}" size="{r} {h}" density="{DENS}" rgba="{rgba}"/>'
    raise ValueError(shape)

# ---------- STATIC chip floorplan (fixed to world) ----------
static = []
static.append(geom("box", [0, 0.2, 0], [14, 0.4, 9], "0.05 0.05 0.06 1"))      # pcb_substrate
static.append(geom("box", [0, 0.46, 0], [12, 0.08, 7.4], "0.7 0.7 0.72 1"))    # fpga_die
for i in range(8):                                                              # BRAM banks
    z = -3.85 + 1.1 * i
    static.append(geom("box", [-5.8, 1, z], [1.3, 1.2, 0.85], "0.4 0.7 0.9 0.6"))
static.append(geom("capsule", [-6.8, 0.95, 3.2], [0.45, 1.8], "0.9 0.9 0.9 1"))   # input_fifo
static.append(geom("capsule", [-6.8, 0.95, -3.2], [0.45, 1.8], "0.9 0.9 0.9 1"))  # output_fifo
static.append(geom("box", [-4.2, 0.9, 0], [1.2, 1, 8.4], "0.2 0.2 0.22 1"))       # crossbar
static.append(geom("box", [-3.25, 0.7, 3], [0.85, 0.6, 1], "0.8 0.6 0.2 1"))      # intt_scale
static.append(geom("box", [0, 0.475, 0], [3.6, 0.15, 8.4], "0.7 0.7 0.72 1"))     # bu_array_base
for i in range(8):                                                                # 8 butterfly lanes
    z = -3.85 + 1.1 * i
    static.append(geom("cylinder", [-1.1, 0.95, z], [0.35, 0.9], "0.8 0.45 0.2 1"))  # DSP mult
    static.append(geom("box", [0.5, 0.72, z - 0.24], [1.1, 0.66, 0.42], "0.15 0.15 0.17 1"))  # add
    static.append(geom("box", [0.5, 0.72, z + 0.24], [1.1, 0.66, 0.42], "0.6 0.6 0.62 1"))    # sub
    static.append(geom("box", [1.5, 0.68, z], [0.4, 0.52, 0.8], "0.9 0.9 0.9 1"))             # reg
static.append(geom("box", [-1.1, 1.65, 0], [0.28, 0.12, 8], "0.8 0.6 0.2 1"))     # twiddle_rail
static.append(geom("box", [1.2, 1.65, -2.5], [4.6, 0.12, 0.28], "0.8 0.6 0.2 1")) # twiddle_feeder
static.append(geom("box", [-2.65, 1.45, 0], [3.3, 0.1, 0.32], "0.8 0.45 0.2 1"))  # read_bus
static.append(geom("cone", [-0.95, 1.45, 0], [0.18, 0.5], "0.8 0.45 0.2 1"))      # read_arrow
static.append(geom("box", [-0.55, 1.62, -4], [7.3, 0.1, 0.35], "0.4 0.7 0.9 0.6"))# return_bus
static.append(geom("cone", [-3.95, 1.62, -4], [0.18, 0.5], "0.4 0.7 0.9 0.6"))    # return_arrow
static.append(geom("cylinder", [2.2, 0.95, 0], [0.5, 8], "0.5 0.5 0.55 1"))       # mod_red_mult (Barrett q-mul)
static.append(geom("box", [3.1, 0.85, 0], [0.7, 0.9, 8], "0.15 0.15 0.17 1"))     # mod_red_subshift
static.append(geom("box", [4.6, 1.15, -2.5], [2.2, 1.5, 2.6], "0.4 0.7 0.9 0.6")) # twiddle_rom
static.append(geom("box", [4.6, 0.95, 2.5], [2.2, 1.1, 2.6], "0.15 0.15 0.17 1")) # addr_gen
static.append(geom("box", [6.1, 0.7, 1.2], [0.9, 0.6, 1.1], "0.05 0.05 0.06 1"))  # config selector
static.append(geom("box", [6.1, 0.85, 3.4], [1, 0.9, 1.3], "0.5 0.5 0.55 1"))     # schedule FSM
static.append(geom("cylinder", [6.2, 0.8, -1.2], [0.5, 0.8], "0.6 0.6 0.65 1"))   # clock PLL

# ---------- MOVABLE group A: exploded heatsink (slides in Z) ----------
heat = [geom("box", [4.6, 2.75, 0], [3, 0.2, 4], "0.7 0.7 0.72 1"),
        geom("cylinder", [4.6, 1.6, 0], [0.08, 2.2], "0.7 0.7 0.72 1")]
for k in range(7):
    heat.append(geom("box", [3.25 + 0.45 * k, 3.25, 0], [0.18, 0.85, 3.7], "0.75 0.75 0.78 1"))

# ---------- MOVABLE group B: exploded butterfly cluster (slides in Z) ----------
exp = [geom("box", [0, 2.3, 0.65], [3.6, 0.12, 1.6], "0.7 0.7 0.72 1"),
       geom("cylinder", [-1.5, 1.39, 0.65], [0.07, 1.7], "0.7 0.7 0.72 1"),
       geom("cylinder", [1.5, 1.39, 0.65], [0.07, 1.7], "0.7 0.7 0.72 1"),
       geom("cylinder", [-1.1, 2.75, 0.65], [0.4, 0.9], "0.8 0.45 0.2 1"),
       geom("box", [0.5, 2.65, 0.41], [1.1, 0.65, 0.42], "0.15 0.15 0.17 1"),
       geom("box", [0.5, 2.65, 0.89], [1.1, 0.65, 0.42], "0.6 0.6 0.62 1"),
       geom("box", [1.5, 2.6, 0.65], [0.4, 0.55, 0.9], "0.9 0.9 0.9 1")]

MJCF = f'''<mujoco model="cfntt_ntt_accelerator">
  <compiler inertiafromgeom="true" angle="radian"/>
  <option gravity="0 0 -9.81" timestep="0.002">
    <flag contact="disable"/>
  </option>
  <worldbody>
    <geom name="floor" type="plane" pos="0 0 0" size="40 40 0.1" rgba="0.25 0.25 0.28 1"/>
    {''.join(static)}
    <body name="heatsink_asm" pos="0 0 0">
      <joint name="heat_slide" type="slide" axis="0 0 1" range="-0.5 0.5" damping="20000"/>
      {''.join(heat)}
    </body>
    <body name="exploded_asm" pos="0 0 0">
      <joint name="exp_slide" type="slide" axis="0 0 1" range="-0.5 0.5" damping="20000"/>
      {''.join(exp)}
    </body>
  </worldbody>
  <actuator>
    <position name="heat_act" joint="heat_slide" kp="2000000" ctrlrange="-0.5 0.5"/>
    <position name="exp_act"  joint="exp_slide"  kp="2000000" ctrlrange="-0.5 0.5"/>
  </actuator>
</mujoco>'''


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def main():
    # ---- L0: builds ----
    try:
        model = mujoco.MjModel.from_xml_string(MJCF)
    except Exception as e:
        fail(f"L0 from_xml_string raised: {e}")
    data = mujoco.MjData(model)
    print(f"L0 OK: built {model.ngeom} geoms, {model.njnt} joints, {model.nu} actuators")

    # ---- L1: valid physics under gravity ----
    mujoco.mj_resetData(model, data)
    for _ in range(1000):
        mujoco.mj_step(model, data)
        if not (np.all(np.isfinite(data.qpos)) and np.all(np.isfinite(data.qvel))):
            fail("L1 non-finite qpos/qvel")
    if np.max(np.abs(data.qpos)) > 1e3 or np.max(np.abs(data.qvel)) > 1e4:
        fail("L1 state unbounded (model exploded)")
    print(f"L1 OK: 1000 steps finite & bounded (max|qpos|={np.max(np.abs(data.qpos)):.4f})")

    # ---- L2: each actuated DOF really moves ----
    for jname, aname in [("heat_slide", "heat_act"), ("exp_slide", "exp_act")]:
        mujoco.mj_resetData(model, data)
        jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, jname)
        aid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, aname)
        qadr = model.jnt_qposadr[jid]
        for _ in range(200):
            mujoco.mj_step(model, data)
        base = data.qpos[qadr]
        data.ctrl[aid] = 0.45
        for _ in range(800):
            mujoco.mj_step(model, data)
        moved = data.qpos[qadr] - base
        if abs(moved) < 0.1:
            fail(f"L2 actuator '{aname}' barely moved ({moved:.4f})")
    print("L2 OK: both slide DOFs (heatsink, exploded cluster) are independently actuated")

    # ---- L3: heatsink reaches Z-travel min & max ("build volume" extremes) ----
    mujoco.mj_resetData(model, data)
    aid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, "heat_act")
    jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, "heat_slide")
    qadr = model.jnt_qposadr[jid]
    data.ctrl[aid] = 0.5
    for _ in range(800):
        mujoco.mj_step(model, data)
    hi = data.qpos[qadr]
    data.ctrl[aid] = -0.5
    for _ in range(800):
        mujoco.mj_step(model, data)
    lo = data.qpos[qadr]
    if abs(hi - 0.5) > 0.08 or abs(lo + 0.5) > 0.08:
        fail(f"L3 heatsink did not hit extremes (hi={hi:.4f}, lo={lo:.4f})")
    print(f"L3 OK: heatsink hit Z extremes hi={hi:.3f}, lo={lo:.3f}")

    print(f"VERIFIED | L0 built {model.ngeom} geoms/{model.nu} act; "
          f"L1 1000 steps finite&bounded; L2 2 DOFs actuated; "
          f"L3 heatsink reached Z min/max travel")
    sys.exit(0)


if __name__ == "__main__":
    main()
