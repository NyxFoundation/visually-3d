#!/usr/bin/env python3
"""
Self-checking MuJoCo model of the CFNTT Radix-2/4 NTT Multiplication Accelerator (FPGA).

The real artifact is synthesizable Verilog (an NTT datapath), which has no moving
parts. To satisfy the physical-simulation harness we build a faithful *structural*
MJCF of the floorplan from the spec (PCB, die, 8 BRAM banks, FIFOs, crossbar, the
8-lane butterfly array = mult/add/sub/register per lane, the shared Barrett
reduction spine, twiddle ROM + broadcast rail/feeder, read/return buses + arrows,
addr-gen/config/FSM/PLL, the exploded butterfly cluster and exploded heatsink).

Movement is given only where the spec implies a motion/data path:
  * operand_shuttle : a slide body modeling the conflict-free read-modify-write
                      loop traveling along the datapath (crossbar -> mult -> reduce).
  * ex_base         : the exploded butterfly cluster on its risers (slide).
  * heatsink_base   : the exploded heatsink (slide).
These give real actuated DOFs for L2; the shuttle's traversal is the L3 "task".

Verification: L0 build, L1 bounded physics, L2 actuated DOFs move, L3 shuttle
reaches both ends of the datapath (read end @ crossbar and return end @ reduction).
"""

import sys
import math
import mujoco


# ----------------------------------------------------------------------------
# Part table derived from the spec (positions kept in spec frame; y is up).
# size: box=[fx,fy,fz] full extents; cylinder/capsule/cone=[radius, full_length]
# ----------------------------------------------------------------------------
LANE_Z = [-3.85, -2.75, -1.65, -0.55, 0.55, 1.65, 2.75, 3.85]

FIXED = []  # (name, shape, pos, size, rot)

def add(name, shape, pos, size, rot=(0.0, 0.0, 0.0)):
    FIXED.append((name, shape, tuple(pos), tuple(size), tuple(rot)))

# substrate + die
add("pcb_substrate", "box", (0, 0.2, 0), (14, 0.4, 9))
add("fpga_die", "box", (0, 0.46, 0), (12, 0.08, 7.4))

# BRAM banks
for i, z in enumerate(LANE_Z):
    add(f"bram_{i}", "box", (-5.8, 1.0, z), (1.3, 1.2, 0.85))

# FIFOs (capsules, rotated to lie along z)
add("input_fifo", "capsule", (-6.8, 0.95, 3.2), (0.45, 1.8), (1.5708, 0, 0))
add("output_fifo", "capsule", (-6.8, 0.95, -3.2), (0.45, 1.8), (1.5708, 0, 0))

# crossbar + intt scale
add("crossbar_network", "box", (-4.2, 0.9, 0), (1.2, 1.0, 8.4))
add("intt_scale", "box", (-3.25, 0.7, 3.0), (0.85, 0.6, 1.0))

# butterfly array baseplate
add("bu_array_base", "box", (0, 0.475, 0), (3.6, 0.15, 8.4))

# eight butterfly lanes: mult -> add/sub -> register
for i, z in enumerate(LANE_Z):
    add(f"bu_mult_{i}", "cylinder", (-1.1, 0.95, z), (0.35, 0.9))
    add(f"bu_add_{i}", "box", (0.5, 0.72, z - 0.24), (1.1, 0.66, 0.42))
    add(f"bu_sub_{i}", "box", (0.5, 0.72, z + 0.24), (1.1, 0.66, 0.42))
    add(f"bu_reg_{i}", "box", (1.5, 0.68, z), (0.4, 0.52, 0.8))

# twiddle broadcast rail + feeder
add("twiddle_rail", "box", (-1.1, 1.65, 0), (0.28, 0.12, 8.0))
add("twiddle_feeder", "box", (1.2, 1.65, -2.5), (4.6, 0.12, 0.28))

# operand read bus + arrow (cone approximated by cylinder)
add("read_bus", "box", (-2.65, 1.45, 0), (3.3, 0.1, 0.32))
add("read_arrow", "cone", (-0.95, 1.45, 0), (0.18, 0.5), (0, 0, -1.5708))

# Barrett reduction spine
add("mod_red_mult", "cylinder", (2.2, 0.95, 0), (0.5, 8.0), (1.5708, 0, 0))
add("mod_red_subshift", "box", (3.1, 0.85, 0), (0.7, 0.9, 8.0))

# operand return bus + arrow
add("return_bus", "box", (-0.55, 1.62, -4.0), (7.3, 0.1, 0.35))
add("return_arrow", "cone", (-3.95, 1.62, -4.0), (0.18, 0.5), (0, 0, 1.5708))

