#!/usr/bin/env python3
"""
Formal verification of the CFNTT Radix-2 NTT multiplication accelerator
(Chen et al., IACR TCHES 2022(1):94-126; reference repo xiang-rc/cfntt_ref).

Ground truth = the cloned reference source (radix-2 tree; radix-4 is OUT OF
SCOPE for this check):
  * cfntt_ref/model_code/poly_mult_radix_2.py   (q=12289, kesai=7, DIT/DIF, op21)
  * cfntt_ref/hardware_code_radix-2/modular_add.v          -> check (A)
  * cfntt_ref/hardware_code_radix-2/modular_substraction.v -> check (B)
  * cfntt_ref/hardware_code_radix-2/modular_half.v         -> check (C)
      (implements the model's op21; note: NOT instantiated anywhere in the
       radix-2 RTL tree — the RTL INTT butterfly omits the per-stage halving)
  * cfntt_ref/hardware_code_radix-2/modular_mul.v          -> checks (D1),(D2)
  * cfntt_ref/hardware_code_radix-2/conflict_free_memory_map.v -> (E1),(E2)
  * cfntt_ref/hardware_code_radix-2/address_generator.v    -> check (F)
  * cfntt_ref/hardware_code_radix-2/tf_address_generator.v -> check (G)
  * cfntt_ref/hardware_code_radix-2/tf_ROM.v               -> check (H)
  * cfntt_ref/hardware_code_radix-2/compact_bf.v           -> check (I)

Everything below is modeled on those real functions/parameters; the two
twiddle tables are transcribed mechanically from the source files.

TIER 1 — size-independent, proven at FULL bit width / over the FULL domain:
  (A) modular_add.v   == (x+y) mod q      z3 / QF_BV, exact gate model    [src]
  (B) modular_substraction.v == (x-y) mod q  z3, exact gate model
      ({b,d}=x-y; q_mux=b?M:0; {c,z}=d+q_mux)                             [src]
  (C) modular_half.v  == x * 2^-1 mod q   z3 / QF_BV, exact gate model
      (= the model's op21)                                                [src]
  (D1) modular_mul.v  == (a*b) mod q      z3, EXACT RTL datapath:
       t = ((z>>13) * 15'h5553) >> 15  (pre-truncated Barrett, NOT the
       textbook t=(z*mu)>>28), remainder truncated to 15 bits, ONE
       conditional subtraction.  We prove, for every z <= (q-1)^2:
         - the 29-bit mul2 wire never drops a product bit,
         - t*q <= z              (no 28-bit underflow),
         - z - t*q < 2q          (15-bit truncation lossless AND one
                                  conditional subtraction suffices),
         - the bit-exact output mux == the corrected remainder, < q.
       With r = z - t*q exact and the output = r or r-q, output == z mod q.
       All obligations multiply by CONSTANTS only (z is a free 28-bit
       variable covering every product a*b with a,b < q), so z3 is fast.  [src]
  (D2) the same datapath, bit-exact in plain ints, cross-checked against
       (a*b) mod q on edge pairs + a deterministic random sample          [src]
  (E1) conflict-free memory map: (bank,offset) bijective on 10 bits       [src]
  (E2) for EVERY power-of-two stride 2^p the two butterfly operands
       land in DIFFERENT banks (pure parity-map property)                 [src]
  (F) address_generator.v, EXACT case-statement model, per stage p:
       under the FSM ranges k < 2^(9-p), i < 2^p:
         addr0 = ((k<<1)<<p)+i does not overflow 10 bits,
         addr0[p] == 0,  addr1(case) == addr0 | (1<<p),
         banks(addr0) != banks(addr1),  and (k,i) -> addr0 is INJECTIVE
       (so each stage enumerates every butterfly pair exactly once).      [src]
  (G) tf_address_generator.v, EXACT case constants, per stage p:
       NTT  address = k + (2^(9-p) - 1)  = (model DIT r-index 2^(9-p)+k) - 1
       INTT address = (2^(10-p)-2) - k   = (model DIF r-index 2^(10-p)-1-k) - 1
       both in ROM range [0,1023); i.e. the RTL reads ROM[model_r - 1].   [src]
  (H) twiddle ROM grounding, ALL entries:
       derived psi^bitrev(i,10) (psi=kesai=7) == model w_rom (1024/1024)
       RTL tf_ROM.v case table  == model w_rom[1..1023]  (1023/1023,
       confirming the -1 offset proven in (G); w_rom[0]=1 is unused).     [src]
  (I) compact_bf.v routing, exact mux/operand-order model (DFF delays
       abstracted to identity — pipeline alignment is the FSM's business),
       with the multiplier output as a free m < q (justified by (D1)):
         sel=0 (NTT):  out = (add(u,m), sub(u,m)), mult fed (v, w)
                       => (u + v*w, u - v*w)  == the model DIT butterfly
         sel=1 (INTT): out = (add(u,v), m),   mult fed (sub(v,u), w)
                       => (u + v, (v-u)*w)    == the model DIF butterfly
                          WITHOUT op21: the released radix-2 RTL performs
                          no per-stage halving (modular_half.v is not
                          instantiated) — documented divergence, see NOTE. [src]

TIER 2 — whole-system equivalence at the SMALLEST structure-preserving sizes,
using the source's EXACT DIT_NR_NTT / DIF_RN_INTT / op21 with a negacyclic
twiddle table psi^bitrev derived from the source root (psi = 7^(2048/2N)):
  (J) INVERTIBILITY  INTT(NTT(e_i)) == e_i on the FULL basis, N in {8,16,64}
      -> proves INTT o NTT = identity for ALL inputs (linear map).
  (K) CONVOLUTION    INTT(NTT(e_i) (.) NTT(e_j)) == negacyclic_conv(e_i,e_j)
      on all basis PAIRS, N in {8,16} -> proves the transform diagonalises
      negacyclic convolution (bilinear, hence for all inputs).

Production-size (N=1024) grounding: round-trip on the REAL source negacyclic
table (checked entry-for-entry in (H)) over a deterministic O(N log N) vector
set.  DEEP_VERIFY=1 additionally runs the FULL-basis N=1024 round-trip.

Prints exactly "VERIFIED" / exit 0 iff every required check passes, else
"FAIL: <reason + counterexample>" / exit 1.
"""

import os
import sys
import random

try:
    from z3 import (
        BitVec, BitVecVal, Concat, Extract, ZeroExt, LShR, URem, UGE, ULE,
        ULT, If, And, Or, Not, Then, unsat, sat,
    )
except Exception as exc:  # z3 is allowed and required
    print("FAIL: z3 unavailable (%r)" % (exc,))
    sys.exit(1)

Q = 12289          # 14-bit NTT-friendly prime, q = 3*2^12 + 1              [src]
KESAI = 7          # negacyclic 2N-th root psi used by the reference        [src]
Q0 = 0x5553        # modular_mul.v parameter q0 = 15'h5553 = 21843          [src]

