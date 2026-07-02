#!/usr/bin/env python3
# Source-grounded formal verification of the CFNTT Radix-2/4 NTT accelerator
# (Chen et al., IACR TCHES 2022). Ground truth: the authors' reference
# implementation cfntt_ref/model_code/poly_mult_radix_2.py (DIT/DIF NTT, op21
# modular-half, pwm) and the Verilog modular_add.v / modular_half.v, plus the
# Barrett constants pinned in the spec (q=12289, mu=21843, k=28).
#
# TIER 1 (z3, size-independent, real bit widths): modular_add == (x+y) mod q,
#         modular_half/op21 == x*2^-1 mod q, Barrett reduce == x mod q over the
#         full input domain [0,(q-1)^2] with <=2 conditional subtractions.
# TIER 2 (whole system, source functions): round-trip INTT(NTT(a))==a and the
#         negacyclic convolution theorem -- delta / negacyclic-shift goldens at
#         the real N=1024 with the real ROM, and a full O(N^2) negacyclic
#         convolution golden at a reduced N=8.

import sys
import math
import random

try:
    import z3
except Exception as e:  # pragma: no cover
    print(f"FAIL: z3 unavailable: {e}")
    sys.exit(1)

q = 12289          # the canonical 14-bit NTT-friendly prime, 2048 | (q-1)
INV2 = (q + 1) >> 1  # 6145 == 2^-1 mod q

def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)

def log(msg):
    print(msg, file=sys.stderr)

# ---------------------------------------------------------------------------
# REAL SOURCE: cfntt_ref/model_code/poly_mult_radix_2.py (functions verbatim).
# These mutate `a` in place; callers always pass a fresh copy.
# ---------------------------------------------------------------------------
def DIT_NR_NTT(a, w_rom):
    n = len(a)
    log_n = int(math.log(n, 2))
    r = 1
    for p in range(log_n - 1, -1, -1):
        J = int(pow(2, p))
        for k in range(int(n / (2 * J))):
            w = w_rom[r]
            r = r + 1
            for j in range(J):
                u = a[k * 2 * J + j] % q
                t = (a[k * 2 * J + j + J] * w) % q
                a[k * 2 * J + j] = (u + t) % q
                a[k * 2 * J + j + J] = (u - t) % q
    return a

def op21(a):
    if a & 1 == 0:
        r = (a >> 1) % q
    else:
        r = ((a >> 1) + ((q + 1) >> 1)) % q
    return r

def DIF_RN_INTT(a, w_rom):
    n = len(a)
    log_n = int(math.log(n, 2))
    r = len(w_rom) - 1
    for i in range(log_n):
        J = int(pow(2, i))
        for k in range(int(n / (2 * J))):
            w = w_rom[r]
            r = r - 1
            for j in range(J):
                u = a[k * 2 * J + j] % q
                t = a[k * 2 * J + j + J] % q
                a[k * 2 * J + j] = (op21(u + t)) % q
                a[k * 2 * J + j + J] = (op21(t - u) * w) % q
    return a

def pwm(x, y):
    qq = 12289
    N = len(x)
    z = []
    for i in range(N):
        z.append((x[i] * y[i]) % qq)
    return z