# control / memory periphery
add("twiddle_rom", "box", (4.6, 1.15, -2.5), (2.2, 1.5, 2.6))
add("addr_gen_unit", "box", (4.6, 0.95, 2.5), (2.2, 1.1, 2.6))
add("config_radix_selector", "box", (6.1, 0.7, 1.2), (0.9, 0.6, 1.1))
add("schedule_controller", "box", (6.1, 0.85, 3.4), (1.0, 0.9, 1.3))
add("clock_pll", "cylinder", (6.2, 0.8, -1.2), (0.5, 0.8))

# exploded-view risers + heatsink riser stub (static)
add("ex_riser_a", "cylinder", (-1.5, 1.39, 2.4), (0.07, 1.7))
add("ex_riser_b", "cylinder", (1.5, 1.39, 2.4), (0.07, 1.7))
add("heatsink_riser", "cylinder", (4.6, 1.6, 0), (0.08, 2.2))


# ----------------------------------------------------------------------------
# Geometry helpers
# ----------------------------------------------------------------------------
def geom_xml(shape, size):
    if shape == "box":
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        return f'type="box" size="{hx:.4f} {hy:.4f} {hz:.4f}"'
    # cylinder / capsule / cone(approx as cylinder): size=[radius, full_length]
    r, hl = size[0], size[1] / 2
    t = "capsule" if shape == "capsule" else "cylinder"
    return f'type="{t}" size="{r:.4f} {hl:.4f}"'


def body_xml(name, shape, pos, size, rot, indent="    "):
    p = f'{pos[0]:.4f} {pos[1]:.4f} {pos[2]:.4f}'
    euler = ""
    if any(abs(a) > 1e-9 for a in rot):
        euler = f' euler="{rot[0]:.5f} {rot[1]:.5f} {rot[2]:.5f}"'
    return (f'{indent}<body name="{name}" pos="{p}"{euler}>\n'
            f'{indent}  <geom {geom_xml(shape, size)}/>\n'
            f'{indent}</body>\n')


# ----------------------------------------------------------------------------
# Build MJCF
# ----------------------------------------------------------------------------
def build_mjcf():
    parts = "".join(body_xml(*f) for f in FIXED)

    # exploded heatsink (slide along z), fins are children moving with it
    hb = (4.6, 2.75, 0.0)
    fins = ""
    for i, x in enumerate([3.25, 3.7, 4.15, 4.6, 5.05, 5.5, 5.95]):
        rel = (x - hb[0], 3.25 - hb[1], 0.0)
        fins += body_xml(f"heatsink_fin_{i}", "box", rel, (0.18, 0.85, 3.7),
                         (0, 0, 0), indent="      ")
    heatsink = (
        f'    <body name="heatsink_base" pos="{hb[0]} {hb[1]} {hb[2]}">\n'
        f'      <joint name="j_heatsink" type="slide" axis="0 0 1" '
        f'range="-1 1" damping="800" armature="5"/>\n'
        f'      <geom {geom_xml("box", (3,0.2,4))}/>\n'
        f'{fins}'
        f'    </body>\n'
    )

    # exploded butterfly cluster (slide along z), datapath children
    eb = (0.0, 2.3, 2.4)
    ex_children = ""
    ex_children += body_xml("ex_mult", "cylinder", (-1.1, 0.45, 0.0),
                            (0.4, 0.9), (0, 0, 0), indent="      ")
    ex_children += body_xml("ex_add", "box", (0.5, 0.35, -0.24),
                            (1.1, 0.65, 0.42), (0, 0, 0), indent="      ")
    ex_children += body_xml("ex_sub", "box", (0.5, 0.35, 0.24),
                            (1.1, 0.65, 0.42), (0, 0, 0), indent="      ")
    ex_children += body_xml("ex_reg", "box", (1.5, 0.30, 0.0),
                            (0.4, 0.55, 0.9), (0, 0, 0), indent="      ")
    ex_cluster = (
        f'    <body name="ex_base" pos="{eb[0]} {eb[1]} {eb[2]}">\n'
        f'      <joint name="j_excluster" type="slide" axis="0 0 1" '
        f'range="-1 1" damping="300" armature="2"/>\n'
        f'      <geom {geom_xml("box", (3.6,0.12,1.6))}/>\n'
        f'{ex_children}'
        f'    </body>\n'
    )

    # operand shuttle: read-modify-write loop traversal along +/-X of the datapath
    shuttle = (
        '    <body name="operand_shuttle" pos="0 1.55 0">\n'
        '      <joint name="j_shuttle" type="slide" axis="1 0 0" '
        'range="-4.6 3.6" damping="60" armature="1"/>\n'
        f'      <geom {geom_xml("box", (0.3,0.3,0.3))} rgba="0.9 0.5 0.1 1"/>\n'
        '    </body>\n'
    )

    mjcf = f"""<mujoco model="cfntt_ntt_accelerator">
  <compiler angle="radian" inertiafromgeom="true"/>
  <option timestep="0.002" gravity="0 -9.81 0" integrator="Euler"/>
  <default>
    <geom density="150" contype="0" conaffinity="0"/>
  </default>
  <worldbody>
    <geom name="floor" type="plane" pos="0 -0.01 0" size="40 40 0.1"
          euler="-1.5708 0 0" contype="0" conaffinity="0"/>
{parts}{heatsink}{ex_cluster}{shuttle}  </worldbody>
  <actuator>
    <position name="a_shuttle"   joint="j_shuttle"   kp="3000"  ctrlrange="-4.6 3.6"/>
    <position name="a_excluster" joint="j_excluster" kp="6000"  ctrlrange="-1 1"/>
    <position name="a_heatsink"  joint="j_heatsink"  kp="10000" ctrlrange="-1 1"/>
  </actuator>
</mujoco>"""
    return mjcf


