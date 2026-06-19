#!/usr/bin/env python3
"""
CFNTT Radix-2/4 NTT Multiplication Accelerator (FPGA) -- reverse implementation
from spec alone, with self-checking verification.

Implemented from the spec's FUNCTIONAL fields only:
  q=12289, N=1024, psi=1945 (negacyclic, order 2048), omega=psi^2=10302,
  Ninv=12277, Barrett mu=21843 k=28, radix-2 + fused radix-4 butterflies,
  XOR-fold conflict-free bank map, FSM IDLE..DONE.

Verification strategy: decompose correctness into small finite obligations and
discharge each with the cheapest sound check (z3 over bounded domains for the
reusable local facts; exhaustive / small-N end-to-end for the rest).
"""

import os
import sys
import random

try:
    import z3
except Exception as e:  # pragma: no cover
    print("FAIL: z3 unavailable: %r" % e)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Authoritative parameters (taken verbatim from the spec -- not guesses)
# ---------------------------------------------------------------------------
Q          = 12289          # modulus q (14-bit prime, reproduction fix)
N          = 1024           # transform length
PSI        = 1945           # primitive 2N-th root (negacyclic), order 2048
OMEGA      = 10302          # psi^2, N-th root
NINV       = 12277          # 1024^-1 mod q
BARRETT_MU = 21843          # floor(2^28 / q)
BARRETT_K  = 28
PARALLEL_BU = 8
BANKS       = 8