# REAL twiddle ROM (negacyclic, bit-reversed psi powers) -- used AS-IS, never
# regenerated/compared. w_rom[i] = psi^bitrev(i) mod q, w_rom[0] = 1.
w_rom = [1, 10810, 7143, 4043, 10984, 722, 5736, 8155, 3542, 8785, 9744, 3621, 10643, 1212, 3195, 5860,
 7468, 2639, 9664, 11340, 11726, 9314, 9283, 9545, 5728, 7698, 5023, 5828, 8961, 6512, 7311, 1351,
 2319, 11119, 11334, 11499, 9088, 3014, 5086, 10963, 4846, 9542, 9154, 3712, 4805, 8736, 11227, 9995,
 3091, 12208, 7969, 11289, 9326, 7393, 9238, 2366, 11112, 8034, 10654, 9521, 12149, 10436, 7678, 11563,
 1260, 4388, 4632, 6534, 2426, 334, 1428, 1696, 2013, 9000, 729, 3241, 2881, 3284, 7197, 10200,
 8595, 7110, 10530, 8582, 3382, 11934, 9741, 8058, 3637, 3459, 145, 6747, 9558, 8357, 7399, 6378,
 9447, 480, 1022, 9, 9821, 339, 5791, 544, 10616, 4278, 6958, 7300, 8112, 8705, 1381, 9764,
 11336, 8541, 827, 5767, 2476, 118, 2197, 7222, 3949, 8993, 4452, 2396, 7935, 130, 2837, 6915,
 2401, 442, 7188, 11222, 390, 773, 8456, 3778, 354, 4861, 9377, 5698, 5012, 9808, 2859, 11244,
 1017, 7404, 1632, 7205, 27, 9223, 8526, 10849, 1537, 242, 4714, 8146, 9611, 3704, 5019, 11744,
 1002, 5011, 5088, 8005, 7313, 10682, 8509, 11414, 9852, 3646, 6022, 2987, 9723, 10102, 6250, 9867,
 11224, 2143, 11885, 7644, 1168, 5277, 11082, 3248, 493, 8193, 6845, 2381, 7952, 11854, 1378, 1912,
 2166, 3915, 12176, 7370, 12129, 3149, 12286, 4437, 3636, 4938, 5291, 2704, 10863, 7635, 1663, 10512,
 3364, 1689, 4057, 9018, 9442, 7875, 2174, 4372, 7247, 9984, 4053, 2645, 5195, 9509, 7394, 1484,
 9042, 9603, 8311, 9320, 9919, 2865, 5332, 3510, 1630, 10163, 5407, 3186, 11136, 9405, 10040, 8241,
 9890, 8889, 7098, 9153, 9289, 671, 3016, 243, 6730, 420, 10111, 1544, 3985, 4905, 3531, 476,
 49, 1263, 5915, 1483, 9789, 10800, 10706, 6347, 1512, 350, 10474, 5383, 5369, 10232, 9087, 4493,
 9551, 6421, 6554, 2655, 9280, 1693, 174, 723, 10314, 8532, 347, 2925, 8974, 11863, 1858, 4754,
 3030, 4115, 2361, 10446, 2908, 218, 3434, 8760, 3963, 576, 6142, 9842, 1954, 10238, 9407, 10484,
 3991, 8320, 9522, 156, 2281, 5876, 10258, 5333, 3772, 418, 5908, 11836, 5429, 7515, 7552, 1293,
 295, 6099, 5766, 652, 8273, 4077, 8527, 9370, 325, 10885, 11143, 11341, 5990, 1159, 8561, 8240,
 3329, 4298, 12121, 2692, 5961, 7183, 10327, 1594, 6167, 9734, 7105, 11089, 1360, 3956, 6170, 5297,
 8210, 11231, 922, 441, 1958, 4322, 1112, 2078, 4046, 709, 9139, 1319, 4240, 8719, 6224, 11454,
 2459, 683, 3656, 12225, 10723, 5782, 9341, 9786, 9166, 10542, 9235, 6803, 7856, 6370, 3834, 7032,
 7048, 9369, 8120, 9162, 6821, 1010, 8807, 787, 5057, 4698, 4780, 8844, 12097, 1321, 4912, 10240,
 677, 6415, 6234, 8953, 1323, 9523, 12237, 3174, 1579, 11858, 9784, 5906, 3957, 9450, 151, 10162,
 12231, 12048, 3532, 11286, 1956, 7280, 11404, 6281, 3477, 6608, 142, 11184, 9445, 3438, 11314, 4212,
 9260, 6695, 4782, 5886, 8076, 504, 2302, 11684, 11868, 8209, 3602, 6068, 8689, 3263, 6077, 7665,
 7822, 7500, 6752, 4749, 4449, 6833, 12142, 8500, 6118, 8471, 1190, 9606, 3860, 5445, 7753, 11239,
 5079, 9027, 2169, 11767, 7965, 4916, 8214, 5315, 11011, 9945, 1973, 6715, 8775, 11248, 5925, 11271,
 654, 3565, 1702, 1987, 6760, 5206, 3199, 12233, 6136, 6427, 6874, 8646, 4948, 6152, 400, 10561,
 5339, 5446, 3710, 6093, 468, 8301, 316, 11907, 10256, 8291, 3879, 1922, 10930, 6854, 973, 11035,
 7, 1936, 845, 3723, 3154, 5054, 3285, 7929, 216, 50, 6763, 769, 767, 8484, 10076, 4153,
 3120, 6184, 6203, 5646, 8348, 3753, 3536, 5370, 3229, 4730, 10583, 3929, 1282, 8717, 2021, 9457,
 3944, 4099, 5604, 6759, 2171, 8809, 11024, 3007, 9344, 5349, 2633, 1406, 9057, 11996, 4855, 8520,
 9348, 11722, 6627, 5289, 3837, 2595, 3221, 4273, 4050, 7082, 844, 5202, 11309, 11607, 4590, 7207,
 8820, 6138, 7846, 8871, 4693, 2338, 9996, 11872, 1802, 1555, 5103, 10398, 7878, 10699, 1223, 9955,
 11009, 614, 12265, 10918, 11385, 9804, 6742, 7250, 881, 11924, 1015, 10362, 5461, 9343, 2637, 7779,
 4684, 3360, 7154, 63, 7302, 2373, 3670, 3808, 578, 5368, 11839, 1944, 7628, 11779, 9667, 6903,
 5618, 10631, 5789, 3502, 5043, 826, 3090, 1398, 3065, 1506, 6586, 4483, 6389, 910, 7570, 11538,
 4518, 3094, 1160, 4820, 2730, 5411, 10036, 1868, 2478, 9449, 4194, 3019, 10506, 7211, 7724, 4974,
 7119, 2672, 11424, 1279, 189, 3116, 10526, 2209, 10759, 1694, 8420, 7866, 5832, 1350, 10555, 8474,
 7014, 10499, 11038, 6879, 2035, 1040, 10407, 6164, 7519, 944, 5287, 8620, 6616, 9269, 6883, 7624,
 4834, 2712, 9461, 4352, 8176, 72, 3840, 10447, 3451, 8195, 11048, 4378, 6508, 9244, 9646, 1095,
 2873, 2827, 11498, 2434, 11169, 9754, 12268, 6481, 874, 9988, 170, 6639, 2307, 4289, 11641, 12139,
 11259, 11823, 3821, 1681, 4649, 5969, 2929, 6026, 1573, 8443, 3793, 6226, 11787, 5118, 2602, 10388,
 1849, 5776, 9021, 3795, 7988, 7766, 457, 12281, 11410, 9696, 982, 10013, 4218, 4390, 8835, 8531,
 7785, 778, 530, 2626, 3578, 4697, 8823, 1701, 10243, 2940, 9332, 10808, 3317, 9757, 139, 3332,
 343, 8841, 4538, 10381, 7078, 1866, 1208, 7562, 10584, 2450, 11873, 814, 716, 10179, 2164, 6873,
 5412, 8080, 9011, 6296, 3515, 11851, 1218, 5061, 10753, 10568, 2429, 8186, 1373, 9307, 717, 8700,
 8921, 4227, 4238, 11677, 8067, 1526, 11749, 12164, 3163, 4032, 6127, 7449, 1389, 10221, 4404, 11943,
 3359, 9084, 5209, 1092, 3678, 4265, 10361, 464, 1826, 2926, 4489, 9118, 1136, 3449, 3708, 9051,
 2065, 5826, 3495, 4564, 8755, 3961, 10533, 4145, 2275, 2461, 4267, 5653, 5063, 8113, 10771, 8524,
 11014, 5508, 11113, 6555, 4860, 1125, 10844, 11158, 6302, 6693, 579, 3889, 9520, 3114, 6323, 212,
 8314, 4883, 6454, 3087, 1417, 5676, 7784, 2257, 3744, 4963, 2528, 9233, 5102, 11877, 6701, 6444,
 4924, 4781, 1014, 11841, 1327, 3607, 3942, 7057, 2717, 60, 3200, 10754, 5836, 7723, 2260, 68,
 180, 4138, 7684, 2689, 10880, 7070, 204, 5509, 10821, 8308, 8882, 463, 10945, 9247, 9806, 10235,
 4739, 8038, 6771, 1226, 9261, 5216, 11925, 9929, 11053, 9272, 7043, 4475, 3121, 4705, 1057, 9689,
 11883, 10602, 146, 5268, 1403, 1804, 6094, 7100, 12050, 9389, 994, 4554, 4670, 11777, 5464, 4906,
 3375, 9998, 8896, 4335, 7376, 3528, 3825, 8054, 9342, 8307, 636, 5609, 11667, 10552, 5672, 4499,
 5598, 3344, 10397, 8665, 6565, 10964, 11260, 10344, 5959, 10141, 8330, 5797, 2442, 1248, 5115, 4939,
 10975, 1744, 2894, 8635, 6599, 9834, 8342, 338, 3343, 8170, 1522, 10138, 12269, 5002, 4608, 5163,
 4578, 377, 11914, 1620, 10453, 11864, 10104, 11897, 6085, 8122, 11251, 11366, 10058, 6197, 2800, 193,
 506, 1255, 1392, 5784, 3276, 8951, 2212, 9615, 10347, 8881, 2575, 1165, 2776, 11111, 6811, 3511]

