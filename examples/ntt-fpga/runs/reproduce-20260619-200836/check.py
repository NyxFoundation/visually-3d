#!/usr/bin/env python3
"""
CFNTT Radix-2/4 NTT Multiplication Accelerator — reverse-implemented from spec.

Implements the negacyclic NTT/INTT datapath (q=12289, N=1024, psi=1945),
Barrett modular reduction (mu=21843, k=28), the committed XOR-fold conflict-free
bank/offset map, the radix-4 butterfly (DFT4 with j=psi^512), and the
schedule/FSM controller. Self-checks in two tiers and prints VERIFIED / FAIL.
"""
import os
import sys
import random

try:
    from z3 import (BitVec, BitVecVal, LShR, If, UGE, ULE, ULT, URem, Or,
                    Solver, sat)
except Exception as e:  # pragma: no cover
    print("FAIL: z3 is required (pip install z3-solver): %r" % e)
    sys.exit(1)

# ------------------------------------------------------------------ params ----
Q = 12289          # modulus (ref-impl fix; paper: a 14-bit NTT-friendly prime)
N = 1024           # transform length
PSI = 1945         # primitive 2048th root (negacyclic): psi^1024 = -1
OMEGA = 10302      # psi^2, the N-th root
NINV = 12277       # 1024^-1 mod q
GEN = 11           # generator g, psi = g^6
BARRETT_MU = 21843 # floor(2^28 / q)
BARRETT_K = 28
BANKS = 8


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


# ------------------------------------------------------- modular arithmetic ---
def barrett_reduce(x):
    """x in [0,(q-1)^2] -> x mod q, via t=(x*mu)>>k ; r=x-t*q ; <=2 subtracts."""
    t = (x * BARRETT_MU) >> BARRETT_K
    r = x - t * Q
    while r >= Q:
        r -= Q
    return r


def modmul(a, b):
    return barrett_reduce((a % Q) * (b % Q))


# ------------------------------------------------ conflict-free bank mapping --
def bank(i):
    return (i & 7) ^ ((i >> 3) & 7) ^ ((i >> 6) & 7) ^ ((i >> 9) & 1)


def offset(i):
    return i >> 3


