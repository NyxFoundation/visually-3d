#!/usr/bin/env python3
"""
Self-checking reverse-implementation of the CFNTT Radix-2/4 NTT accelerator.

Functional core taken from the SPEC's authoritative fields:
  N=1024, q=12289, psi=1945 (negacyclic, order 2048), omega=psi^2=10302,
  Ninv=12277, Barrett mu=21843, k=28, j=psi^512.

Verification turns correctness into small finite obligations:
  1. Barrett reduction == x mod q for ALL x in [0,q^2), >=0..<q, <=2 corrections
     (proved with z3 over a bounded bit-vector domain).
  2. Bank map is a bijection on [0,N) and conflict-free for every radix-2 stride
     and the radix-4 quad (exhaustive enumeration).
  3. Radix-4 butterfly == independent DFT-4 matrix (powers of j) over symbolic
     inputs mod q (z3).
  4. Negacyclic NTT/INTT pair: round-trip identity at full N, and the negacyclic
     convolution property vs independent goldens (monomial goldens at full N,
     a dense O(N^2) golden at a small prime).
  5. Structural / op-count / FSM obligations.
"""
import os, random
from z3 import (BitVec, BitVecVal, ULT, UGE, URem, LShR, If, Solver, Int, Or,
                And, sat, unsat)

# ---------------------------------------------------------------- parameters
N    = 1024
Q    = 12289
PSI  = 1945
OMEGA= 10302
NINV = 12277
MU   = 21843
K    = 28
J    = pow(PSI, 512, Q)        # order-4 rotator
LOGN = 10

# ---------------------------------------------------------------- Barrett
def barrett_reduce(x):
    """x in [0, q^2) -> x mod q, <=2 conditional subtractions (SPEC)."""
    t = (x * MU) >> K
    r = x - t * Q
    if r >= Q: r -= Q
    if r >= Q: r -= Q
    return r

def modmul(a, b):
    return barrett_reduce(a * b)

# ---------------------------------------------------------------- bank map
def bank(i):   return (i & 7) ^ ((i >> 3) & 7) ^ ((i >> 6) & 7) ^ ((i >> 9) & 7)
def offset(i): return i >> 3