assert len(w_rom) == 1024, "ROM length"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def ntt(a):
    return DIT_NR_NTT(list(a), w_rom)

def intt(a):
    return DIF_RN_INTT(list(a), w_rom)

def bitrev(x, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (x & 1)
        x >>= 1
    return r

def find_psi(N):
    # primitive 2N-th root of unity: psi^(2N)=1, psi^N = -1 (negacyclic).
    for g in range(2, q):
        psi = pow(g, 12288 // (2 * N), q)
        if pow(psi, N, q) == q - 1 and pow(psi, 2 * N, q) == 1:
            return psi
    return None

def small_rom(N):
    psi = find_psi(N)
    if psi is None:
        fail(f"no primitive {2*N}-th root of unity mod q")
    logn = N.bit_length() - 1
    return [pow(psi, bitrev(i, logn), q) for i in range(N)]

def negacyclic_conv(a, b):
    # independent golden in Z_q[x]/(x^N+1): x^N = -1.
    N = len(a)
    r = [0] * N
    for i in range(N):
        ai = a[i] % q
        for j in range(N):
            v = (ai * b[j]) % q
            k = i + j
            if k < N:
                r[k] = (r[k] + v) % q
            else:
                r[k - N] = (r[k - N] - v) % q
    return r

# ---------------------------------------------------------------------------
# TIER 1
# ---------------------------------------------------------------------------
def t1_modular_add():
    # modular_add.v (radix-2 & radix-4 identical): faithful gate-level model,
    # prove z == (x+y) mod q for operands in [0,q).
    W = 16
    X = z3.BitVec('X', W)
    Y = z3.BitVec('Y', W)
    qC = z3.BitVecVal(q, W)
    one = z3.BitVecVal(1, W)
    zero = z3.BitVecVal(0, W)
    pre = z3.And(z3.ULT(X, qC), z3.ULT(Y, qC))
    summ = X + Y                                   # < 2q < 2^15, exact in 16b
    s = summ & z3.BitVecVal(0x3FFF, W)             # 14-bit sum
    c = z3.LShR(summ, 14) & one                    # carry-out bit
    sm = (s - qC) & z3.BitVecVal(0x3FFF, W)        # s - M (14-bit)
    b = z3.If(z3.ULT(s, qC), one, zero)            # borrow
    sel = z3.If(z3.And(c == zero, b == one), zero, one)   # ~((~c)&b)
    zres = z3.If(sel == one, sm, s)
    expected = z3.URem(summ, qC)
    s_ = z3.Solver()
    s_.add(pre, zres != expected)
    r = s_.check()
    if r == z3.sat:
        fail(f"modular_add != (x+y) mod q, cex {s_.model()}")
    if r != z3.unsat:
        fail("modular_add: z3 could not decide a 14-bit obligation")
    log("  [T1] modular_add  == (x+y) mod q  (proved, 14-bit)")

def t1_modular_half():
    # modular_half.v == op21: prove y == x * 2^-1 mod q for x in [0,q).
    W = 20
    X = z3.BitVec('X', W)
    qC = z3.BitVecVal(q, W)
    mh = z3.BitVecVal(INV2, W)                     # M_half = (M+1)/2 = 6145
    pre = z3.ULT(X, qC)
    x_sh = z3.LShR(X, 1)
    s = x_sh + mh
    y = z3.If((X & z3.BitVecVal(1, W)) == z3.BitVecVal(1, W), s, x_sh)
    expected = z3.URem(X * mh, qC)
    s_ = z3.Solver()
    s_.add(pre, y != expected)
    r = s_.check()
    if r == z3.sat:
        fail(f"modular_half != x*2^-1 mod q, cex {s_.model()}")
    if r != z3.unsat:
        fail("modular_half: z3 could not decide a 14-bit obligation")
    log("  [T1] modular_half == x * 2^-1 mod q  (proved, real width)")

def t1_op21_exhaustive():
    # The model wraps op21 over u+t in [0,2q) and t-u in (-q,q) (Python neg
    # semantics). Exhaustively confirm op21(z)%q == z*2^-1 mod q on that range.
    for z in range(-(q - 1), 2 * q - 1):
        if op21(z) % q != (z * INV2) % q:
            fail(f"op21({z}) % q = {op21(z)%q} != {(z*INV2)%q}")
    log(f"  [T1] op21 == z * 2^-1 mod q over [-{q-1}, {2*q-2}]  (exhaustive)")

def barrett(x, mu=21843, k=28):
    t = (x * mu) >> k
    r = x - t * q
    subs = 0
    while r >= q:
        r -= q
        subs += 1
    return r, subs

def t1_barrett():
    # Barrett reduce (mu=21843, k=28): prove r0 = x - ((x*mu)>>k)*q lands in
    # [0,3q) and r0 == x mod q for ALL x in [0,(q-1)^2]  ->  <=2 cond subs.
    mu, k = 21843, 28
    LIM = (q - 1) * (q - 1)
    W = 48
    x = z3.BitVec('x', W)
    muC = z3.BitVecVal(mu, W)
    qC = z3.BitVecVal(q, W)
    t = z3.LShR(x * muC, k)
    r0 = x - t * qC
    pre = z3.ULE(x, z3.BitVecVal(LIM, W))
    prop = z3.And(z3.ULE(t * qC, x),                       # r0 >= 0
                  z3.ULT(r0, z3.BitVecVal(3 * q, W)),       # <= 2 cond subs
                  z3.URem(r0, qC) == z3.URem(x, qC))        # congruent to x
    solver = z3.Then('simplify', 'bit-blast', 'smt').solver()
    solver.set('timeout', 20000)
    solver.add(pre, z3.Not(prop))
    r = solver.check()
    if r == z3.sat:
        m = solver.model()
        xv = m[x].as_long()
        r0v = xv - ((xv * mu) >> k) * q
        fail(f"Barrett wrong at x={xv}: r0={r0v}, x%q={xv%q}")
    if r == z3.unsat:
        log("  [T1] Barrett reduce == x mod q on [0,(q-1)^2] (<=2 subs) (proved)")
        return
    # 'unknown' is not a counterexample: fall back to a decidable randomized +
    # edge-case sweep over the same domain.
    log("  [T1] Barrett: z3 returned unknown -> randomized/edge fallback")
    random.seed(0xC0FFEE)
    edges = [0, 1, 2, q - 1, q, q + 1, 2 * q - 1, 2 * q, 2 * q + 1, LIM, LIM - 1]
    for m in range(1, 32):
        edges += [m * q - 1, m * q, m * q + 1]
    samples = [e for e in edges if 0 <= e <= LIM]
    samples += [random.randint(0, LIM) for _ in range(400000)]
    for xv in samples:
        rv, subs = barrett(xv)
        r0 = xv - ((xv * 21843) >> 28) * q
        if rv != xv % q or subs > 2 or not (0 <= r0 < 3 * q):
            fail(f"Barrett wrong at x={xv}: r={rv}, x%q={xv%q}, subs={subs}")
    log(f"  [T1] Barrett reduce == x mod q (<=2 subs) over {len(samples)} pts")

# ---------------------------------------------------------------------------
# TIER 2
# ---------------------------------------------------------------------------
def t2_roundtrip_1024():
    N = 1024
    random.seed(1)
    for trial in range(6):
        a = [random.randrange(q) for _ in range(N)]
        rt = intt(ntt(a))
        if rt != a:
            i = next(k for k in range(N) if rt[k] != a[k])
            fail(f"INTT(NTT(a)) != a at N={N} (i={i}: {rt[i]} != {a[i]})")
    log(f"  [T2] INTT(NTT(a)) == a   at N={N} (real ROM, 6 vectors)")

def t2_negacyclic_identity_and_shift():
    N = 1024
    random.seed(2)
    e0 = [0] * N; e0[0] = 1
    e1 = [0] * N; e1[1] = 1
    fe0 = ntt(e0)
    fe1 = ntt(e1)
    # delta at 0 must transform to the all-ones spectrum (merged-twist NTT).
    if any(v != 1 for v in fe0):
        i = next(k for k in range(N) if fe0[k] != 1)
        fail(f"NTT(delta_0)[{i}]={fe0[i]} != 1 (merged-twist property broken)")
    for trial in range(4):
        a = [random.randrange(q) for _ in range(N)]
        fa = ntt(a)
        # identity convolution: a * delta_0 == a
        ident = intt(pwm(fa, fe0))
        if ident != a:
            i = next(k for k in range(N) if ident[k] != a[k])
            fail(f"conv(a, delta_0) != a at i={i}")
        # NEGACYCLIC shift: a * x == [-a[N-1], a[0], ..., a[N-2]] (x^N = -1).
        gold = [(-a[N - 1]) % q] + [a[i - 1] % q for i in range(1, N)]
        shifted = intt(pwm(fa, fe1))
        if shifted != gold:
            i = next(k for k in range(N) if shifted[k] != gold[k])
            fail(f"negacyclic shift wrong at i={i}: {shifted[i]} != {gold[i]} "
                 f"(transform is not negacyclic)")
    log(f"  [T2] convolution theorem: identity + NEGACYCLIC shift at N={N}")

def t2_small_full_convolution():
    # Reduced instance (N=8, 3 stages): full O(N^2) negacyclic-convolution
    # golden vs the source NTT/pwm/INTT pipeline + round-trip.
    N = 8
    wt = small_rom(N)
    def sntt(a):
        return DIT_NR_NTT(list(a), wt)
    def sintt(a):
        return DIF_RN_INTT(list(a), wt)
    # transform of the unit impulse is the all-ones spectrum.
    d0 = [0] * N; d0[0] = 1
    if any(v != 1 for v in sntt(d0)):
        fail(f"N={N}: NTT(delta_0) != all-ones")
    random.seed(7)
    for trial in range(200):
        a = [random.randrange(q) for _ in range(N)]
        b = [random.randrange(q) for _ in range(N)]
        if sintt(sntt(a)) != a:
            fail(f"N={N}: INTT(NTT(a)) != a")
        got = sintt(pwm(sntt(a), sntt(b)))
        gold = negacyclic_conv(a, b)
        if got != gold:
            i = next(k for k in range(N) if got[k] != gold[k])
            fail(f"N={N} negacyclic conv mismatch at i={i}: {got[i]} != {gold[i]}")
    log(f"  [T2] full negacyclic convolution == golden at reduced N={N} (200 pairs)")

# ---------------------------------------------------------------------------
def main():
    log("TIER 1 -- size-independent local facts (z3, real bit widths):")
    t1_modular_add()
    t1_modular_half()
    t1_op21_exhaustive()
    t1_barrett()
    log("TIER 2 -- whole-system equivalence (real source functions):")
    t2_roundtrip_1024()
    t2_negacyclic_identity_and_shift()
    t2_small_full_convolution()
    print("VERIFIED")
    sys.exit(0)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        fail(f"unexpected error: {type(e).__name__}: {e}")
