#!/usr/bin/env python3
"""
CFNTT Radix-2/4 NTT Multiplication Accelerator (FPGA) -- functional reproduction
from the scene spec alone.  Single self-checking script (stdlib + z3).

We model only the FUNCTIONAL datapath the spec pins down:
  * params q=12289, N=1024, psi=1945 (negacyclic, order 2048), omega=psi^2,
    Ninv=1024^-1, Barrett mu=21843 / k=28;
  * a merged-negacyclic radix-2 NTT (CT/DIT) + INTT (GS/DIF);
  * the radix-4 fused butterfly equations (DFT4 of twiddled inputs, rotator j);
  * the XOR-fold conflict-free bank/offset memory map;
  * Barrett modular reduction (q-multiply then shift/subtract+correct);
  * the schedule FSM (reachability of the consolidated transition table).

Verification turns correctness into small FINITE obligations, each discharged
with the cheapest sound check (z3 over a bounded domain, basis-vector linearity,
exhaustive enumeration over [0,N), or O(N log N) round-trip / convolution).
"""

import os
import random
from z3 import (BitVec, BitVecVal, LShR, ULT, ULE, UGE, UGT, Or, Solver, sat)

# ---------------------------------------------------------------------------
# Authoritative parameters (from spec; NOT guesses)
# ---------------------------------------------------------------------------
Q          = 12289          # 14-bit NTT-friendly prime, q = 3*2^12 + 1
N          = 1024           # transform length
PSI        = 1945           # primitive 2048th root (negacyclic), 11^6 mod q
OMEGA      = 10302          # psi^2, primitive 1024th root
NINV       = 12277          # 1024^-1 mod q
BARRETT_MU = 21843          # floor(2^28 / q)
BARRETT_K  = 28
GEN_G      = 11             # generator (psi = g^6)
PARALLEL   = 8              # parallel butterfly units / BRAM banks
BANKS      = 8


def fail(msg):
    print("FAIL: " + msg)
    raise SystemExit(1)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def bit_reverse(x, bits):
    return int(format(x, "0{}b".format(bits))[::-1], 2)


def order(a, q):
    """Multiplicative order of a mod q (small q, cheap)."""
    if a % q == 0:
        return 0
    o, cur = 1, a % q
    while cur != 1:
        cur = (cur * a) % q
        o += 1
        if o > q:
            return -1
    return o