# Ground-truth tables transcribed mechanically from the cloned source:
#   SRC_W_ROM  = model_code/poly_mult_radix_2.py  w_rom   (1024 entries)
#   RTL_TF_ROM = hardware_code_radix-2/tf_ROM.v case table (1023 entries)
SRC_W_ROM = [
    1, 10810, 7143, 4043, 10984, 722, 5736, 8155, 3542, 8785, 9744, 3621, 10643, 1212, 3195,
    5860, 7468, 2639, 9664, 11340, 11726, 9314, 9283, 9545, 5728, 7698, 5023, 5828, 8961,
    6512, 7311, 1351, 2319, 11119, 11334, 11499, 9088, 3014, 5086, 10963, 4846, 9542, 9154,
    3712, 4805, 8736, 11227, 9995, 3091, 12208, 7969, 11289, 9326, 7393, 9238, 2366, 11112,
    8034, 10654, 9521, 12149, 10436, 7678, 11563, 1260, 4388, 4632, 6534, 2426, 334, 1428,
    1696, 2013, 9000, 729, 3241, 2881, 3284, 7197, 10200, 8595, 7110, 10530, 8582, 3382,
    11934, 9741, 8058, 3637, 3459, 145, 6747, 9558, 8357, 7399, 6378, 9447, 480, 1022, 9,
    9821, 339, 5791, 544, 10616, 4278, 6958, 7300, 8112, 8705, 1381, 9764, 11336, 8541, 827,
    5767, 2476, 118, 2197, 7222, 3949, 8993, 4452, 2396, 7935, 130, 2837, 6915, 2401, 442,
    7188, 11222, 390, 773, 8456, 3778, 354, 4861, 9377, 5698, 5012, 9808, 2859, 11244, 1017,
    7404, 1632, 7205, 27, 9223, 8526, 10849, 1537, 242, 4714, 8146, 9611, 3704, 5019, 11744,
    1002, 5011, 5088, 8005, 7313, 10682, 8509, 11414, 9852, 3646, 6022, 2987, 9723, 10102,
    6250, 9867, 11224, 2143, 11885, 7644, 1168, 5277, 11082, 3248, 493, 8193, 6845, 2381,
    7952, 11854, 1378, 1912, 2166, 3915, 12176, 7370, 12129, 3149, 12286, 4437, 3636, 4938,
    5291, 2704, 10863, 7635, 1663, 10512, 3364, 1689, 4057, 9018, 9442, 7875, 2174, 4372,
    7247, 9984, 4053, 2645, 5195, 9509, 7394, 1484, 9042, 9603, 8311, 9320, 9919, 2865, 5332,
    3510, 1630, 10163, 5407, 3186, 11136, 9405, 10040, 8241, 9890, 8889, 7098, 9153, 9289,
    671, 3016, 243, 6730, 420, 10111, 1544, 3985, 4905, 3531, 476, 49, 1263, 5915, 1483, 9789,
    10800, 10706, 6347, 1512, 350, 10474, 5383, 5369, 10232, 9087, 4493, 9551, 6421, 6554,
    2655, 9280, 1693, 174, 723, 10314, 8532, 347, 2925, 8974, 11863, 1858, 4754, 3030, 4115,
    2361, 10446, 2908, 218, 3434, 8760, 3963, 576, 6142, 9842, 1954, 10238, 9407, 10484, 3991,
    8320, 9522, 156, 2281, 5876, 10258, 5333, 3772, 418, 5908, 11836, 5429, 7515, 7552, 1293,
    295, 6099, 5766, 652, 8273, 4077, 8527, 9370, 325, 10885, 11143, 11341, 5990, 1159, 8561,
    8240, 3329, 4298, 12121, 2692, 5961, 7183, 10327, 1594, 6167, 9734, 7105, 11089, 1360,
    3956, 6170, 5297, 8210, 11231, 922, 441, 1958, 4322, 1112, 2078, 4046, 709, 9139, 1319,
    4240, 8719, 6224, 11454, 2459, 683, 3656, 12225, 10723, 5782, 9341, 9786, 9166, 10542,
    9235, 6803, 7856, 6370, 3834, 7032, 7048, 9369, 8120, 9162, 6821, 1010, 8807, 787, 5057,
    4698, 4780, 8844, 12097, 1321, 4912, 10240, 677, 6415, 6234, 8953, 1323, 9523, 12237,
    3174, 1579, 11858, 9784, 5906, 3957, 9450, 151, 10162, 12231, 12048, 3532, 11286, 1956,
    7280, 11404, 6281, 3477, 6608, 142, 11184, 9445, 3438, 11314, 4212, 9260, 6695, 4782,
    5886, 8076, 504, 2302, 11684, 11868, 8209, 3602, 6068, 8689, 3263, 6077, 7665, 7822, 7500,
    6752, 4749, 4449, 6833, 12142, 8500, 6118, 8471, 1190, 9606, 3860, 5445, 7753, 11239,
    5079, 9027, 2169, 11767, 7965, 4916, 8214, 5315, 11011, 9945, 1973, 6715, 8775, 11248,
    5925, 11271, 654, 3565, 1702, 1987, 6760, 5206, 3199, 12233, 6136, 6427, 6874, 8646, 4948,
    6152, 400, 10561, 5339, 5446, 3710, 6093, 468, 8301, 316, 11907, 10256, 8291, 3879, 1922,
    10930, 6854, 973, 11035, 7, 1936, 845, 3723, 3154, 5054, 3285, 7929, 216, 50, 6763, 769,
    767, 8484, 10076, 4153, 3120, 6184, 6203, 5646, 8348, 3753, 3536, 5370, 3229, 4730, 10583,
    3929, 1282, 8717, 2021, 9457, 3944, 4099, 5604, 6759, 2171, 8809, 11024, 3007, 9344, 5349,
    2633, 1406, 9057, 11996, 4855, 8520, 9348, 11722, 6627, 5289, 3837, 2595, 3221, 4273,
    4050, 7082, 844, 5202, 11309, 11607, 4590, 7207, 8820, 6138, 7846, 8871, 4693, 2338, 9996,
    11872, 1802, 1555, 5103, 10398, 7878, 10699, 1223, 9955, 11009, 614, 12265, 10918, 11385,
    9804, 6742, 7250, 881, 11924, 1015, 10362, 5461, 9343, 2637, 7779, 4684, 3360, 7154, 63,
    7302, 2373, 3670, 3808, 578, 5368, 11839, 1944, 7628, 11779, 9667, 6903, 5618, 10631,
    5789, 3502, 5043, 826, 3090, 1398, 3065, 1506, 6586, 4483, 6389, 910, 7570, 11538, 4518,
    3094, 1160, 4820, 2730, 5411, 10036, 1868, 2478, 9449, 4194, 3019, 10506, 7211, 7724,
    4974, 7119, 2672, 11424, 1279, 189, 3116, 10526, 2209, 10759, 1694, 8420, 7866, 5832,
    1350, 10555, 8474, 7014, 10499, 11038, 6879, 2035, 1040, 10407, 6164, 7519, 944, 5287,
    8620, 6616, 9269, 6883, 7624, 4834, 2712, 9461, 4352, 8176, 72, 3840, 10447, 3451, 8195,
    11048, 4378, 6508, 9244, 9646, 1095, 2873, 2827, 11498, 2434, 11169, 9754, 12268, 6481,
    874, 9988, 170, 6639, 2307, 4289, 11641, 12139, 11259, 11823, 3821, 1681, 4649, 5969,
    2929, 6026, 1573, 8443, 3793, 6226, 11787, 5118, 2602, 10388, 1849, 5776, 9021, 3795,
    7988, 7766, 457, 12281, 11410, 9696, 982, 10013, 4218, 4390, 8835, 8531, 7785, 778, 530,
    2626, 3578, 4697, 8823, 1701, 10243, 2940, 9332, 10808, 3317, 9757, 139, 3332, 343, 8841,
    4538, 10381, 7078, 1866, 1208, 7562, 10584, 2450, 11873, 814, 716, 10179, 2164, 6873,
    5412, 8080, 9011, 6296, 3515, 11851, 1218, 5061, 10753, 10568, 2429, 8186, 1373, 9307,
    717, 8700, 8921, 4227, 4238, 11677, 8067, 1526, 11749, 12164, 3163, 4032, 6127, 7449,
    1389, 10221, 4404, 11943, 3359, 9084, 5209, 1092, 3678, 4265, 10361, 464, 1826, 2926,
    4489, 9118, 1136, 3449, 3708, 9051, 2065, 5826, 3495, 4564, 8755, 3961, 10533, 4145, 2275,
    2461, 4267, 5653, 5063, 8113, 10771, 8524, 11014, 5508, 11113, 6555, 4860, 1125, 10844,
    11158, 6302, 6693, 579, 3889, 9520, 3114, 6323, 212, 8314, 4883, 6454, 3087, 1417, 5676,
    7784, 2257, 3744, 4963, 2528, 9233, 5102, 11877, 6701, 6444, 4924, 4781, 1014, 11841,
    1327, 3607, 3942, 7057, 2717, 60, 3200, 10754, 5836, 7723, 2260, 68, 180, 4138, 7684,
    2689, 10880, 7070, 204, 5509, 10821, 8308, 8882, 463, 10945, 9247, 9806, 10235, 4739,
    8038, 6771, 1226, 9261, 5216, 11925, 9929, 11053, 9272, 7043, 4475, 3121, 4705, 1057,
    9689, 11883, 10602, 146, 5268, 1403, 1804, 6094, 7100, 12050, 9389, 994, 4554, 4670,
    11777, 5464, 4906, 3375, 9998, 8896, 4335, 7376, 3528, 3825, 8054, 9342, 8307, 636, 5609,
    11667, 10552, 5672, 4499, 5598, 3344, 10397, 8665, 6565, 10964, 11260, 10344, 5959, 10141,
    8330, 5797, 2442, 1248, 5115, 4939, 10975, 1744, 2894, 8635, 6599, 9834, 8342, 338, 3343,
    8170, 1522, 10138, 12269, 5002, 4608, 5163, 4578, 377, 11914, 1620, 10453, 11864, 10104,
    11897, 6085, 8122, 11251, 11366, 10058, 6197, 2800, 193, 506, 1255, 1392, 5784, 3276,
    8951, 2212, 9615, 10347, 8881, 2575, 1165, 2776, 11111, 6811, 3511
]
RTL_TF_ROM = [
    10810, 7143, 4043, 10984, 722, 5736, 8155, 3542, 8785, 9744, 3621, 10643, 1212, 3195,
    5860, 7468, 2639, 9664, 11340, 11726, 9314, 9283, 9545, 5728, 7698, 5023, 5828, 8961,
    6512, 7311, 1351, 2319, 11119, 11334, 11499, 9088, 3014, 5086, 10963, 4846, 9542, 9154,
    3712, 4805, 8736, 11227, 9995, 3091, 12208, 7969, 11289, 9326, 7393, 9238, 2366, 11112,
    8034, 10654, 9521, 12149, 10436, 7678, 11563, 1260, 4388, 4632, 6534, 2426, 334, 1428,
    1696, 2013, 9000, 729, 3241, 2881, 3284, 7197, 10200, 8595, 7110, 10530, 8582, 3382,
    11934, 9741, 8058, 3637, 3459, 145, 6747, 9558, 8357, 7399, 6378, 9447, 480, 1022, 9,
    9821, 339, 5791, 544, 10616, 4278, 6958, 7300, 8112, 8705, 1381, 9764, 11336, 8541, 827,
    5767, 2476, 118, 2197, 7222, 3949, 8993, 4452, 2396, 7935, 130, 2837, 6915, 2401, 442,
    7188, 11222, 390, 773, 8456, 3778, 354, 4861, 9377, 5698, 5012, 9808, 2859, 11244, 1017,
    7404, 1632, 7205, 27, 9223, 8526, 10849, 1537, 242, 4714, 8146, 9611, 3704, 5019, 11744,
    1002, 5011, 5088, 8005, 7313, 10682, 8509, 11414, 9852, 3646, 6022, 2987, 9723, 10102,
    6250, 9867, 11224, 2143, 11885, 7644, 1168, 5277, 11082, 3248, 493, 8193, 6845, 2381,
    7952, 11854, 1378, 1912, 2166, 3915, 12176, 7370, 12129, 3149, 12286, 4437, 3636, 4938,
    5291, 2704, 10863, 7635, 1663, 10512, 3364, 1689, 4057, 9018, 9442, 7875, 2174, 4372,
    7247, 9984, 4053, 2645, 5195, 9509, 7394, 1484, 9042, 9603, 8311, 9320, 9919, 2865, 5332,
    3510, 1630, 10163, 5407, 3186, 11136, 9405, 10040, 8241, 9890, 8889, 7098, 9153, 9289,
    671, 3016, 243, 6730, 420, 10111, 1544, 3985, 4905, 3531, 476, 49, 1263, 5915, 1483, 9789,
    10800, 10706, 6347, 1512, 350, 10474, 5383, 5369, 10232, 9087, 4493, 9551, 6421, 6554,
    2655, 9280, 1693, 174, 723, 10314, 8532, 347, 2925, 8974, 11863, 1858, 4754, 3030, 4115,
    2361, 10446, 2908, 218, 3434, 8760, 3963, 576, 6142, 9842, 1954, 10238, 9407, 10484, 3991,
    8320, 9522, 156, 2281, 5876, 10258, 5333, 3772, 418, 5908, 11836, 5429, 7515, 7552, 1293,
    295, 6099, 5766, 652, 8273, 4077, 8527, 9370, 325, 10885, 11143, 11341, 5990, 1159, 8561,
    8240, 3329, 4298, 12121, 2692, 5961, 7183, 10327, 1594, 6167, 9734, 7105, 11089, 1360,
    3956, 6170, 5297, 8210, 11231, 922, 441, 1958, 4322, 1112, 2078, 4046, 709, 9139, 1319,
    4240, 8719, 6224, 11454, 2459, 683, 3656, 12225, 10723, 5782, 9341, 9786, 9166, 10542,
    9235, 6803, 7856, 6370, 3834, 7032, 7048, 9369, 8120, 9162, 6821, 1010, 8807, 787, 5057,
    4698, 4780, 8844, 12097, 1321, 4912, 10240, 677, 6415, 6234, 8953, 1323, 9523, 12237,
    3174, 1579, 11858, 9784, 5906, 3957, 9450, 151, 10162, 12231, 12048, 3532, 11286, 1956,
    7280, 11404, 6281, 3477, 6608, 142, 11184, 9445, 3438, 11314, 4212, 9260, 6695, 4782,
    5886, 8076, 504, 2302, 11684, 11868, 8209, 3602, 6068, 8689, 3263, 6077, 7665, 7822, 7500,
    6752, 4749, 4449, 6833, 12142, 8500, 6118, 8471, 1190, 9606, 3860, 5445, 7753, 11239,
    5079, 9027, 2169, 11767, 7965, 4916, 8214, 5315, 11011, 9945, 1973, 6715, 8775, 11248,
    5925, 11271, 654, 3565, 1702, 1987, 6760, 5206, 3199, 12233, 6136, 6427, 6874, 8646, 4948,
    6152, 400, 10561, 5339, 5446, 3710, 6093, 468, 8301, 316, 11907, 10256, 8291, 3879, 1922,
    10930, 6854, 973, 11035, 7, 1936, 845, 3723, 3154, 5054, 3285, 7929, 216, 50, 6763, 769,
    767, 8484, 10076, 4153, 3120, 6184, 6203, 5646, 8348, 3753, 3536, 5370, 3229, 4730, 10583,
    3929, 1282, 8717, 2021, 9457, 3944, 4099, 5604, 6759, 2171, 8809, 11024, 3007, 9344, 5349,
    2633, 1406, 9057, 11996, 4855, 8520, 9348, 11722, 6627, 5289, 3837, 2595, 3221, 4273,
    4050, 7082, 844, 5202, 11309, 11607, 4590, 7207, 8820, 6138, 7846, 8871, 4693, 2338, 9996,
    11872, 1802, 1555, 5103, 10398, 7878, 10699, 1223, 9955, 11009, 614, 12265, 10918, 11385,
    9804, 6742, 7250, 881, 11924, 1015, 10362, 5461, 9343, 2637, 7779, 4684, 3360, 7154, 63,
    7302, 2373, 3670, 3808, 578, 5368, 11839, 1944, 7628, 11779, 9667, 6903, 5618, 10631,
    5789, 3502, 5043, 826, 3090, 1398, 3065, 1506, 6586, 4483, 6389, 910, 7570, 11538, 4518,
    3094, 1160, 4820, 2730, 5411, 10036, 1868, 2478, 9449, 4194, 3019, 10506, 7211, 7724,
    4974, 7119, 2672, 11424, 1279, 189, 3116, 10526, 2209, 10759, 1694, 8420, 7866, 5832,
    1350, 10555, 8474, 7014, 10499, 11038, 6879, 2035, 1040, 10407, 6164, 7519, 944, 5287,
    8620, 6616, 9269, 6883, 7624, 4834, 2712, 9461, 4352, 8176, 72, 3840, 10447, 3451, 8195,
    11048, 4378, 6508, 9244, 9646, 1095, 2873, 2827, 11498, 2434, 11169, 9754, 12268, 6481,
    874, 9988, 170, 6639, 2307, 4289, 11641, 12139, 11259, 11823, 3821, 1681, 4649, 5969,
    2929, 6026, 1573, 8443, 3793, 6226, 11787, 5118, 2602, 10388, 1849, 5776, 9021, 3795,
    7988, 7766, 457, 12281, 11410, 9696, 982, 10013, 4218, 4390, 8835, 8531, 7785, 778, 530,
    2626, 3578, 4697, 8823, 1701, 10243, 2940, 9332, 10808, 3317, 9757, 139, 3332, 343, 8841,
    4538, 10381, 7078, 1866, 1208, 7562, 10584, 2450, 11873, 814, 716, 10179, 2164, 6873,
    5412, 8080, 9011, 6296, 3515, 11851, 1218, 5061, 10753, 10568, 2429, 8186, 1373, 9307,
    717, 8700, 8921, 4227, 4238, 11677, 8067, 1526, 11749, 12164, 3163, 4032, 6127, 7449,
    1389, 10221, 4404, 11943, 3359, 9084, 5209, 1092, 3678, 4265, 10361, 464, 1826, 2926,
    4489, 9118, 1136, 3449, 3708, 9051, 2065, 5826, 3495, 4564, 8755, 3961, 10533, 4145, 2275,
    2461, 4267, 5653, 5063, 8113, 10771, 8524, 11014, 5508, 11113, 6555, 4860, 1125, 10844,
    11158, 6302, 6693, 579, 3889, 9520, 3114, 6323, 212, 8314, 4883, 6454, 3087, 1417, 5676,
    7784, 2257, 3744, 4963, 2528, 9233, 5102, 11877, 6701, 6444, 4924, 4781, 1014, 11841,
    1327, 3607, 3942, 7057, 2717, 60, 3200, 10754, 5836, 7723, 2260, 68, 180, 4138, 7684,
    2689, 10880, 7070, 204, 5509, 10821, 8308, 8882, 463, 10945, 9247, 9806, 10235, 4739,
    8038, 6771, 1226, 9261, 5216, 11925, 9929, 11053, 9272, 7043, 4475, 3121, 4705, 1057,
    9689, 11883, 10602, 146, 5268, 1403, 1804, 6094, 7100, 12050, 9389, 994, 4554, 4670,
    11777, 5464, 4906, 3375, 9998, 8896, 4335, 7376, 3528, 3825, 8054, 9342, 8307, 636, 5609,
    11667, 10552, 5672, 4499, 5598, 3344, 10397, 8665, 6565, 10964, 11260, 10344, 5959, 10141,
    8330, 5797, 2442, 1248, 5115, 4939, 10975, 1744, 2894, 8635, 6599, 9834, 8342, 338, 3343,
    8170, 1522, 10138, 12269, 5002, 4608, 5163, 4578, 377, 11914, 1620, 10453, 11864, 10104,
    11897, 6085, 8122, 11251, 11366, 10058, 6197, 2800, 193, 506, 1255, 1392, 5784, 3276,
    8951, 2212, 9615, 10347, 8881, 2575, 1165, 2776, 11111, 6811, 3511
]