# ----------------------------------------------------------------------------
# Helpers for verification
# ----------------------------------------------------------------------------
def jpos(model, data, jname):
    jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, jname)
    return data.qpos[model.jnt_qposadr[jid]]


def aid(model, aname):
    return mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, aname)


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def main():
    # L0 -- build
    mjcf = build_mjcf()
    try:
        model = mujoco.MjModel.from_xml_string(mjcf)
        data = mujoco.MjData(model)
    except Exception as e:  # noqa: BLE001  (boundary: report any build error)
        fail(f"L0 build raised: {e}")
    n_bodies = model.nbody - 1  # minus world
    if model.nu != 3:
        fail(f"L0 expected 3 actuators, got {model.nu}")

    # L1 -- bounded physics under gravity
    mujoco.mj_resetData(model, data)
    for _ in range(1000):
        mujoco.mj_step(model, data)
        if not (all(map(math.isfinite, data.qpos)) and
                all(map(math.isfinite, data.qvel))):
            fail("L1 NaN/Inf in state")
    if max((abs(x) for x in data.qpos), default=0.0) > 1e4:
        fail("L1 model exploded (qpos unbounded)")

    # L2 -- each actuated DOF measurably moves
    actuators = [("a_shuttle", "j_shuttle", 1.5),
                 ("a_excluster", "j_excluster", 0.6),
                 ("a_heatsink", "j_heatsink", 0.6)]
    for an, jn, target in actuators:
        mujoco.mj_resetData(model, data)
        q0 = jpos(model, data, jn)
        data.ctrl[aid(model, an)] = target
        for _ in range(900):
            mujoco.mj_step(model, data)
        if abs(jpos(model, data, jn) - q0) < 0.05:
            fail(f"L2 actuator {an} did not move joint {jn}")

    # L3 -- shuttle traverses the read-modify-write datapath:
    #       reach the crossbar (read) end and the reduction (return) end.
    READ_END, RETURN_END, TOL = -4.2, 3.1, 0.2
    mujoco.mj_resetData(model, data)
    sa = aid(model, "a_shuttle")
    data.ctrl[sa] = READ_END
    for _ in range(3000):
        mujoco.mj_step(model, data)
    if abs(jpos(model, data, "j_shuttle") - READ_END) > TOL:
        fail(f"L3 shuttle failed to reach read end {READ_END} "
             f"(got {jpos(model, data, 'j_shuttle'):.3f})")
    data.ctrl[sa] = RETURN_END
    for _ in range(3000):
        mujoco.mj_step(model, data)
    if abs(jpos(model, data, "j_shuttle") - RETURN_END) > TOL:
        fail(f"L3 shuttle failed to reach return end {RETURN_END} "
             f"(got {jpos(model, data, 'j_shuttle'):.3f})")

    print("VERIFIED")
    print(f"L0 built {n_bodies} bodies, {model.nu} actuators | "
          f"L1 1000 steps bounded & finite | "
          f"L2 3/3 actuated DOFs move | "
          f"L3 operand shuttle reached read end ({READ_END}) "
          f"and return end ({RETURN_END}) within {TOL} m")
    sys.exit(0)


if __name__ == "__main__":
    main()