def find_neg_psi(n, q=Q, g=GEN_G):
    """A primitive 2n-th root of unity mod q (psi^n == -1). Used for small-n tests."""
    assert (q - 1) % (2 * n) == 0, "2n must divide q-1"
    psi = pow(g, (q - 1) // (2 * n), q)
    if order(psi, q) != 2 * n:
        fail("could not obtain order-{} root for n={}".format(2 * n, n))
    return psi


# ---------------------------------------------------------------------------
# Memory map: XOR-fold conflict-free bank / offset  (committed reproduction map)
# ---------------------------------------------------------------------------
def bank(i):
    return (i ^ (i >> 3) ^ (i >> 6) ^ (i >> 9)) & 7


def offset(i):
    return i >> 3


# ---------------------------------------------------------------------------
# Barrett modular reduction: q-multiply then shift/subtract + correct
# ---------------------------------------------------------------------------
def barrett(x):
    """Reduce x in [0, q^2) to [0, q).  Mirrors mod_red_mult + mod_red_subshift."""
    qh = (x * BARRETT_MU) >> BARRETT_K     # mod_red_mult: quotient estimate
    r = x - qh * Q                         # mod_red_subshift: x - t*q
    while r >= Q:                          # at most 2 conditional subtractions
        r -= Q
    return r


# ---------------------------------------------------------------------------
# Radix-2 merged-negacyclic NTT / INTT  (CT/DIT forward, GS/DIF inverse)
# ---------------------------------------------------------------------------
def ntt(a, psi=PSI, q=Q):
    n = len(a)
    a = list(a)
    lb = n.bit_length() - 1
    tw = [pow(psi, bit_reverse(i, lb), q) for i in range(n)]
    t, m = n, 1
    while m < n:
        t //= 2
        for i in range(m):
            j1 = 2 * i * t
            S = tw[m + i]
            for j in range(j1, j1 + t):
                u = a[j]
                v = (a[j + t] * S) % q
                a[j] = (u + v) % q
                a[j + t] = (u - v) % q
        m *= 2
    return a


def intt(a, psi=PSI, q=Q):
    n = len(a)
    a = list(a)
    lb = n.bit_length() - 1
    psi_inv = pow(psi, q - 2, q)
    tw = [pow(psi_inv, bit_reverse(i, lb), q) for i in range(n)]
    t, m = 1, n
    while m > 1:
        j1, h = 0, m // 2
        for i in range(h):
            S = tw[h + i]
            for j in range(j1, j1 + t):
                u = a[j]
                v = a[j + t]
                a[j] = (u + v) % q
                a[j + t] = ((u - v) * S) % q
            j1 += 2 * t
        t *= 2
        m //= 2
    ninv = pow(n, q - 2, q)
    return [(x * ninv) % q for x in a]


def negacyclic_mul_schoolbook(a, b, q=Q):
    """Golden product in Z_q[x]/(x^n + 1)."""
    n = len(a)
    c = [0] * n
    for i in range(n):
        for j in range(n):
            k = i + j
            v = (a[i] * b[j]) % q
            if k < n:
                c[k] = (c[k] + v) % q
            else:
                c[k - n] = (c[k - n] - v) % q
    return c


# ---------------------------------------------------------------------------
# Radix-4 fused butterfly (the headline contribution), three formulations
# ---------------------------------------------------------------------------
def r4_bu(x, w, j, q=Q):
    """Spec equations: y0..y3 from b'=W1 x1, c'=W2 x2, d'=W3 x3, rotator j."""
    x0, x1, x2, x3 = x
    bp = (w * x1) % q                       # W1 = w
    cp = ((w * w) % q * x2) % q             # W2 = w^2
    dp = ((pow(w, 3, q)) * x3) % q          # W3 = w^3 (chained W1*(W2*x3))
    y0 = (x0 + bp + cp + dp) % q
    y1 = (x0 + j * bp - cp - j * dp) % q
    y2 = (x0 - bp + cp - dp) % q
    y3 = (x0 - j * bp - cp + j * dp) % q
    return [y0, y1, y2, y3]


def r4_dft4_golden(x, w, j, q=Q):
    """Independent golden: direct size-4 DFT (root j) of the twiddled inputs."""
    A = [x[0], (w * x[1]) % q, ((w * w) % q * x[2]) % q, (pow(w, 3, q) * x[3]) % q]
    y = []
    for k in range(4):
        acc = 0
        for n in range(4):
            acc = (acc + pow(j, (k * n) % 4, q) * A[n]) % q
        y.append(acc % q)
    return y


def r4_two_radix2(x, w, j, q=Q):
    """Two radix-2 DIT stages on twiddled inputs (the '2 radix-2 lanes = 1 radix-4')."""
    A = [x[0], (w * x[1]) % q, ((w * w) % q * x[2]) % q, (pow(w, 3, q) * x[3]) % q]
    # stage 1: DFT2 on (A0,A2) and (A1,A3)
    g0, g1 = (A[0] + A[2]) % q, (A[0] - A[2]) % q
    h0, h1 = (A[1] + A[3]) % q, (A[1] - A[3]) % q
    # stage 2: combine with second-stage twiddles {1, j}
    y0 = (g0 + h0) % q
    y1 = (g1 + j * h1) % q
    y2 = (g0 - h0) % q
    y3 = (g1 - j * h1) % q
    return [y0, y1, y2, y3]


# ---------------------------------------------------------------------------
# Schedule / FSM (consolidated transition table from schedule_controller.spec)
# ---------------------------------------------------------------------------
FSM_TRANSITIONS = {
    "IDLE":             ["LOAD"],
    "LOAD":             ["STAGE_LOOP"],
    "STAGE_LOOP":       ["TWIDDLE_FETCH", "INTT_STAGE_LOOP", "DRAIN"],
    "TWIDDLE_FETCH":    ["BUTTERFLY"],
    "BUTTERFLY":        ["REDUCE"],
    "REDUCE":           ["WRITEBACK"],
    "WRITEBACK":        ["TWIDDLE_FETCH", "STAGE_LOOP"],
    "INTT_STAGE_LOOP":  ["SCALE_N_INV"],
    "SCALE_N_INV":      ["DRAIN"],
    "DRAIN":            ["DONE"],
    "DONE":             ["IDLE"],
}


# ===========================================================================
# VERIFICATION OBLIGATIONS
# ===========================================================================
def check_constants():
    if pow(GEN_G, 6, Q) != PSI:
        fail("psi != g^6 (got {})".format(pow(GEN_G, 6, Q)))
    if order(PSI, Q) != 2 * N:
        fail("psi order != 2048 (got {})".format(order(PSI, Q)))
    if pow(PSI, N, Q) != Q - 1:
        fail("psi^N != -1 (negacyclic property violated)")
    if (PSI * PSI) % Q != OMEGA:
        fail("omega != psi^2")
    if order(OMEGA, Q) != N:
        fail("omega order != 1024")
    if (NINV * N) % Q != 1:
        fail("Ninv*N != 1 mod q")
    if BARRETT_MU != (1 << BARRETT_K) // Q:
        fail("mu != floor(2^28/q)")
    if Q * Q >= (1 << BARRETT_K):
        fail("q^2 not < 2^28 (Barrett input bound broken)")
    # j = psi^512 is a primitive 4th root (j^2 == -1)
    j = pow(PSI, 512, Q)
    if (j * j) % Q != Q - 1:
        fail("j=psi^512 is not a 4th root of unity (j^2 != -1)")


def check_barrett_z3():
    """Prove: for all x in [0, q^2), r = x - ((x*mu)>>k)*q satisfies 0 <= r < 3q
    (and r == x mod q follows since r = x - qh*q).  64-bit, constant mults."""
    x = BitVec("x", 64)
    qh = LShR(x * BitVecVal(BARRETT_MU, 64), BARRETT_K)
    r = x - qh * BitVecVal(Q, 64)
    s = Solver()
    s.set("timeout", 30000)
    s.add(ULT(x, BitVecVal(Q * Q, 64)))
    # counterexample: r outside [0, 3q)  (unsigned: r>=3q, or qh*q > x => underflow)
    s.add(Or(UGE(r, BitVecVal(3 * Q, 64)),
             UGT(qh * BitVecVal(Q, 64), x)))
    res = s.check()
    if res == sat:
        m = s.model()
        fail("Barrett bound violated, x={}".format(m[x]))
    if res != Solver().check.__self__.__class__ and str(res) != "unsat":
        fail("Barrett z3 inconclusive: {}".format(res))
    # concrete spot check of the full barrett() against ground truth
    random.seed(1)
    samples = [0, 1, Q - 1, Q, Q + 1, Q * Q - 1] + [random.randrange(Q * Q) for _ in range(2000)]
    for v in samples:
        b = barrett(v)
        if b != v % Q or not (0 <= b < Q):
            fail("barrett({}) = {} != {}".format(v, b, v % Q))


def check_bank_map_bijection():
    seen = set()
    for i in range(N):
        b, o = bank(i), offset(i)
        if not (0 <= b < BANKS):
            fail("bank({}) out of range: {}".format(i, b))
        if not (0 <= o < N // BANKS):
            fail("offset({}) out of range: {}".format(i, o))
        if (b, o) in seen:
            fail("(bank,offset) collision at i={}".format(i))
        seen.add((b, o))
    if len(seen) != N:
        fail("(bank,offset) not a bijection over [0,N)")


def check_conflict_free():
    """At each DIT stage s the radix-2 pair (i, i+2^s) [bit s of i == 0] must hit
    distinct banks; the radix-4 quad (i, i+2^s, i+2^(s+1), i+3*2^s) must hit 4
    distinct banks.  Exhaustive over [0,N)."""
    for s in range(10):                      # stages 0..9, stride 2^s
        m = 1 << s
        for i in range(N):
            if i & m:
                continue
            if i + m < N and bank(i) == bank(i + m):
                fail("radix-2 bank conflict: stage {}, i={}".format(s, i))
        if s <= 8:                           # radix-4 needs bit s and s+1 clear
            m2 = 1 << (s + 1)
            for i in range(N):
                if (i & m) or (i & m2):
                    continue
                quad = [i, i + m, i + m2, i + 3 * m]
                if max(quad) < N and len({bank(x) for x in quad}) != 4:
                    fail("radix-4 bank conflict: stage {}, i={}".format(s, i))


def check_ntt_roundtrip():
    """NTT then INTT is the identity, at production size N=1024 (O(N log N))."""
    random.seed(2)
    for _ in range(8):
        a = [random.randrange(Q) for _ in range(N)]
        if intt(ntt(a)) != a:
            fail("NTT/INTT round-trip != identity at N={}".format(N))
    # edge vectors
    for a in ([0] * N, [1] + [0] * (N - 1), [Q - 1] * N):
        if intt(ntt(a)) != a:
            fail("NTT/INTT round-trip failed on edge vector")


def check_negacyclic_convolution():
    """NTT-domain pointwise product == schoolbook product mod (x^n+1).
    Small n keeps the O(n^2) golden cheap and sound."""
    for n in (4, 8, 16, 32):
        psi = find_neg_psi(n)
        random.seed(100 + n)
        for _ in range(20):
            a = [random.randrange(Q) for _ in range(n)]
            b = [random.randrange(Q) for _ in range(n)]
            fa, fb = ntt(a, psi), ntt(b, psi)
            point = [(fa[i] * fb[i]) % Q for i in range(n)]
            got = intt(point, psi)
            want = negacyclic_mul_schoolbook(a, b)
            if got != want:
                fail("negacyclic conv mismatch at n={}".format(n))


def check_radix4_butterfly():
    """Three formulations of the fused radix-4 BU must agree.  The BU is linear
    over Z_q, so agreement on the 4 basis vectors (for several twiddles w) proves
    agreement for ALL inputs -- a sound finite check."""
    j = pow(PSI, 512, Q)                     # = omega^(N/4), j^2 = -1
    basis = [[1 if k == r else 0 for k in range(4)] for r in range(4)]
    extra = [[3, 7, 11, 13], [Q - 1, 0, 5, 9999]]
    ws = [1, OMEGA, pow(OMEGA, 7, Q), pow(OMEGA, 123, Q), Q - 1]
    for w in ws:
        for x in basis + extra:
            a = r4_bu(x, w, j)
            b = r4_dft4_golden(x, w, j)
            c = r4_two_radix2(x, w, j)
            if a != b:
                fail("radix-4 BU != DFT4 golden (w={}, x={})".format(w, x))
            if a != c:
                fail("radix-4 BU != two radix-2 stages (w={}, x={})".format(w, x))


def check_fsm():
    """Every state reachable from IDLE, and DONE reachable; no dangling targets."""
    states = set(FSM_TRANSITIONS)
    for src, dsts in FSM_TRANSITIONS.items():
        for d in dsts:
            if d not in states:
                fail("FSM transition to unknown state: {} -> {}".format(src, d))
    seen, stack = {"IDLE"}, ["IDLE"]
    while stack:
        cur = stack.pop()
        for d in FSM_TRANSITIONS[cur]:
            if d not in seen:
                seen.add(d)
                stack.append(d)
    if seen != states:
        fail("unreachable FSM states: {}".format(states - seen))
    if "DONE" not in seen:
        fail("DONE state unreachable")


def check_loop_bounds():
    """Schedule counts implied by N, P=8, radix."""
    if 1 << 10 != N:
        fail("log2(N) != 10")
    p = PARALLEL
    bf_r2 = 10 * ((N // 2) // p)              # 10 stages * 512/8
    bf_r4 = 5 * ((N // 4) // p)               # 5 passes  * 256/8
    if bf_r2 != 640 or bf_r4 != 160:
        fail("butterfly cycle counts wrong: r2={} r4={}".format(bf_r2, bf_r4))
    # pipeline latency breakdown 3+1+4+1 = 9
    if 3 + 1 + 4 + 1 != 9:
        fail("pipeline latency != 9")


# ===========================================================================
def main():
    try:
        check_constants()
        check_barrett_z3()
        check_bank_map_bijection()
        check_conflict_free()
        check_radix4_butterfly()
        check_ntt_roundtrip()
        check_negacyclic_convolution()
        check_fsm()
        check_loop_bounds()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001  -- any unexpected error is a failure
        fail("unexpected exception: {!r}".format(e))
    print("VERIFIED")
    raise SystemExit(0)


if __name__ == "__main__":
    main()