# ---------------------------------------------------------------------------
# z3 helper: a property is PROVEN when the negation is UNSAT.  We bit-blast so
# every pure bit-vector obligation is decidable (never accept 'unknown').
# ---------------------------------------------------------------------------
def _qfbv_solver():
    return Then('simplify', 'bit-blast', 'smt').solver()


def prove_unsat(name, constraints):
    s = _qfbv_solver()
    s.add(*constraints)
    r = s.check()
    if r == unsat:
        return True, ""
    if r == sat:
        return False, "%s: z3 found a violating model %s" % (name, s.model())
    return False, "%s: z3 returned 'unknown' (encoding not decided)" % name


# ---------------------------------------------------------------------------
# Exact gate models of the two combinational modular units, reused by the
# compact_bf routing check (I).  14-bit in, 14-bit out.
# ---------------------------------------------------------------------------
def zadd_gate(x, y):
    """modular_add.v: {c,s}=x+y; {b,d}=s-M; sel=~((~c)&b); z=sel?d:s   [src]"""
    M15 = BitVecVal(Q, 15)
    sum15 = ZeroExt(1, x) + ZeroExt(1, y)          # {c,s}
    c = Extract(14, 14, sum15)
    s = Extract(13, 0, sum15)
    diff = ZeroExt(1, s) - M15                      # {b,d} = s - M
    b = Extract(14, 14, diff)
    d = Extract(13, 0, diff)
    sel = ~((~c) & b)
    return If(sel == BitVecVal(1, 1), d, s)


