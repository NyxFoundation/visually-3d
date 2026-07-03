#!/usr/bin/env python3
"""
Self-checking MuJoCo model of the CFNTT Radix-2/4 NTT Multiplication Accelerator.

The real target is synthesizable Verilog; the spec, however, asks for a MuJoCo
build+sim. An FPGA datapath has no mechanical DOFs, so we model the *information
flow* mechanically:

  * The static structure (PCB substrate, die, 8 interleaved BRAM banks, FIFOs,
    8x8 conflict-free crossbar, 8 butterfly lanes [DSP mult -> sym add/sub ->
    pipeline reg], Barrett reduction spine [q-mul -> shift/subtract], return bus,
    twiddle ROM, addr-gen, radix selector, schedule FSM, clock PLL) is built as
    welded geoms in their spec positions.

  * The conflict-free READ-MODIFY-WRITE loop is modeled as an actuated "operand
    token" that slides along the datapath X axis (BRAM side -> reduction side),
    i.e. the path BRAM -> crossbar -> butterfly -> reduction and back.

  * The two EXPLODED-VIEW members in the spec (lifted butterfly cluster and the
    exploded heatsink) become actuated vertical lifts.

Verification: L0 build, L1 bounded physics, L2 every actuator moves its joint,
L3 the operand token reaches both ends of the datapath span (min & max X).
"""

import sys
import math

import mujoco


# --- coordinate helpers: spec is y-up, MuJoCo is z-up -> swap y and z --------
def P(p):
    return f"{p[0]} {p[2]} {p[1]}"


def BHALF(s):
    # spec full box size [x,y,z] -> MuJoCo half-extents with y/z swapped
    return f"{s[0]/2:.4f} {s[2]/2:.4f} {s[1]/2:.4f}"


def CYL(s):
    # spec cylinder/capsule [radius, length] -> MuJoCo "radius halflength"
    return f"{s[0]:.4f} {s[1]/2:.4f}"


def box(name, pos, size, rgba):
    return (f'<body name="{name}" pos="{P(pos)}">'
            f'<geom type="box" size="{BHALF(size)}" rgba="{rgba}"/></body>')


def cyl(name, pos, size, rgba):
    return (f'<body name="{name}" pos="{P(pos)}">'
            f'<geom type="cylinder" size="{CYL(size)}" rgba="{rgba}"/></body>')


parts = []

# --- substrate + die ---------------------------------------------------------
parts.append(box("pcb_substrate", [0, 0.2, 0], [14, 0.4, 9], "0.05 0.05 0.05 1"))
parts.append(box("fpga_die", [0, 0.46, 0], [12, 0.08, 7.4], "0.6 0.6 0.62 1"))

# --- 8 interleaved BRAM banks ------------------------------------------------
for i in range(8):
    z = -3.85 + i * 1.1
    parts.append(box(f"bram_{i}", [-5.8, 1.0, z], [1.3, 1.2, 0.85],
                     "0.4 0.7 0.9 0.5"))

# --- FIFOs (modeled as small boxes) -----------------------------------------
parts.append(box("input_fifo", [-6.8, 0.95, 3.2], [0.45, 1.8, 0.45], "0.9 0.9 0.9 1"))
parts.append(box("output_fifo", [-6.8, 0.95, -3.2], [0.45, 1.8, 0.45], "0.9 0.9 0.9 1"))

# --- conflict-free crossbar spine -------------------------------------------
parts.append(box("crossbar_network", [-4.2, 0.9, 0], [1.2, 1.0, 8.4], "0.2 0.2 0.25 1"))
parts.append(box("intt_scale", [-3.25, 0.7, 3], [0.85, 0.6, 1.0], "0.8 0.6 0.2 1"))

# --- butterfly array baseplate + 8 lanes (mult, add, sub, reg) --------------
parts.append(box("bu_array_base", [0, 0.475, 0], [3.6, 0.15, 8.4], "0.6 0.6 0.62 1"))
for i in range(8):
    z = -3.85 + i * 1.1
    parts.append(cyl(f"bu_mult_{i}", [-1.1, 0.95, z], [0.35, 0.9], "0.85 0.45 0.2 1"))
    parts.append(box(f"bu_add_{i}", [0.5, 0.72, z - 0.24], [1.1, 0.66, 0.42], "0.2 0.2 0.25 1"))
    parts.append(box(f"bu_sub_{i}", [0.5, 0.72, z + 0.24], [1.1, 0.66, 0.42], "0.2 0.2 0.25 1"))
    parts.append(box(f"bu_reg_{i}", [1.5, 0.68, z], [0.4, 0.52, 0.8], "0.9 0.9 0.9 1"))

# --- shared Barrett reduction spine -----------------------------------------
parts.append(cyl("mod_red_mult", [2.2, 0.95, 0], [0.5, 8.0], "0.5 0.5 0.55 1"))
parts.append(box("mod_red_subshift", [3.1, 0.85, 0], [0.7, 0.9, 8.0], "0.2 0.2 0.25 1"))

# --- operand-return bus + arrow (static markers) ----------------------------
parts.append(box("return_bus", [-0.55, 1.62, -4], [7.3, 0.1, 0.35], "0.4 0.7 0.9 0.5"))
parts.append(box("return_arrow", [-3.95, 1.62, -4], [0.4, 0.36, 0.36], "0.4 0.7 0.9 0.6"))