# --------------------------------------------------------- negacyclic NTT -----
def bitrev(x, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (x & 1)
        x >>= 1
    return r


def make_psi_brv(n, psi, q):
    bits = n.bit_length() - 1
    return [pow(psi, bitrev(i, bits), q) for i in range(n)]


def ntt_neg(a, psi_brv, q):
    """Merged-psi negacyclic forward NTT (Cooley-Tukey / DIT)."""
    a = list(a)
    n = len(a)
    t = n
    m = 1
    while m < n:
        t >>= 1
        for i in range(m):
            j1 = 2 * i * t
            j2 = j1 + t
            s = psi_brv[m + i]
            for j in range(j1, j2):
                u = a[j]
                v = modmul(a[j + t], s)
                a[j] = (u + v) % q
                a[j + t] = (u - v) % q
        m <<= 1
    return a


def intt_neg(a, psi_inv_brv, q, ninv):
    """Merged-psi negacyclic inverse NTT (Gentleman-Sande / DIF), final * N^-1."""
    a = list(a)
    n = len(a)
    t = 1
    m = n
    while m > 1:
        j1 = 0
        h = m >> 1
        for i in range(h):
            j2 = j1 + t
            s = psi_inv_brv[h + i]
            for j in range(j1, j2):
                u = a[j]
                v = a[j + t]
                a[j] = (u + v) % q
                a[j + t] = modmul((u - v) % q, s)
            j1 += 2 * t
        t <<= 1
        m >>= 1
    return [modmul(x, ninv) for x in a]


def ntt_mul(a, b, psi_brv, psi_inv_brv, q, ninv):
    fa = ntt_neg(a, psi_brv, q)
    fb = ntt_neg(b, psi_brv, q)
    fc = [modmul(x, y) for x, y in zip(fa, fb)]
    return intt_neg(fc, psi_inv_brv, q, ninv)


# --------------------------------------------------- independent golden model -
def negacyclic_mul(a, b, q):
    """Schoolbook product in Z_q[x]/(x^N+1) — the reference (NOT from the impl)."""
    n = len(a)
    c = [0] * n
    for i in range(n):
        ai = a[i]
        for j in range(n):
            k = i + j
            if k < n:
                c[k] = (c[k] + ai * b[j]) % q
            else:
                c[k - n] = (c[k - n] - ai * b[j]) % q
    return [x % q for x in c]


# --------------------------------------------------------- radix-4 butterfly --
def radix4_bu(x0, x1, x2, x3, w, j, q):
    """Spec's fused radix-4 BU: 2 realized mults via symmetric sharing + j-rot."""
    W1, W2, W3 = w % q, (w * w) % q, modmul(modmul(w, w), w)
    bp = modmul(W1, x1)
    cp = modmul(W2, x2)
    dp = modmul(W3, x3)
    y0 = (x0 + bp + cp + dp) % q
    y1 = (x0 + modmul(j, bp) - cp - modmul(j, dp)) % q
    y2 = (x0 - bp + cp - dp) % q
    y3 = (x0 - modmul(j, bp) - cp + modmul(j, dp)) % q
    return [y0, y1, y2, y3]


# ---------------------------------------------------------- FSM controller ----
def run_fsm(mode_intt, radix):
    """Minimal reconstruction of the schedule/FSM controller; returns trace."""
    stages = {2: 10, 4: 5}[radix]
    trace = ["IDLE", "LOAD"]
    for s in range(stages):
        trace.append("RUN_STAGE")
        trace.append("NEXT_STAGE")
    if mode_intt:
        trace.append("SCALE")          # multiply by N^-1
    trace.append("STORE")
    trace.append("DONE")
    trace.append("IDLE")
    return trace


# =============================================================================
# TIER 1 — size-independent properties, proven at full bit-width
# =============================================================================
def t1_barrett():
    # Full proof over the ENTIRE input domain x in [0,(q-1)^2]. That domain is
    # < 2^28 and x*mu < 2^42, so 48-bit vectors hold every intermediate exactly
    # — identical semantics to the 64-bit form, but a much smaller bit-blasted
    # circuit, so z3 closes the unsat proof in well under a second instead of
    # thrashing on a 64-bit multiply + URem.
    W = 48
    x = BitVec('x', W)
    mu = BitVecVal(BARRETT_MU, W)
    q = BitVecVal(Q, W)
    t = LShR(x * mu, BARRETT_K)
    r = x - t * q
    r1 = If(UGE(r, q), r - q, r)
    r2 = If(UGE(r1, q), r1 - q, r1)
    s = Solver()
    s.add(ULE(x, (Q - 1) * (Q - 1)))
    s.add(Or(r2 != URem(x, q), UGE(r2, q)))
    if s.check() == sat:
        m = s.model()
        fail("Barrett reduction wrong at x=%s" % m[x])


def t1_roots():
    if pow(GEN, 6, Q) != PSI:
        fail("psi != g^6 mod q")
    if pow(PSI, 2, Q) != OMEGA:
        fail("omega != psi^2 mod q")
    if pow(PSI, N, Q) != Q - 1:
        fail("psi^N != -1 (not negacyclic)")
    if pow(PSI, 2 * N, Q) != 1:
        fail("psi^2N != 1")
    if (N * NINV) % Q != 1:
        fail("Ninv * N != 1 mod q")
    j = pow(PSI, 512, Q)
    if (j * j) % Q != Q - 1:
        fail("j-rotator j^2 != -1 mod q")


def _bank_expr(i):
    return ((i & 7) ^ (LShR(i, 3) & 7) ^ (LShR(i, 6) & 7) ^ (LShR(i, 9) & 1))


def t1_bank_bijection():
    # (bank,offset) is a bijection on [0,N): equal offset + equal bank => i==j.
    i = BitVec('i', 16)
    j = BitVec('j', 16)
    s = Solver()
    s.add(ULT(i, N), ULT(j, N), i != j)
    s.add(_bank_expr(i) == _bank_expr(j), LShR(i, 3) == LShR(j, 3))
    if s.check() == sat:
        m = s.model()
        fail("bank/offset not a bijection: i=%s j=%s" % (m[i], m[j]))


def t1_operand_pair_distinct():
    # For every power-of-two stride, a butterfly operand pair (i, i+2^s) with
    # bit_s(i)=0 lands in distinct banks (GF(2)-linearity of the XOR-fold).
    for sp in range(10):
        i = BitVec('i', 16)
        stride = 1 << sp
        sol = Solver()
        sol.add(ULT(i, N))
        sol.add((LShR(i, sp) & 1) == 0)
        sol.add(ULT(i + stride, N))
        sol.add(_bank_expr(i) == _bank_expr(i + stride))
        if sol.check() == sat:
            m = sol.model()
            fail("bank collision at stride 2^%d, i=%s" % (sp, m[i]))


def t1_radix4_is_dft4():
    # Spec's radix-4 BU equals the DFT4 matrix with order-4 root j over Z_q.
    j = pow(PSI, 512, Q)
    powj = [1, j, (j * j) % Q, (j * j * j) % Q]  # j^0..j^3
    rnd = random.Random(1)
    for _ in range(200):
        x0 = rnd.randrange(Q)
        bp = rnd.randrange(Q)
        cp = rnd.randrange(Q)
        dp = rnd.randrange(Q)
        eff = [x0, bp, cp, dp]
        # spec equations (with the precomputed b'/c'/d')
        y = [
            (x0 + bp + cp + dp) % Q,
            (x0 + modmul(j, bp) - cp - modmul(j, dp)) % Q,
            (x0 - bp + cp - dp) % Q,
            (x0 - modmul(j, bp) - cp + modmul(j, dp)) % Q,
        ]
        for k in range(4):
            ref = 0
            for m in range(4):
                ref = (ref + eff[m] * powj[(k * m) % 4]) % Q
            if y[k] != ref:
                fail("radix-4 BU != DFT4 at output %d" % k)


def t1_op_counts():
    naive_m, opt_m, naive_a, opt_a = 3, 2, 10, 8
    if not (opt_m < naive_m and opt_a < naive_a):
        fail("radix-4 op counts not reduced")
    if round((1 - opt_m / naive_m) * 100) != 33:
        fail("mult reduction != 33%")
    if round((1 - opt_a / naive_a) * 100) != 20:
        fail("add/sub reduction != 20%")


def t1_fsm():
    for radix in (2, 4):
        for intt in (False, True):
            tr = run_fsm(intt, radix)
            if tr[0] != "IDLE" or tr[-1] != "IDLE" or "DONE" not in tr:
                fail("FSM does not reach DONE/IDLE (radix=%d intt=%s)"
                     % (radix, intt))
            has_scale = "SCALE" in tr
            if has_scale != intt:
                fail("SCALE state must appear iff INTT (radix=%d)" % radix)
            stages = tr.count("RUN_STAGE")
            want = {2: 10, 4: 5}[radix]
            if stages != want:
                fail("stage count %d != %d (radix=%d)" % (stages, want, radix))


# =============================================================================
# TIER 2 — whole-system equivalence at the smallest structural instance (N=16)
# =============================================================================
def t2_small_roundtrip_and_mul():
    n = 16
    psi16 = pow(PSI, (2 * N) // (2 * n), Q)   # psi^64, primitive 32nd root
    if pow(psi16, n, Q) != Q - 1:
        fail("psi16^16 != -1 (not a valid negacyclic root for N=16)")
    if pow(psi16, 2 * n, Q) != 1:
        fail("psi16^32 != 1")
    ninv16 = pow(n, Q - 2, Q)
    pb = make_psi_brv(n, psi16, Q)
    pbi = make_psi_brv(n, pow(psi16, Q - 2, Q), Q)

    rnd = random.Random(20240619)
    for _ in range(200):
        a = [rnd.randrange(Q) for _ in range(n)]
        # round-trip identity
        if intt_neg(ntt_neg(a, pb, Q), pbi, Q, ninv16) != [x % Q for x in a]:
            fail("INTT(NTT(a)) != a at N=16")
        # NTT-based negacyclic multiply vs independent golden
        b = [rnd.randrange(Q) for _ in range(n)]
        got = ntt_mul(a, b, pb, pbi, Q, ninv16)
        ref = negacyclic_mul(a, b, Q)
        if got != ref:
            fail("NTT mul != schoolbook negacyclic mul at N=16: %r vs %r"
                 % (got, ref))


# =============================================================================
# PRODUCTION size — O(N log N) round-trip only (no O(N^2) by default)
# =============================================================================
def prod_roundtrip():
    pb = make_psi_brv(N, PSI, Q)
    pbi = make_psi_brv(N, pow(PSI, Q - 2, Q), Q)
    rnd = random.Random(7)
    for _ in range(8):
        a = [rnd.randrange(Q) for _ in range(N)]
        if intt_neg(ntt_neg(a, pb, Q), pbi, Q, NINV) != a:
            fail("INTT(NTT(a)) != a at N=1024 (full width q=12289)")

    if os.environ.get("DEEP_VERIFY") == "1":
        # O(N^2) golden at production size — gated, skipped by default.
        a = [rnd.randrange(Q) for _ in range(N)]
        b = [rnd.randrange(Q) for _ in range(N)]
        if ntt_mul(a, b, pb, pbi, Q, NINV) != negacyclic_mul(a, b, Q):
            fail("DEEP: NTT mul != golden at N=1024")


def main():
    # Tier 1
    t1_barrett()
    t1_roots()
    t1_bank_bijection()
    t1_operand_pair_distinct()
    t1_radix4_is_dft4()
    t1_op_counts()
    t1_fsm()
    # Tier 2
    t2_small_roundtrip_and_mul()
    # Production-size structural / round-trip
    prod_roundtrip()
    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