def zsub_gate(x, y):
    """modular_substraction.v: {b,d}=x-y; q=b?M:0; {c,z}=d+q (carry c dropped)
    — the correction constant is MUXED, exactly as in the RTL.           [src]"""
    diff15 = ZeroExt(1, x) - ZeroExt(1, y)
    b = Extract(14, 14, diff15)                     # borrow (1 => x < y)
    d = Extract(13, 0, diff15)
    qmux = If(b == BitVecVal(1, 1), BitVecVal(Q, 14), BitVecVal(0, 14))
    return Extract(13, 0, ZeroExt(1, d) + ZeroExt(1, qmux))


# ===========================================================================
# TIER 1 (A) modular_add.v — exact gate model, prove == (x+y) mod q
# ===========================================================================
def check_modular_add():
    x = BitVec('x', 14)
    y = BitVec('y', 14)
    sum15 = ZeroExt(1, x) + ZeroExt(1, y)
    gold = If(UGE(sum15, BitVecVal(Q, 15)),
              Extract(13, 0, sum15 - BitVecVal(Q, 15)), Extract(13, 0, sum15))
    pre = And(ULT(x, BitVecVal(Q, 14)), ULT(y, BitVecVal(Q, 14)))
    return prove_unsat("modular_add", [pre, zadd_gate(x, y) != gold])