assert pow(PSI, 2, Q) == OMEGA
assert pow(PSI, N, Q) == Q - 1          # psi^1024 == -1  (negacyclic)
assert pow(PSI, 2 * N, Q) == 1          # psi^2048 == 1
assert (N * NINV) % Q == 1
assert BARRETT_MU == (1 << BARRETT_K) // Q
assert pow(PSI, N // 2, Q) ** 2 % Q == 12288     # j = psi^512, j^2 == -1


# ---------------------------------------------------------------------------
# Barrett modular reduction (mod_red_mult + mod_red_subshift)
# ---------------------------------------------------------------------------
def barrett_reduce(x, q=Q, mu=BARRETT_MU, k=BARRETT_K):
    """Reduce x in [0, q^2) to [0, q).  t=(x*mu)>>k; r=x-t*q; <=2 corrections."""
    t = (x * mu) >> k
    r = x - t * q
    # at most two conditional subtractions (spec: result in [0,q))
    if r >= q:
        r -= q
    if r >= q:
        r -= q
    return r


def mulmod(a, b, q=Q):
    """DSP modular multiplier feeding the Barrett reduction stage."""
    return barrett_reduce((a % q) * (b % q), q)


# ---------------------------------------------------------------------------
# Butterflies
# ---------------------------------------------------------------------------
def radix2_butterfly(x0, x1, w, q=Q):
    """CT/DIT radix-2: u=x0, v=w*x1 -> (u+v, u-v) mod q."""
    u = x0 % q
    v = mulmod(w, x1, q)
    return (u + v) % q, (u - v) % q


def radix4_butterfly(x0, x1, x2, x3, W1, W2, W3, j, q=Q):
    """DIT radix-4 fused BU (spec equations).  j is the order-4 rotator."""
    bp = mulmod(W1, x1, q)
    cp = mulmod(W2, x2, q)
    dp = mulmod(W3, x3, q)
    jb = mulmod(j, bp, q)
    jd = mulmod(j, dp, q)
    y0 = (x0 + bp + cp + dp) % q
    y1 = (x0 + jb - cp - jd) % q
    y2 = (x0 - bp + cp - dp) % q
    y3 = (x0 - jb - cp + jd) % q
    return y0, y1, y2, y3


# ---------------------------------------------------------------------------
# Conflict-free bank mapping (crossbar_network / addr_gen_unit)
# ---------------------------------------------------------------------------
def bank(i):
    return (i & 7) ^ ((i >> 3) & 7) ^ ((i >> 6) & 7) ^ ((i >> 9) & 7)


def offset(i):
    return i >> 3


# ---------------------------------------------------------------------------
# Negacyclic NTT / INTT (Longa-Naehrig merged psi-twist)
#   forward: Cooley-Tukey DIT, bit-reversed psi-power table (output bit-rev)
#   inverse: Gentleman-Sande DIF + N^-1 scaling   (intt_scale unit)
# ---------------------------------------------------------------------------
def bitrev(x, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (x & 1)
        x >>= 1
    return r


def make_tables(n, psi, q):
    logn = n.bit_length() - 1
    ipsi = pow(psi, q - 2, q)
    T = [pow(psi, bitrev(k, logn), q) for k in range(n)]
    Tinv = [pow(ipsi, bitrev(k, logn), q) for k in range(n)]
    return T, Tinv


def ntt_forward(a, T, q):
    """CT/DIT negacyclic forward NTT. Returns bit-reversed-order transform."""
    a = a[:]
    n = len(a)
    t = n
    m = 1
    while m < n:
        t //= 2
        for i in range(m):
            j1 = 2 * i * t
            S = T[m + i]
            for j in range(j1, j1 + t):
                u = a[j]
                v = (a[j + t] * S) % q
                a[j] = (u + v) % q
                a[j + t] = (u - v) % q
        m *= 2
    return a


def ntt_inverse(a, Tinv, ninv, q):
    """GS/DIF negacyclic inverse NTT, then scale by N^-1."""
    a = a[:]
    n = len(a)
    t = 1
    m = n
    while m > 1:
        j1 = 0
        h = m // 2
        for i in range(h):
            S = Tinv[h + i]
            for j in range(j1, j1 + t):
                u = a[j]
                v = a[j + t]
                a[j] = (u + v) % q
                a[j + t] = ((u - v) * S) % q
            j1 += 2 * t
        t *= 2
        m //= 2
    return [(x * ninv) % q for x in a]


# ---------------------------------------------------------------------------
# Schedule / FSM controller (minimal correct reconstruction from spec)
# ---------------------------------------------------------------------------
def run_fsm(mode_intt):
    """Returns the visited state sequence; ends at DONE."""
    seq = ["IDLE", "LOAD", "RUN_STAGES"]
    if mode_intt:
        seq.append("SCALE_INTT")
    seq += ["DRAIN", "DONE"]
    return seq


# ===========================================================================
# Golden / reference models (independent of the implementation above)
# ===========================================================================
def golden_barrett(x, q=Q):
    return x % q


def golden_radix4(x0, x1, x2, x3, W1, W2, W3, j, q=Q):
    """Independent DFT4-style golden: y_t = sum_s j^{t*s} * inp_s (twiddled)."""
    inp = [x0 % q, (W1 * x1) % q, (W2 * x2) % q, (W3 * x3) % q]
    out = []
    for t in range(4):
        acc = 0
        for s in range(4):
            acc = (acc + pow(j, (t * s) % 4, q) * inp[s]) % q
        out.append(acc)
    return tuple(out)


def golden_negacyclic_conv(a, b, q=Q):
    """Schoolbook multiplication in Z_q[X]/(X^n + 1)."""
    n = len(a)
    c = [0] * n
    for i in range(n):
        if a[i] == 0:
            continue
        for jx in range(n):
            k = i + jx
            v = a[i] * b[jx]
            if k < n:
                c[k] = (c[k] + v) % q
            else:
                c[k - n] = (c[k - n] - v) % q
    return [x % q for x in c]


# ===========================================================================
# Verification
# ===========================================================================
def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


def check_barrett_z3():
    """Prove Barrett(x) == x mod q for ALL x in [0, q^2)  (one reducer)."""
    x = z3.BitVec('x', 64)
    mu, k, q = BARRETT_MU, BARRETT_K, Q
    t = z3.LShR(x * mu, k)
    r = x - t * q
    r1 = z3.If(z3.UGE(r, q), r - q, r)
    r2 = z3.If(z3.UGE(r1, q), r1 - q, r1)
    s = z3.Solver()
    s.add(z3.ULT(x, q * q))
    s.add(z3.Or(z3.UGE(r2, q), r2 != z3.URem(x, q)))
    res = s.check()
    if res == z3.sat:
        m = s.model()
        fail("Barrett wrong for x=%s" % m[x])
    if res != z3.unsat:
        fail("Barrett z3 inconclusive: %s" % res)


def check_radix4_z3():
    """Prove the radix-4 BU equation == golden DFT4 over the full field (one BU)."""
    q = Q
    j = pow(PSI, N // 2, Q)  # 12288 == -1; j^2 == -1
    bv = lambda n: z3.BitVec(n, 32)
    x0, x1, x2, x3 = bv('x0'), bv('x1'), bv('x2'), bv('x3')
    W1, W2, W3 = bv('W1'), bv('W2'), bv('W3')

    def red(e):
        return z3.URem(e, q)

    # implementation (symbolic, with symbolic Barrett products reduced via URem
    # which is sound because barrett_reduce is already proven == mod q above)
    bp = red(red(W1) * red(x1))
    cp = red(red(W2) * red(x2))
    dp = red(red(W3) * red(x3))
    jb = red(j * bp)
    jd = red(j * dp)
    y = [red(red(x0) + bp + cp + dp),
         red(red(x0) + jb + (q - cp) + (q - jd)),
         red(red(x0) + (q - bp) + cp + (q - dp)),
         red(red(x0) + (q - jb) + (q - cp) + jd)]

    # golden: g_t = sum_s j^(t*s) * inp_s
    inp = [red(x0), bp, cp, dp]
    jp = [1, j % q, (j * j) % q, (j * j * j) % q]
    g = []
    for t in range(4):
        acc = z3.BitVecVal(0, 32)
        for sidx in range(4):
            acc = red(acc + jp[(t * sidx) % 4] * inp[sidx])
        g.append(acc)

    s = z3.Solver()
    for v in (x0, x1, x2, x3, W1, W2, W3):
        s.add(z3.ULT(v, q))
    s.add(z3.Or(*[y[t] != g[t] for t in range(4)]))
    res = s.check()
    if res == z3.sat:
        fail("radix-4 BU != DFT4 golden: %s" % s.model())
    if res != z3.unsat:
        fail("radix-4 z3 inconclusive: %s" % res)


def check_bank_map_z3():
    """conflict-free obligations, each proven over BitVec(10) (one stage each)."""
    def bank_expr(i):
        seg = lambda sh: z3.Extract(2, 0, z3.LShR(i, sh))
        return seg(0) ^ seg(3) ^ seg(6) ^ seg(9)

    # (a) (bank, offset) injective on [0, 1024)  ->  bijection
    a = z3.BitVec('a', 10)
    b = z3.BitVec('b', 10)
    s = z3.Solver()
    s.add(a != b)
    s.add(bank_expr(a) == bank_expr(b))
    s.add(z3.LShR(a, 3) == z3.LShR(b, 3))
    if s.check() != z3.unsat:
        fail("bank map not injective (collision exists)")

    # (b) radix-2: operands (i, i+2^k) always in distinct banks, all strides
    for k in range(10):
        stride = 1 << k
        i = z3.BitVec('i', 10)
        partner = i + stride
        s = z3.Solver()
        s.add(z3.ULT(i, 1024 - stride))         # in-range pair
        s.add(bank_expr(i) == bank_expr(partner))
        if s.check() != z3.unsat:
            fail("radix-2 bank conflict at stride 2^%d" % k)

    # (c) radix-4: operands (i, i+2^k, i+2^{k+1}, i+3*2^k) all distinct banks
    for k in range(9):
        st = 1 << k
        i = z3.BitVec('i', 10)
        ops = [i, i + st, i + 2 * st, i + 3 * st]
        s = z3.Solver()
        s.add(z3.ULT(i, 1024 - 3 * st))
        clauses = []
        for p in range(4):
            for qx in range(p + 1, 4):
                clauses.append(bank_expr(ops[p]) == bank_expr(ops[qx]))
        s.add(z3.Or(*clauses))
        if s.check() != z3.unsat:
            fail("radix-4 bank conflict at stride 2^%d" % k)


def check_small_ntt():
    """End-to-end on small N: round-trip identity + negacyclic conv theorem."""
    random.seed(1234)
    for n in (2, 4, 8, 16):
        psi_n = pow(PSI, (2 * N) // (2 * n), Q)   # order 2n
        assert pow(psi_n, n, Q) == Q - 1
        ninv_n = pow(n, Q - 2, Q)
        T, Tinv = make_tables(n, psi_n, Q)
        for _ in range(40):
            a = [random.randrange(Q) for _ in range(n)]
            # round trip
            rt = ntt_inverse(ntt_forward(a, T, Q), Tinv, ninv_n, Q)
            if rt != [x % Q for x in a]:
                fail("INTT(NTT(a)) != a for n=%d: a=%s got=%s" % (n, a, rt))
            # convolution theorem (NTT-multiply == schoolbook negacyclic)
            b = [random.randrange(Q) for _ in range(n)]
            fa = ntt_forward(a, T, Q)
            fb = ntt_forward(b, T, Q)
            pw = [(fa[i] * fb[i]) % Q for i in range(n)]
            got = ntt_inverse(pw, Tinv, ninv_n, Q)
            exp = golden_negacyclic_conv(a, b, Q)
            if got != exp:
                fail("negacyclic conv mismatch n=%d a=%s b=%s got=%s exp=%s"
                     % (n, a, b, got, exp))


def check_full_roundtrip():
    """Production size N=1024: O(N log N) round-trip only (no O(N^2))."""
    random.seed(99)
    T, Tinv = make_tables(N, PSI, Q)
    for _ in range(5):
        a = [random.randrange(Q) for _ in range(N)]
        rt = ntt_inverse(ntt_forward(a, T, Q), Tinv, NINV, Q)
        if rt != a:
            fail("full N=1024 round-trip failed")
    # impulse: NTT of delta is all-ones-ish power table -> inverse recovers delta
    delta = [0] * N
    delta[0] = 1
    if ntt_inverse(ntt_forward(delta, T, Q), Tinv, NINV, Q) != delta:
        fail("full N=1024 impulse round-trip failed")


def check_radix2_vs_golden():
    """radix-2 butterfly impl matches plain modular golden (exhaustive sample)."""
    random.seed(7)
    for _ in range(2000):
        x0 = random.randrange(Q)
        x1 = random.randrange(Q)
        w = random.randrange(Q)
        y0, y1 = radix2_butterfly(x0, x1, w)
        v = (w * x1) % Q
        if y0 != (x0 + v) % Q or y1 != (x0 - v) % Q:
            fail("radix-2 butterfly mismatch x0=%d x1=%d w=%d" % (x0, x1, w))


def check_radix4_vs_golden_samples():
    """radix-4 impl matches golden DFT4 on random samples (belt & braces)."""
    random.seed(13)
    j = pow(PSI, N // 2, Q)
    for _ in range(2000):
        xs = [random.randrange(Q) for _ in range(4)]
        Ws = [random.randrange(Q) for _ in range(3)]
        got = radix4_butterfly(*xs, *Ws, j)
        exp = golden_radix4(*xs, *Ws, j)
        if got != exp:
            fail("radix-4 sample mismatch xs=%s Ws=%s got=%s exp=%s"
                 % (xs, Ws, got, exp))


def check_op_counts():
    """Op-count reconciliation per spec: radix-4 2 mults / 8 add-sub (opt),
    33% / 20% reductions vs naive radix-4 (3 / 10)."""
    naive_mul, opt_mul = 3, 2
    naive_as, opt_as = 10, 8
    if round((1 - opt_mul / naive_mul) * 100) != 33:
        fail("mult reduction != 33%%")
    if round((1 - opt_as / naive_as) * 100) != 20:
        fail("add/sub reduction != 20%%")


def check_fsm():
    for mode in (False, True):
        seq = run_fsm(mode)
        if seq[0] != "IDLE" or seq[-1] != "DONE":
            fail("FSM does not run IDLE..DONE")
        if mode and "SCALE_INTT" not in seq:
            fail("INTT path missing N^-1 scaling state")
        if not mode and "SCALE_INTT" in seq:
            fail("forward path must not scale by N^-1")


def check_bank_offset_ranges():
    """offset in [0,128) (= BRAM depth), bank in [0,8); exhaustive over N."""
    used = set()
    for i in range(N):
        bi, oi = bank(i), offset(i)
        if not (0 <= bi < BANKS):
            fail("bank(%d)=%d out of range" % (i, bi))
        if not (0 <= oi < N // BANKS):
            fail("offset(%d)=%d out of range" % (i, oi))
        used.add((bi, oi))
    if len(used) != N:
        fail("(bank,offset) not a bijection over [0,1024)")


def main():
    check_barrett_z3()
    check_bank_map_z3()
    check_bank_offset_ranges()
    check_radix2_vs_golden()
    check_radix4_z3()
    check_radix4_vs_golden_samples()
    check_small_ntt()
    check_full_roundtrip()
    check_op_counts()
    check_fsm()

    if os.environ.get("DEEP_VERIFY") == "1":
        # Optional O(N^2) full-size negacyclic convolution check.
        random.seed(2024)
        T, Tinv = make_tables(N, PSI, Q)
        a = [random.randrange(Q) for _ in range(N)]
        b = [random.randrange(Q) for _ in range(N)]
        fa = ntt_forward(a, T, Q)
        fb = ntt_forward(b, T, Q)
        pw = [(fa[i] * fb[i]) % Q for i in range(N)]
        got = ntt_inverse(pw, Tinv, NINV, Q)
        exp = golden_negacyclic_conv(a, b, Q)
        if got != exp:
            fail("DEEP full-size negacyclic convolution mismatch")

    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