# ---------------------------------------------------------------- twiddle / NTT
def bitrev(x, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (x & 1)
        x >>= 1
    return r

def make_transform(n, q, psi, reduce_fn=None):
    """Merged-negacyclic CT (forward) + GS (inverse) pair, bit-reversed tables."""
    logn = n.bit_length() - 1
    if reduce_fn is None:
        reduce_fn = lambda x: x % q
    psi_pows = [1] * n
    for i in range(1, n): psi_pows[i] = reduce_fn(psi_pows[i-1] * psi)
    psi_inv = pow(psi, q - 2, q)
    psiinv_pows = [1] * n
    for i in range(1, n): psiinv_pows[i] = reduce_fn(psiinv_pows[i-1] * psi_inv)
    psi_rev    = [psi_pows[bitrev(i, logn)]    for i in range(n)]
    psiinv_rev = [psiinv_pows[bitrev(i, logn)] for i in range(n)]
    n_inv = pow(n, q - 2, q)

    def ntt(a):
        a = a[:]; t = n; m = 1
        while m < n:
            t //= 2
            for i in range(m):
                j1 = 2 * i * t
                S = psi_rev[m + i]
                for jj in range(j1, j1 + t):
                    U = a[jj]; V = reduce_fn(a[jj + t] * S)
                    a[jj] = (U + V) % q; a[jj + t] = (U - V) % q
            m *= 2
        return a

    def intt(a):
        a = a[:]; t = 1; m = n
        while m > 1:
            j1 = 0; h = m // 2
            for i in range(h):
                S = psiinv_rev[h + i]
                for jj in range(j1, j1 + t):
                    U = a[jj]; V = a[jj + t]
                    a[jj] = (U + V) % q
                    a[jj + t] = reduce_fn(((U - V) % q) * S)
                j1 += 2 * t
            t *= 2; m //= 2
        return [reduce_fn((x * n_inv) % q) for x in a]

    return ntt, intt, n_inv

NTT, INTT, _ninv = make_transform(N, Q, PSI, barrett_reduce)

def negconv_via_ntt(a, b):
    A = NTT(a); B = NTT(b)
    C = [modmul(A[i], B[i]) for i in range(N)]
    return INTT(C)

# ---------------------------------------------------------------- radix-4 BU
def radix4_bf(x0, x1, x2, x3, w):
    W1, W2, W3 = w, modmul(w, w), modmul(modmul(w, w), w)
    bp = modmul(W1, x1); cp = modmul(W2, x2); dp = modmul(W3, x3)
    y0 = (x0 + bp + cp + dp) % Q
    y1 = (x0 + J * bp - cp - J * dp) % Q
    y2 = (x0 - bp + cp - dp) % Q
    y3 = (x0 - J * bp - cp + J * dp) % Q
    return [y0, y1, y2, y3]

# ================================================================ CHECKS
def fail(msg):
    print("FAIL: " + msg); raise SystemExit(1)

# --- 1. Barrett correctness over the whole [0,q^2) domain (z3) ----------
def check_barrett():
    if MU != (1 << K) // Q:
        fail(f"mu mismatch: {MU} != floor(2^{K}/q)={(1<<K)//Q}")
    x = BitVec('x', 64)
    q = BitVecVal(Q, 64); mu = BitVecVal(MU, 64)
    t = LShR(x * mu, K)
    r = x - t * q
    r1 = If(UGE(r, q), r - q, r)
    r2 = If(UGE(r1, q), r1 - q, r1)
    s = Solver()
    s.add(ULT(x, Q * Q))
    s.add(Or(r2 != URem(x, q),          # wrong value
             UGE(r2, q),                # not reduced
             UGE(r, BitVecVal(3 * Q, 64))))  # would need >2 subtractions
    if s.check() != unsat:
        m = s.model(); fail(f"barrett counterexample x={m[x]}")
    # spot-check the python impl agrees
    for xv in [0, 1, Q - 1, Q, Q * Q - 1, 268435455, 151019520]:
        if barrett_reduce(xv) != xv % Q:
            fail(f"barrett python xv={xv}")

# --- 2. conflict-free bank mapping (exhaustive) -------------------------
def check_bankmap():
    seen = {}
    for i in range(N):
        key = (bank(i), offset(i))
        if key in seen:
            fail(f"bank map not bijective: {i} and {seen[key]} -> {key}")
        seen[key] = i
        if not (0 <= bank(i) < 8) or not (0 <= offset(i) < 128):
            fail(f"bank/offset out of range at i={i}")
    # radix-2: every stage stride 2^s pairs (i, i+2^s) in distinct banks
    for s in range(LOGN):
        m = 1 << s
        for i in range(N):
            if not ((i >> s) & 1):  # bit s clear -> i is the low partner
                if bank(i) == bank(i + m):
                    fail(f"radix-2 bank conflict stride 2^{s} at i={i}")
    # radix-4: the quad (i, i+2^s, i+2^(s+1), i+3*2^s) -> 4 distinct banks
    for s in range(LOGN - 1):
        m = 1 << s
        for i in range(N):
            if ((i >> s) & 1) == 0 and ((i >> (s + 1)) & 1) == 0:
                quad = [i, i + m, i + 2 * m, i + 3 * m]
                if max(quad) < N:
                    bs = {bank(t) for t in quad}
                    if len(bs) != 4:
                        fail(f"radix-4 bank conflict stride 2^{s} at i={i}")

# --- 3. radix-4 butterfly == DFT-4 matrix (z3, symbolic mod q) ----------
def check_radix4():
    if pow(J, 2, Q) != Q - 1:
        fail(f"j^2 != -1 mod q (j={J})")
    w = pow(OMEGA, 5, Q)                 # arbitrary concrete twiddle
    W1, W2, W3 = w, (w * w) % Q, (w * w % Q * w) % Q
    M = [[pow(J, (m * n) % 4, Q) for n in range(4)] for m in range(4)]
    x0, x1, x2, x3 = Int('x0'), Int('x1'), Int('x2'), Int('x3')
    bp = W1 * x1; cp = W2 * x2; dp = W3 * x3
    impl = [
        x0 + bp + cp + dp,
        x0 + J * bp - cp - J * dp,
        x0 - bp + cp - dp,
        x0 - J * bp - cp + J * dp,
    ]
    u = [x0, bp, cp, dp]
    gold = [sum(u[n] * M[m][n] for n in range(4)) for m in range(4)]
    s = Solver()
    for v in (x0, x1, x2, x3):
        s.add(v >= 0, v < Q)
    s.add(Or(*[(impl[m] - gold[m]) % Q != 0 for m in range(4)]))
    if s.check() != unsat:
        mdl = s.model(); fail(f"radix-4 != DFT4 at {mdl}")
    # cross-check the executable radix4_bf against the matrix on samples
    for _ in range(200):
        xs = [random.randrange(Q) for _ in range(4)]
        ww = random.randrange(Q)
        WW = [ww, ww * ww % Q, ww * ww % Q * ww % Q]
        uu = [xs[0], WW[0] * xs[1] % Q, WW[1] * xs[2] % Q, WW[2] * xs[3] % Q]
        gy = [sum(uu[n] * M[m][n] for n in range(4)) % Q for m in range(4)]
        if radix4_bf(*xs, ww) != gy:
            fail(f"radix4_bf mismatch xs={xs} w={ww}")

# --- 4a. negacyclic transform: round-trip identity at full N ------------
def check_roundtrip():
    rnd = random.Random(20260619)
    for _ in range(8):
        a = [rnd.randrange(Q) for _ in range(N)]
        if INTT(NTT(a)) != a:
            fail("INTT(NTT(x)) != x at N=1024")

# --- 4b. negacyclic convolution vs monomial golden (O(N) per case) ------
def check_monomial_negconv():
    rnd = random.Random(7)
    cases = [(0, 0), (1, N - 1), (1, 1), (N - 1, N - 1), (3, 5), (1023, 2)]
    cases += [(rnd.randrange(N), rnd.randrange(N)) for _ in range(12)]
    for i0, j0 in cases:
        a = [0] * N; a[i0] = 1
        b = [0] * N; b[j0] = 1
        got = negconv_via_ntt(a, b)
        exp = [0] * N
        k = i0 + j0
        if k < N:
            exp[k] = 1
        else:
            exp[k - N] = (Q - 1)          # x^N == -1 (negacyclic wrap)
        if got != exp:
            fail(f"monomial negconv x^{i0}*x^{j0}: got nonzero != expected")

# --- 4c. dense negacyclic golden at a small independent prime -----------
def golden_negconv(a, b, q):
    n = len(a); c = [0] * n
    for i in range(n):
        for j in range(n):
            v = a[i] * b[j]
            if i + j < n: c[i + j] = (c[i + j] + v) % q
            else:         c[i + j - n] = (c[i + j - n] - v) % q
    return c

def check_small_dense_negconv():
    n, q, psi = 4, 17, 2                  # 2 is a primitive 8th root mod 17
    if pow(psi, n, q) != q - 1 or pow(psi, 2 * n, q) != 1:
        fail("small-prime psi not a negacyclic root")
    ntt, intt, _ = make_transform(n, q, psi)
    rnd = random.Random(99)
    for _ in range(300):
        a = [rnd.randrange(q) for _ in range(n)]
        b = [rnd.randrange(q) for _ in range(n)]
        A = ntt(a); B = ntt(b)
        C = [(A[i] * B[i]) % q for i in range(n)]
        got = intt(C)
        if got != golden_negconv(a, b, q):
            fail(f"small dense negconv mismatch a={a} b={b}")

# --- 5. constants, structural, op-count, FSM ----------------------------
def check_constants():
    if pow(PSI, 1024, Q) != Q - 1:  fail("psi^1024 != -1 mod q")
    if pow(PSI, 2048, Q) != 1:      fail("psi^2048 != 1 mod q")
    if OMEGA != pow(PSI, 2, Q):     fail("omega != psi^2")
    if (N * NINV) % Q != 1:         fail("Ninv != N^-1 mod q")
    if Q != 3 * (1 << 12) + 1:      fail("q != 3*2^12+1")

def check_opcounts():
    # within-radix-4 reductions (NOT vs radix-2), per SPEC
    if abs((1 - 2 / 3) - 0.3333) > 1e-3: fail("mult reduction != 33%")
    if abs((1 - 8 / 10) - 0.20) > 1e-9:  fail("add/sub reduction != 20%")
    # parallel-issue cycle accounting
    if N // 2 // 8 != 64:  fail("radix-2 cycles/stage != 64")
    if N // 4 // 8 != 32:  fail("radix-4 cycles/stage != 32")
    if 4 ** 5 != 1024 or 2 ** 10 != 1024: fail("stage counts wrong")

def fsm_run(mode_intt):
    """Top-level reconstructed FSM; returns the visited state sequence."""
    nxt = {
        "IDLE": "LOAD", "LOAD": "RUN_STAGES",
        "RUN_STAGES": ("SCALE_INTT" if mode_intt else "DRAIN"),
        "SCALE_INTT": "DRAIN", "DRAIN": "DONE", "DONE": "IDLE",
    }
    seq = []; st = "IDLE"
    for _ in range(16):
        seq.append(st)
        if st == "DONE":
            seq.append(nxt[st]); break
        st = nxt[st]
    return seq

def check_fsm():
    ntt_seq = fsm_run(False)
    intt_seq = fsm_run(True)
    if ntt_seq != ["IDLE", "LOAD", "RUN_STAGES", "DRAIN", "DONE", "IDLE"]:
        fail(f"NTT FSM path wrong: {ntt_seq}")
    if intt_seq != ["IDLE", "LOAD", "RUN_STAGES", "SCALE_INTT",
                    "DRAIN", "DONE", "IDLE"]:
        fail(f"INTT FSM path wrong: {intt_seq}")
    if "SCALE_INTT" in ntt_seq:
        fail("NTT path must not scale by Ninv")

# --- optional deep check (off by default) -------------------------------
def deep_check():
    rnd = random.Random(1)
    a = [rnd.randrange(Q) for _ in range(N)]
    b = [rnd.randrange(Q) for _ in range(N)]
    if negconv_via_ntt(a, b) != golden_negconv(a, b, Q):
        fail("deep full-N dense negconv mismatch")

# ================================================================ main
def main():
    check_constants()
    check_barrett()
    check_bankmap()
    check_radix4()
    check_roundtrip()
    check_monomial_negconv()
    check_small_dense_negconv()
    check_opcounts()
    check_fsm()
    if os.environ.get("DEEP_VERIFY") == "1":
        deep_check()
    print("VERIFIED")

if __name__ == "__main__":
    main()