# ===========================================================================
# TIER 1 (B) modular_substraction.v — exact gate model, prove == (x-y) mod q
# ===========================================================================
def check_modular_sub():
    x = BitVec('x', 14)
    y = BitVec('y', 14)
    # golden: (x - y + q) mod q on a wider unsigned word (no Int/BV mixing)
    gold = URem(ZeroExt(2, x) - ZeroExt(2, y) + BitVecVal(Q, 16), BitVecVal(Q, 16))
    pre = And(ULT(x, BitVecVal(Q, 14)), ULT(y, BitVecVal(Q, 14)))
    return prove_unsat("modular_sub", [pre, ZeroExt(2, zsub_gate(x, y)) != gold])


# ===========================================================================
# TIER 1 (C) modular_half.v / op21 — exact gate model, prove == x * 2^-1 mod q
#   x_sh = x>>1 ; {c,s} = x_sh + (M+1)/2 ; y = x[0] ? s : x_sh
#   (2^-1 mod q == (q+1)/2 == 6145.)  This is the model's op21; note the
#   module is NOT instantiated in the radix-2 RTL datapath (see check I).
# ===========================================================================
def check_modular_half():
    INV2 = (Q + 1) // 2                             # 6145
    a = BitVec('a', 14)
    xsh = LShR(a, 1)                                # a >> 1
    s = Extract(13, 0, ZeroExt(1, xsh) + BitVecVal(INV2, 15))
    y = If(Extract(0, 0, a) == BitVecVal(1, 1), s, xsh)
    gold = URem(ZeroExt(18, a) * BitVecVal(INV2, 32), BitVecVal(Q, 32))
    pre = ULT(a, BitVecVal(Q, 14))
    return prove_unsat("modular_half", [pre, ZeroExt(18, y) != gold])


# ===========================================================================
# TIER 1 (D1) modular_mul.v — EXACT RTL Barrett datapath, all z <= (q-1)^2.
#
# The RTL is NOT the textbook Barrett t=(z*mu)>>28: it pre-truncates
# (z_shift = z>>13 BEFORE multiplying by q0=15'h5553), truncates the
# remainder to 15 bits (sub[14:0]) and does ONE conditional subtraction.
# The margin is tight (the quotient estimate loses up to ~z*2.1e-5 + 1),
# so r < 2q is a real proof obligation, not a textbook fact.
#
# z is a FREE 28-bit variable with z <= (q-1)^2, which covers every product
# a*b with a,b < q while keeping every obligation a CONSTANT multiplication
# (no symbolic 14x14 multiplier to bit-blast).  DFFs are pure pipeline delay.
# ===========================================================================
def check_modular_mul_rtl():
    z = BitVec('z', 28)
    q28 = BitVecVal(Q, 28)
    pre = ULE(z, BitVecVal((Q - 1) * (Q - 1), 28))

    # wire [14:0] z_shift = z >> 13   (28->15: lossless for ANY 28-bit z)
    z_shift = Extract(14, 0, LShR(z, 13))
    # wire [28:0] mul2 = z_shift * q0 — the full product needs 30 bits, the
    # wire keeps 29.  Obligation 1: bit 29 of the true product is 0 under pre
    # (WITHOUT the pre this genuinely truncates — reduced inputs are required).
    prod30 = ZeroExt(15, z_shift) * BitVecVal(Q0, 30)
    ob_mul2_fits = Extract(29, 29, prod30) == BitVecVal(0, 1)
    mul2 = Extract(28, 0, prod30)                   # the 29-bit wire value
    # wire [13:0] mul2_shift = mul2 >> 15   (29->14: exact)
    t = Extract(13, 0, LShR(mul2, 15))              # quotient estimate
    # wire [27:0] mul3 = mul2_shift * q      (14x14 -> 28: exact)
    mul3 = ZeroExt(14, t) * q28
    # Obligation 2: no underflow in sub = z - mul3, i.e. t*q <= z.
    ob_no_underflow = ULE(mul3, z)
    sub = z - mul3                                  # = r, exact given ob 2
    # Obligation 3: r < 2q  (=> sub[14:0] lossless AND one cond. sub enough)
    ob_lt_2q = ULT(sub, BitVecVal(2 * Q, 28))
    # Bit-exact output stage:
    #   sub_low = sub[14:0] ; {sign,sub_correct} = sub_low - q ;
    #   P_d = sign ? sub_low[13:0] : sub_correct
    sub_low = Extract(14, 0, sub)
    diff15 = sub_low - BitVecVal(Q, 15)
    sign = Extract(14, 14, diff15)
    sub_correct = Extract(13, 0, diff15)
    P_d = If(sign == BitVecVal(1, 1), Extract(13, 0, sub_low), sub_correct)
    # Obligation 4: the output equals the corrected remainder and is reduced.
    # With r = z - t*q exact (ob 2) and output = r or r-q (ob 4), output is
    # congruent to z mod q; with output < q it IS z mod q.
    gold = If(ULT(sub, q28), sub, sub - q28)
    ob_output = And(ZeroExt(14, P_d) == gold, ULT(gold, q28))

    bad = Not(And(ob_mul2_fits, ob_no_underflow, ob_lt_2q, ob_output))
    return prove_unsat("modular_mul_rtl", [pre, bad])