# --- control / support blocks ------------------------------------------------
parts.append(box("twiddle_rom", [4.6, 1.15, -2.5], [2.2, 1.5, 2.6], "0.4 0.7 0.9 0.5"))
parts.append(box("addr_gen_unit", [4.6, 0.95, 2.5], [2.2, 1.1, 2.6], "0.2 0.2 0.25 1"))
parts.append(box("config_radix_selector", [6.1, 0.7, 1.2], [0.9, 0.6, 1.1], "0.05 0.05 0.05 1"))
parts.append(box("schedule_controller", [6.1, 0.85, 3.4], [1.0, 0.9, 1.3], "0.5 0.5 0.55 1"))
parts.append(cyl("clock_pll", [6.2, 0.8, -1.2], [0.5, 0.8], "0.7 0.7 0.7 1"))

STATIC = "\n".join(parts)

# --- actuated DOFs -----------------------------------------------------------
# 1) operand token sliding along the datapath X (read-modify-write loop)
# 2) exploded butterfly cluster lift (Z)
# 3) exploded heatsink lift (Z)
MOVING = """
<body name="operand_token" pos="-6 0 1.6">
  <joint name="token_x" type="slide" axis="1 0 0" range="-6 4" damping="5"/>
  <geom type="box" size="0.25 0.25 0.25" rgba="1 0.2 0.2 1"/>
</body>
<body name="exploded_cluster" pos="0 -0.55 2.3">
  <joint name="cluster_z" type="slide" axis="0 0 1" range="2.3 3.2" damping="5"/>
  <geom type="box" size="1.8 0.8 0.06" rgba="0.6 0.6 0.62 1"/>
</body>
<body name="heatsink" pos="4.6 0 2.75">
  <joint name="heatsink_z" type="slide" axis="0 0 1" range="2.75 3.7" damping="5"/>
  <geom type="box" size="1.5 2.0 0.1" rgba="0.6 0.6 0.62 1"/>
</body>
"""

ACTUATORS = """
<position name="a_token"   joint="token_x"    kp="800" ctrlrange="-6 4"/>
<position name="a_cluster" joint="cluster_z"  kp="800" ctrlrange="2.3 3.2"/>
<position name="a_heatsink" joint="heatsink_z" kp="800" ctrlrange="2.75 3.7"/>
"""

MJCF = f"""<mujoco model="cfntt_ntt_accelerator">
  <compiler inertiafromgeom="true" angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <geom name="floor" type="plane" size="30 30 0.1" rgba="0.3 0.3 0.3 1"/>
    {STATIC}
    {MOVING}
  </worldbody>
  <actuator>
    {ACTUATORS}
  </actuator>
</mujoco>"""


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


# ---------------------------------------------------------------------------
# L0 — build
# ---------------------------------------------------------------------------
try:
    model = mujoco.MjModel.from_xml_string(MJCF)
    data = mujoco.MjData(model)
except Exception as e:  # noqa: BLE001 (boundary: external XML compile)
    fail(f"L0 build: {e}")

n_act = model.nu
if n_act != 3:
    fail(f"L0 build: expected 3 actuators, got {n_act}")

# hold actuators at rest
rest = {"a_token": -6.0, "a_cluster": 2.3, "a_heatsink": 2.75}
for name, val in rest.items():
    data.ctrl[model.actuator(name).id] = val

# ---------------------------------------------------------------------------
# L1 — valid, bounded physics
# ---------------------------------------------------------------------------
for _ in range(1000):
    mujoco.mj_step(model, data)
    if not (math.isfinite(data.qpos.sum()) and math.isfinite(data.qvel.sum())):
        fail("L1 physics: NaN/Inf in state")
    if max(abs(float(v)) for v in data.qpos) > 1e3:
        fail("L1 physics: model exploded (qpos unbounded)")

# ---------------------------------------------------------------------------
# L2 — each actuated DOF measurably moves its joint
# ---------------------------------------------------------------------------
targets = {"a_token": 4.0, "a_cluster": 3.2, "a_heatsink": 3.7}
for name in targets:
    jid = model.actuator(name).trnid[0]
    qadr = model.jnt_qposadr[jid]
    before = float(data.qpos[qadr])
    data.ctrl[model.actuator(name).id] = targets[name]
    for _ in range(500):
        mujoco.mj_step(model, data)
    after = float(data.qpos[qadr])
    if abs(after - before) < 0.05:
        fail(f"L2 actuated DOF: '{name}' did not move ({before:.3f}->{after:.3f})")
    # restore hold for the others' stability
    data.ctrl[model.actuator(name).id] = targets[name]

# ---------------------------------------------------------------------------
# L3 — task: operand token traverses the full datapath span (min & max X),
#      i.e. completes the conflict-free read-modify-write loop end to end.
# ---------------------------------------------------------------------------
tok_jid = model.actuator("a_token").trnid[0]
tok_adr = model.jnt_qposadr[tok_jid]

# drive to max X
data.ctrl[model.actuator("a_token").id] = 4.0
for _ in range(800):
    mujoco.mj_step(model, data)
xmax = float(data.qpos[tok_adr])
if abs(xmax - 4.0) > 0.2:
    fail(f"L3 task: token failed to reach datapath max X (got {xmax:.3f})")

# drive back to min X
data.ctrl[model.actuator("a_token").id] = -6.0
for _ in range(800):
    mujoco.mj_step(model, data)
xmin = float(data.qpos[tok_adr])
if abs(xmin - (-6.0)) > 0.2:
    fail(f"L3 task: token failed to return to datapath min X (got {xmin:.3f})")

print("VERIFIED")
print(f"L0 build: {model.nbody} bodies, {model.nu} actuators, "
      f"8 BRAM banks + 8 butterfly lanes + Barrett reduction spine | "
      f"L1 bounded physics over 1000 steps (no NaN/Inf) | "
      f"L2 all 3 actuators move their joints | "
      f"L3 operand token traverses datapath X span [{xmin:.2f},{xmax:.2f}] "
      f"(conflict-free read-modify-write loop)")
sys.exit(0)