# ===========================================================================
# TIER 1 (D2) modular_mul.v — the same datapath bit-exact in plain ints,
# cross-checked against (a*b) mod q (grounds the z3 transcription itself).
# ===========================================================================
def _mul_rtl_int(a, b):
    z = (a * b) & ((1 << 28) - 1)
    z_shift = (z >> 13) & 0x7FFF
    mul2 = (z_shift * Q0) & ((1 << 29) - 1)
    t = (mul2 >> 15) & 0x3FFF
    mul3 = (t * Q) & ((1 << 28) - 1)
    sub = (z - mul3) & ((1 << 28) - 1)
    sub_low = sub & 0x7FFF
    diff = (sub_low - Q) & 0x7FFF
    sign = (diff >> 14) & 1
    return (sub_low & 0x3FFF) if sign == 1 else (diff & 0x3FFF)


def check_modular_mul_concrete():
    edges = [0, 1, 2, 3, 6144, 6145, Q - 2, Q - 1]
    pairs = [(a, b) for a in edges for b in edges]
    rng = random.Random(1)
    pairs += [(rng.randrange(Q), rng.randrange(Q)) for _ in range(20000)]
    for a, b in pairs:
        got = _mul_rtl_int(a, b)
        want = (a * b) % Q
        if got != want:
            return False, ("modular_mul concrete: rtl(%d,%d)=%d != %d"
                           % (a, b, got, want))
    return True, ""


# ===========================================================================
# TIER 1 (E) conflict-free memory map  (conflict_free_memory_map.v):
#            bank = parity of the 10-bit address, offset = address >> 1.
# ===========================================================================
def _parity10(a):
    p = Extract(0, 0, a)
    for i in range(1, 10):
        p = p ^ Extract(i, i, a)
    return p                                        # BV1 = bank number


def check_cfmap_bijection():
    # (bank, offset) is injective over the full 10-bit address space.
    a = BitVec('a', 10)
    b = BitVec('b', 10)
    same_bank = _parity10(a) == _parity10(b)
    same_off = Extract(9, 1, a) == Extract(9, 1, b)        # addr >> 1
    return prove_unsat("cfmap_bijection", [a != b, same_bank, same_off])


def check_cfmap_conflict_free():
    # For EVERY power-of-two stride 2^p: an address with bit p = 0 and its
    # partner (bit p = 1) land in DIFFERENT banks (pure parity property).
    for p in range(10):
        a = BitVec('a_%d' % p, 10)
        mask = BitVecVal(1 << p, 10)
        op0 = a & ~mask
        op1 = op0 | mask
        ok, msg = prove_unsat(
            "cfmap_stride_2^%d" % p,
            [_parity10(op0) == _parity10(op1)],      # same bank -> must be UNSAT
        )
        if not ok:
            return False, msg
    return True, ""


# ===========================================================================
# TIER 1 (F) address_generator.v — EXACT case-statement model.
#   addr0 = ((k<<1)<<p) + i ;  addr1 = {addr0[9:p+1], 1'b1, addr0[p-1:0]}
# Under the FSM ranges (k < 2^(9-p) butterfly groups, i < 2^p within a
# group — the model's k / j loop bounds), prove per stage p:
#   no 10-bit overflow;  addr0[p] == 0;  addr1 == addr0 | (1<<p);
#   banks differ;  and (k,i) -> addr0 is injective.
# ===========================================================================
def _addr1_case(addr0, p):
    one = BitVecVal(1, 1)
    if p == 0:
        return Concat(Extract(9, 1, addr0), one)
    if p == 9:
        return Concat(one, Extract(8, 0, addr0))
    return Concat(Extract(9, p + 1, addr0), one, Extract(p - 1, 0, addr0))


def check_address_generator():
    for p in range(10):
        k = BitVec('k_%d' % p, 20)
        i = BitVec('i_%d' % p, 20)
        pre = And(ULT(k, BitVecVal(1 << (9 - p), 20)),
                  ULT(i, BitVecVal(1 << p, 20)))
        wide = (k << (p + 1)) + i                    # exact at 20 bits
        addr0 = Extract(9, 0, wide)
        addr1 = _addr1_case(addr0, p)
        props = And(
            ULT(wide, BitVecVal(1024, 20)),          # fits the 10-bit wire
            Extract(p, p, addr0) == BitVecVal(0, 1),  # operand-0 bit p is 0
            addr1 == (addr0 | BitVecVal(1 << p, 10)),  # partner at stride 2^p
            _parity10(addr0) != _parity10(addr1),    # different banks
        )
        ok, msg = prove_unsat("address_generator p=%d" % p, [pre, Not(props)])
        if not ok:
            return False, msg
        # injectivity: two (k,i) with the same addr0 must be the same pair,
        # so each stage enumerates every butterfly pair exactly once
        # (512 pairs onto the 512 addresses with bit p = 0).
        k2 = BitVec('k2_%d' % p, 20)
        i2 = BitVec('i2_%d' % p, 20)
        pre2 = And(ULT(k2, BitVecVal(1 << (9 - p), 20)),
                   ULT(i2, BitVecVal(1 << p, 20)))
        wide2 = (k2 << (p + 1)) + i2
        ok, msg = prove_unsat(
            "address_generator injective p=%d" % p,
            [pre, pre2, wide == wide2, Or(k != k2, i != i2)],
        )
        if not ok:
            return False, msg
    return True, ""


# ===========================================================================
# TIER 1 (G) tf_address_generator.v — EXACT case constants, per stage p.
# The model's DIT r-counter starts at 1 and increments; its DIF r-counter
# starts at len(w_rom)-1 = 1023 and decrements.  Stage p (J = 2^p) does
# 2^(9-p) reads, so:
#   model DIT k-th read:  r = 2^(9-p) + k      (k = 0 .. 2^(9-p)-1)
#   model DIF k-th read:  r = 2^(10-p) - 1 - k
# The RTL case table is  NTT: k + (2^(9-p)-1),  INTT: (2^(10-p)-2) - k
# (p=9 INTT is literally `k`, i.e. 0 for the single read) — exactly
# model_r - 1 in both modes, always inside the 1023-deep ROM.
# ===========================================================================
def check_tf_addressing():
    ntt_const = {9: 0, 8: 1, 7: 3, 6: 7, 5: 15, 4: 31,
                 3: 63, 2: 127, 1: 255, 0: 511}      # RTL: k + const   [src]
    intt_const = {8: 2, 7: 6, 6: 14, 5: 30, 4: 62,
                  3: 126, 2: 254, 1: 510, 0: 1022}   # RTL: const - k   [src]
    for p in range(10):
        k = BitVec('k_%d' % p, 20)
        pre = ULT(k, BitVecVal(1 << (9 - p), 20))
        ntt = k + BitVecVal(ntt_const[p], 20)
        model_dit_r = BitVecVal(1 << (9 - p), 20) + k
        if p == 9:
            intt = k                                 # case p=9: reg_1 = k [src]
        else:
            intt = BitVecVal(intt_const[p], 20) - k
        model_dif_r = BitVecVal((1 << (10 - p)) - 1, 20) - k
        props = And(
            ntt == model_dit_r - BitVecVal(1, 20),   # ROM[model_r - 1]
            intt == model_dif_r - BitVecVal(1, 20),
            ULT(ntt, BitVecVal(1023, 20)),           # inside the 1023-deep ROM
            ULT(intt, BitVecVal(1023, 20)),
        )
        ok, msg = prove_unsat("tf_address p=%d" % p, [pre, Not(props)])
        if not ok:
            return False, msg
    return True, ""


# ===========================================================================
# TIER 1 (H) twiddle ROM grounding — ALL entries of BOTH source tables.
#   derived[i] = psi^bitrev(i,10) mod q (psi = kesai = 7)
#   == model w_rom entry-for-entry (1024), and the RTL tf_ROM.v case table
#   == w_rom[1..1023] entry-for-entry (the -1 offset proven in (G);
#   w_rom[0] = 1 is the unused identity entry).
# ===========================================================================
def check_twiddle_roms():
    if len(SRC_W_ROM) != 1024 or len(RTL_TF_ROM) != 1023:
        return False, ("rom tables: bad lengths %d/%d"
                       % (len(SRC_W_ROM), len(RTL_TF_ROM)))
    if SRC_W_ROM[0] != 1:
        return False, "rom tables: w_rom[0] = %d != 1" % SRC_W_ROM[0]
    for i in range(1024):
        d = pow(KESAI, bitrev(i, 10), Q)
        if d != SRC_W_ROM[i]:
            return False, ("rom tables: derived psi^bitrev w_rom[%d]=%d "
                           "!= source %d" % (i, d, SRC_W_ROM[i]))
    for a in range(1023):
        if RTL_TF_ROM[a] != SRC_W_ROM[a + 1]:
            return False, ("rom tables: RTL tf_ROM[%d]=%d != w_rom[%d]=%d"
                           % (a, RTL_TF_ROM[a], a + 1, SRC_W_ROM[a + 1]))
    return True, ""


# ===========================================================================
# TIER 1 (I) compact_bf.v routing — exact mux/operand-order dataflow model.
# DFF / shift_4 delays are pipeline alignment only and abstracted to
# identity; the multiplier output is a FREE m < q (its value is pinned to
# (A*B) mod q by check D1).  Proves, at the gate level of zadd/zsub:
#   sel=0 (NTT):  (bf_lower, bf_upper) = (add(u,m), sub(u,m)), mult <- (v, w)
#                 with m = v*w mod q  =>  (u + v*w, u - v*w)  = model DIT bf
#   sel=1 (INTT): (bf_lower, bf_upper) = (add(u,v), m), mult <- (sub(v,u), w)
#                 with m = (v-u)*w mod q  =>  (u + v, (v-u)*w) = model DIF bf
#                 WITHOUT op21 halving (modular_half.v is not instantiated
#                 in the radix-2 RTL) — documented divergence, see NOTE.
# The sel=1 subtraction operand order (v-u, NOT u-v) matches the model's
# op21(t - u) * w.
# ===========================================================================
def check_compact_bf_routing():
    u = BitVec('u', 14)
    v = BitVec('v', 14)
    m = BitVec('m', 14)                              # mult_out, free (see D1)
    sel = BitVec('sel', 1)
    zero = BitVecVal(0, 1)
    # netlist (delays -> identity): mux_out1 = u (both branches are u)
    sub_op1 = If(sel == zero, u, v)                  # mux_out1 / mux_out5
    sub_op2 = If(sel == zero, m, u)
    sub_out = zsub_gate(sub_op1, sub_op2)
    add_out = zadd_gate(u, If(sel == zero, m, v))    # mux_out2
    bf_lower = add_out                               # (q1 vs q5 delay only)
    bf_upper = If(sel == zero, sub_out, m)
    mult_a = If(sel == zero, v, sub_out)             # mux_out3
    pre = And(ULT(u, BitVecVal(Q, 14)), ULT(v, BitVecVal(Q, 14)),
              ULT(m, BitVecVal(Q, 14)))
    ntt_props = And(bf_lower == zadd_gate(u, m),
                    bf_upper == zsub_gate(u, m),
                    mult_a == v)
    intt_props = And(bf_lower == zadd_gate(u, v),
                     bf_upper == m,
                     mult_a == zsub_gate(v, u))      # (v-u), operand order!
    bad = Or(And(sel == zero, Not(ntt_props)),
             And(sel == BitVecVal(1, 1), Not(intt_props)))
    ok, msg = prove_unsat("compact_bf_routing", [pre, bad])
    if ok:
        sys.stderr.write(
            "NOTE compact_bf.v INTT mode computes (u+v, (v-u)*w) with NO "
            "per-stage op21 halving\n     (modular_half.v is defined but "
            "instantiated nowhere in the radix-2 RTL); the\n     model's "
            "DIF_RN_INTT applies op21 every stage — a real model-vs-RTL "
            "scaling divergence\n     in the released source, flagged here, "
            "not hidden.\n")
    return ok, msg


# ===========================================================================
# TIER 2 reference: the source's EXACT functions (poly_mult_radix_2.py),
# parameterised by q and the twiddle table.
# ===========================================================================
def op21(a, q):
    if a & 1 == 0:
        r = (a >> 1) % q
    else:
        r = ((a >> 1) + ((q + 1) >> 1)) % q
    return r


def DIT_NR_NTT(a, w_rom, q):
    n = len(a)
    log_n = n.bit_length() - 1
    r = 1
    for p in range(log_n - 1, -1, -1):
        J = 1 << p
        for k in range(n // (2 * J)):
            w = w_rom[r]
            r += 1
            for j in range(J):
                u = a[k * 2 * J + j] % q
                t = (a[k * 2 * J + j + J] * w) % q
                a[k * 2 * J + j] = (u + t) % q
                a[k * 2 * J + j + J] = (u - t) % q
    return a


def DIF_RN_INTT(a, w_rom, q):
    n = len(a)
    log_n = n.bit_length() - 1
    r = len(w_rom) - 1
    for i in range(log_n):
        J = 1 << i
        for k in range(n // (2 * J)):
            w = w_rom[r]
            r -= 1
            for j in range(J):
                u = a[k * 2 * J + j] % q
                t = a[k * 2 * J + j + J] % q
                a[k * 2 * J + j] = (op21(u + t, q)) % q
                a[k * 2 * J + j + J] = (op21(t - u, q) * w) % q
    return a


def pwm(x, y, q):
    return [(x[i] * y[i]) % q for i in range(len(x))]


def bitrev(x, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (x & 1)
        x >>= 1
    return r


def build_wrom(Ns, psi, q):
    """Negacyclic twiddle table in the source's bit-reversed layout:
       w_rom[i] = psi^bitrev(i, log2 Ns).  (== the source table at N=1024,
       proven entry-for-entry in check H.)"""
    logn = Ns.bit_length() - 1
    return [pow(psi, bitrev(i, logn), q) for i in range(Ns)]


def negacyclic_conv(a, b, q):
    """Independent golden: product in Z_q[x]/(x^N + 1)."""
    N = len(a)
    c = [0] * N
    for i in range(N):
        for j in range(N):
            k = i + j
            v = a[i] * b[j]
            if k >= N:
                k -= N
                v = -v
            c[k] = (c[k] + v) % q
    return c


def small_root(Ns, q):
    """psi = 7^(2048/(2*Ns)) is a primitive 2N-th root mod q (order(7)=2048)."""
    psi = pow(KESAI, 2048 // (2 * Ns), q)
    if pow(psi, Ns, q) != q - 1 or pow(psi, 2 * Ns, q) != 1:
        return None
    return psi


# ---- (J) invertibility on the FULL basis (proves INTT o NTT = id) ----------
def check_invertibility(Ns):
    q = Q
    psi = small_root(Ns, q)
    if psi is None:
        return False, "invertibility N=%d: 7 is not a primitive 2N-th root" % Ns
    w = build_wrom(Ns, psi, q)
    for idx in range(Ns):
        e = [0] * Ns
        e[idx] = 1
        spec = DIT_NR_NTT(e[:], w, q)
        back = DIF_RN_INTT(spec[:], w, q)
        if back != e:
            return False, ("invertibility N=%d: INTT(NTT(e_%d)) = %s != e_%d"
                           % (Ns, idx, back, idx))
    return True, ""


# ---- (K) convolution theorem on all basis pairs (proves diagonalisation) ---
def check_convolution(Ns):
    q = Q
    psi = small_root(Ns, q)
    if psi is None:
        return False, "convolution N=%d: 7 is not a primitive 2N-th root" % Ns
    w = build_wrom(Ns, psi, q)
    for i in range(Ns):
        ei = [0] * Ns
        ei[i] = 1
        fi = DIT_NR_NTT(ei[:], w, q)
        for j in range(Ns):
            ej = [0] * Ns
            ej[j] = 1
            fj = DIT_NR_NTT(ej[:], w, q)
            got = DIF_RN_INTT(pwm(fi, fj, q), w, q)
            gold = negacyclic_conv(ei, ej, q)
            if got != gold:
                return False, ("convolution N=%d: INTT(NTT(e_%d).NTT(e_%d)) = %s"
                               " != negacyclic %s" % (Ns, i, j, got, gold))
    return True, ""


# ---- production-size grounding: round-trip on the REAL source table --------
def check_production_roundtrip():
    q = Q
    N = 1024
    w = SRC_W_ROM                                   # checked in (H): == derived
    rng = random.Random(0)
    vecs = [
        [0] * N,                                     # zero
        [1] + [0] * (N - 1),                         # e_0
        [0] * (N - 1) + [1],                         # e_{N-1}
        [1] * N,                                     # all ones
        [i % q for i in range(N)],                   # ramp
    ]
    for _ in range(8):
        vecs.append([rng.randrange(q) for _ in range(N)])
    for vi, v in enumerate(vecs):
        back = DIF_RN_INTT(DIT_NR_NTT(v[:], w, q), w, q)
        ref = [c % q for c in v]
        if back != ref:
            return False, ("production roundtrip: INTT(NTT(v_%d)) != v_%d" % (vi, vi))
    return True, ""


# ---- DEEP_VERIFY=1: full-basis N=1024 round-trip (expensive, off by default)
def check_production_full_basis():
    q = Q
    N = 1024
    w = SRC_W_ROM
    for idx in range(N):
        e = [0] * N
        e[idx] = 1
        back = DIF_RN_INTT(DIT_NR_NTT(e[:], w, q), w, q)
        if back != e:
            return False, "full basis N=1024: INTT(NTT(e_%d)) != e_%d" % (idx, idx)
    return True, ""


# ===========================================================================
def main():
    checks = [
        ("modular_add.v == (x+y) mod q   [full 14-bit domain, z3]", check_modular_add),
        ("modular_substraction.v == (x-y) mod q [full domain, z3]", check_modular_sub),
        ("modular_half.v == x/2 mod q    [full 14-bit domain, z3]", check_modular_half),
        ("modular_mul.v == a*b mod q     [EXACT RTL datapath, z3]", check_modular_mul_rtl),
        ("modular_mul.v datapath, concrete ints  [edges + sample]", check_modular_mul_concrete),
        ("conflict-free map: (bank,offset) bijective         [z3]", check_cfmap_bijection),
        ("conflict-free map: distinct banks every stride     [z3]", check_cfmap_conflict_free),
        ("address_generator.v: exact case model, all stages  [z3]", check_address_generator),
        ("tf_address_generator.v == model r-counter - 1      [z3]", check_tf_addressing),
        ("twiddle ROMs: derived == w_rom == tf_ROM.v   [all 2047]", check_twiddle_roms),
        ("compact_bf.v routing: NTT/INTT mux + operand order [z3]", check_compact_bf_routing),
        ("INTT o NTT = identity          [full basis, N=8]", lambda: check_invertibility(8)),
        ("INTT o NTT = identity          [full basis, N=16]", lambda: check_invertibility(16)),
        ("INTT o NTT = identity          [full basis, N=64]", lambda: check_invertibility(64)),
        ("diagonalises negacyclic conv   [basis pairs, N=8]", lambda: check_convolution(8)),
        ("diagonalises negacyclic conv   [basis pairs, N=16]", lambda: check_convolution(16)),
        ("production round-trip on REAL source table [N=1024]", check_production_roundtrip),
    ]
    if os.environ.get("DEEP_VERIFY") == "1":
        checks.append(("full-basis round-trip [N=1024, DEEP_VERIFY]",
                       check_production_full_basis))
    for label, fn in checks:
        try:
            ok, msg = fn()
        except Exception as exc:
            print("FAIL: %s raised %r" % (label, exc))
            sys.exit(1)
        if not ok:
            print("FAIL: %s" % msg)
            sys.exit(1)
        sys.stderr.write("ok  %s\n" % label)
    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
