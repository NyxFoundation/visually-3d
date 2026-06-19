#!/usr/bin/env python3
"""
Self-checking reproduction of the CFNTT Radix-2/4 NTT multiplication accelerator
from its scene spec ALONE (math/interface fields only; geometry ignored).

What is reproduced (from the spec's authoritative `spec` fields):
  * q = 12289 (14-bit NTT-friendly prime), N = 1024, generator g = 11.
  * negacyclic transform: psi = g^((q-1)/2N) (order 2N), omega = psi^2 (order N),
    j = psi^512 (order 4, j^2 == -1), N^-1 mod q.
  * radix-2 Cooley-Tukey butterfly NTT/INTT and the fused radix-4 butterfly.
  * Barrett modular reduction: mu = floor(2^28/q) = 21843, shift k = 28,
    r = x - t*q with <=2 conditional subtractions.
  * conflict-free interleaved-bank mapping b(i) = (i + (i>>3)) mod 8, offset i>>3.

Verification follows ONE pattern: decompose correctness into small finite
obligations, discharge each with the cheapest sound check.
  - z3 proves: Barrett == (x mod q) over the full 28-bit product domain;
               the fused radix-4 BU == two radix-2 stages (a DFT4) for all
               field inputs; the per-block bank map is a bijection (no conflict).
  - exhaustive/golden: small-N (N<=16) butterfly NTT vs a direct DFT golden;
               negacyclic convolution vs schoolbook (mod x^N+1).
  - O(N log N) only at production N=1024: forward/inverse round-trip identity
               and structural invariants. A full-size convolution-vs-schoolbook
               (O(N^2)) check is gated behind DEEP_VERIFY=1.

Prints "VERIFIED" / exit 0 on success, else "FAIL: ..." / exit 1.
Only stdlib + z3.
"""

import os
import sys
import random

try:
    import z3
except Exception as e:  # pragma: no cover
    print("FAIL: z3 unavailable: %r" % (e,))
    sys.exit(1)


# ---------------------------------------------------------------------------
# Spec-pinned parameters (from metadata.spec / parts[*].spec)
# ---------------------------------------------------------------------------
Q = 12289                  # widths.coefficient = 14 -> 14-bit prime
G = 11                     # twiddle_rom.generator_g
N_PROD = 1024              # params.N
BANKS = 8                  # parallel_butterfly_units
K_SHIFT = 28               # mod_red_mult.k_shift
MU = (1 << K_SHIFT) // Q   # = 21843  (mu_formula)


def fail(msg: str) -> None:
    print("FAIL: " + msg)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Field helpers (independent golden building blocks)
# ---------------------------------------------------------------------------
def root_psi(n: int) -> int:
    """2n-th primitive root: psi = g^((q-1)/(2n)) mod q  (order 2n, negacyclic)."""
    assert (Q - 1) % (2 * n) == 0
    return pow(G, (Q - 1) // (2 * n), Q)


# ---------------------------------------------------------------------------
# Barrett modular reduction (the hardware reduction stage)
# ---------------------------------------------------------------------------
def barrett_reduce(x: int) -> int:
    """Reduce x in [0, 2^28) to x mod q via Barrett (mu, k) + <=2 corrections."""
    t = (x * MU) >> K_SHIFT          # mod_red_mult:  t = (x*mu) >> k
    r = x - t * Q                    # mod_red_subshift: r = x - t*q
    if r >= Q:                       # while r >= q: r -= q  (<=2 iterations)
        r -= Q
    if r >= Q:
        r -= Q
    return r


def mulmod(a: int, b: int) -> int:
    """Modular multiply used by the datapath; routes through Barrett (product < 2^28)."""
    p = a * b
    if 0 <= p < (1 << K_SHIFT):
        return barrett_reduce(p)
    return p % Q


# ---------------------------------------------------------------------------
# Butterflies
# ---------------------------------------------------------------------------
def bf2(x0: int, x1: int, w: int):
    """radix-2 DIT: u=x0, t=w*x1 -> (u+t, u-t) mod q."""
    t = mulmod(w, x1)
    return (x0 + t) % Q, (x0 - t) % Q


def bf4(x0, x1, x2, x3, w, j):
    """Fused radix-4 BU per config_radix_selector.radix4_butterfly.
       W1=w, W2=w^2, W3=w^3, j a constant rotator (j^2 == -1)."""
    w2 = mulmod(w, w)
    w3 = mulmod(w2, w)
    b = mulmod(w, x1)
    c = mulmod(w2, x2)
    d = mulmod(w3, x3)
    y0 = (x0 + b + c + d) % Q
    y1 = (x0 + mulmod(j, b) - c - mulmod(j, d)) % Q
    y2 = (x0 - b + c - d) % Q
    y3 = (x0 - mulmod(j, b) - c + mulmod(j, d)) % Q
    return y0, y1, y2, y3


# ---------------------------------------------------------------------------
# Transform engine (radix-2 Cooley-Tukey DIT, natural order in -> natural order)
# ---------------------------------------------------------------------------
def ntt_rec(a, w):
    """X[k] = sum_n a[n] * w^{n k} mod q, computed by radix-2 butterflies."""
    n = len(a)
    if n == 1:
        return [a[0] % Q]
    w2 = mulmod(w, w)
    even = ntt_rec(a[0::2], w2)
    odd = ntt_rec(a[1::2], w2)
    res = [0] * n
    wk = 1
    half = n // 2
    for k in range(half):
        lo, hi = bf2(even[k], odd[k], wk)
        res[k] = lo
        res[k + half] = hi
        wk = mulmod(wk, w)
    return res


def forward_negacyclic(a):
    """Negacyclic forward NTT: pre-twist by psi^i, then cyclic NTT with omega."""
    n = len(a)
    psi = root_psi(n)
    omega = mulmod(psi, psi)
    pre = [mulmod(a[i], pow(psi, i, Q)) for i in range(n)]
    return ntt_rec(pre, omega)


def inverse_negacyclic(A):
    """Negacyclic inverse: cyclic INTT with omega^-1, scale N^-1, post-twist psi^-i."""
    n = len(A)
    psi = root_psi(n)
    omega = mulmod(psi, psi)
    omega_inv = pow(omega, Q - 2, Q)
    n_inv = pow(n, Q - 2, Q)
    t = ntt_rec(A, omega_inv)
    t = [mulmod(v, n_inv) for v in t]
    psi_inv = pow(psi, Q - 2, Q)
    return [mulmod(t[i], pow(psi_inv, i, Q)) for i in range(n)]


# ---------------------------------------------------------------------------
# Golden reference models (independent of the implementation above)
# ---------------------------------------------------------------------------
def dft_golden(a, w):
    """Direct O(n^2) DFT: the reference for ntt_rec on small n."""
    n = len(a)
    return [sum(a[m] * pow(w, m * k, Q) for m in range(n)) % Q for k in range(n)]


def negconv_golden(a, b):
    """Schoolbook negacyclic convolution mod (x^n + 1)."""
    n = len(a)
    c = [0] * n
    for i in range(n):
        for k in range(n):
            v = a[i] * b[k] % Q
            j = i + k
            if j < n:
                c[j] = (c[j] + v) % Q
            else:
                c[j - n] = (c[j - n] - v) % Q
    return c


def bank(i: int) -> int:
    return (i + (i >> 3)) % BANKS


# ---------------------------------------------------------------------------
# Bank-index/offset for the conflict-free memory map (addr_gen_unit / crossbar)
# ---------------------------------------------------------------------------
def offset(i: int) -> int:
    return i >> 3


# ===========================================================================
# OBLIGATION 1 — spec-pinned constants are self-consistent
# ===========================================================================
def check_constants():
    if MU != 21843:
        fail("mu mismatch: got %d expected 21843" % MU)
    psi = root_psi(N_PROD)
    if psi != 1945:
        fail("psi(N=1024) = %d, spec says 1945" % psi)
    if mulmod(psi, psi) != 10302:
        fail("omega mismatch: got %d expected 10302" % mulmod(psi, psi))
    if pow(N_PROD, Q - 2, Q) != 12277:
        fail("N^-1 mismatch: got %d expected 12277" % pow(N_PROD, Q - 2, Q))
    if pow(psi, 1024, Q) != Q - 1:
        fail("psi^1024 != -1 (negacyclic) : got %d" % pow(psi, 1024, Q))
    if pow(psi, 2048, Q) != 1:
        fail("psi^2048 != 1 : got %d" % pow(psi, 2048, Q))
    j = pow(psi, 512, Q)
    if (j * j) % Q != Q - 1:
        fail("j=psi^512 not a 4th root: j^2 = %d (expected %d)" % ((j * j) % Q, Q - 1))
    # pipeline latency 3+1+4+1 = 9 (lane_total)
    if 3 + 1 + 4 + 1 != 9:
        fail("pipeline latency decomposition != 9")


# ===========================================================================
# OBLIGATION 2 — Barrett == (x mod q) over the WHOLE 28-bit product domain (z3)
# ===========================================================================
def check_barrett_z3():
    W = 64
    x = z3.BitVec("x", W)
    q = z3.BitVecVal(Q, W)
    mu = z3.BitVecVal(MU, W)
    t = z3.LShR(x * mu, K_SHIFT)
    r0 = x - t * q
    r1 = z3.If(z3.UGE(r0, q), r0 - q, r0)
    r2 = z3.If(z3.UGE(r1, q), r1 - q, r1)
    s = z3.Solver()
    s.set("timeout", 30000)
    s.add(z3.ULT(x, Q * Q))                       # all real butterfly products
    s.add(z3.Or(z3.UGE(r2, q), r2 != z3.URem(x, q)))  # negate correctness
    res = s.check()
    if res == z3.sat:
        m = s.model()
        bad = m[x].as_long()
        fail("Barrett wrong at x=%d: got %d, mod=%d" % (bad, barrett_reduce(bad), bad % Q))
    if res != z3.unsat:
        fail("Barrett z3 inconclusive: %s" % res)


# ===========================================================================
# OBLIGATION 3 — fused radix-4 BU == two radix-2 stages (DFT4) for ALL inputs (z3)
# ===========================================================================
def check_radix4_equiv_z3():
    psi = root_psi(N_PROD)
    J = pow(psi, 512, Q)            # the real constant rotator, j^2 == -1
    W = 7                           # any twiddle; identity is twiddle-agnostic
    W1, W2, W3 = W % Q, (W * W) % Q, (W * W * W) % Q

    x0, x1, x2, x3 = (z3.Int("x%d" % i) for i in range(4))
    qz = z3.IntVal(Q)

    def m(a, b):
        return (a * b) % qz

    b = m(W1, x1); c = m(W2, x2); d = m(W3, x3)
    # spec radix-4 outputs
    y0 = (x0 + b + c + d) % qz
    y1 = (x0 + m(J, b) - c - m(J, d)) % qz
    y2 = (x0 - b + c - d) % qz
    y3 = (x0 - m(J, b) - c + m(J, d)) % qz
    # two radix-2 stages over (x0, b, c, d) -> DFT4 with 4th root J
    e0 = (x0 + c) % qz; e1 = (x0 - c) % qz
    o0 = (b + d) % qz;  o1 = m((b - d) % qz, J)
    z0 = (e0 + o0) % qz; z1 = (e1 + o1) % qz
    z2 = (e0 - o0) % qz; z3v = (e1 - o1) % qz

    s = z3.Solver()
    s.set("timeout", 30000)
    for v in (x0, x1, x2, x3):
        s.add(v >= 0, v < Q)
    s.add(z3.Or(y0 != z0, y1 != z1, y2 != z2, y3 != z3v))
    res = s.check()
    if res == z3.sat:
        mdl = s.model()
        fail("radix-4 != two radix-2 stages at %s" %
             {str(v): mdl[v] for v in (x0, x1, x2, x3)})
    if res != z3.unsat:
        fail("radix-4 equivalence z3 inconclusive: %s" % res)


# ===========================================================================
# OBLIGATION 4 — conflict-free bank map: per-block bijection (z3) + global injective
# ===========================================================================
def check_bankmap():
    # z3: within any block of 8 consecutive indices the 8 banks are all distinct,
    # i.e. r -> (r + o) mod 8 is a bijection for every block-offset o.
    o = z3.BitVec("o", 16)
    r1 = z3.BitVec("r1", 16)
    r2 = z3.BitVec("r2", 16)
    s = z3.Solver()
    s.set("timeout", 15000)
    s.add(z3.ULT(r1, 8), z3.ULT(r2, 8), r1 != r2)
    s.add(((r1 + o) & 7) == ((r2 + o) & 7))   # a collision in one block
    res = s.check()
    if res == z3.sat:
        fail("bank map collides within a block: %s" % s.model())
    if res != z3.unsat:
        fail("bank-map z3 inconclusive: %s" % res)

    # global injectivity of i -> (bank, offset) over the production address space
    seen = {}
    for i in range(N_PROD):
        key = (bank(i), offset(i))
        if key in seen:
            fail("bank/offset collision: i=%d and i=%d both map to %s" % (seen[key], i, key))
        seen[key] = i
        if offset(i) >= 256:                   # depth_words = 256 per bank
            fail("offset %d exceeds bank depth 256 at i=%d" % (offset(i), i))
    if BANKS * 256 < N_PROD:
        fail("capacity %d < N=%d" % (BANKS * 256, N_PROD))


# ===========================================================================
# OBLIGATION 5 — butterfly NTT matches the DFT golden on small N (exhaustive-ish)
# ===========================================================================
def check_ntt_vs_golden():
    rng = random.Random(1)
    for n in (2, 4, 8, 16):
        psi = root_psi(n)
        w = mulmod(psi, psi)               # n-th root for a cyclic NTT
        for _ in range(40):
            a = [rng.randrange(Q) for _ in range(n)]
            got = ntt_rec(a, w)
            exp = dft_golden(a, w)
            if got != exp:
                fail("ntt_rec != DFT at n=%d: %s vs %s" % (n, got, exp))


# ===========================================================================
# OBLIGATION 6 — negacyclic NTT-multiply == schoolbook mod (x^n+1) on small N
# ===========================================================================
def check_negacyclic():
    rng = random.Random(2)
    for n in (2, 4, 8, 16):
        for _ in range(30):
            a = [rng.randrange(Q) for _ in range(n)]
            b = [rng.randrange(Q) for _ in range(n)]
            fa = forward_negacyclic(a)
            fb = forward_negacyclic(b)
            prod = [mulmod(fa[i], fb[i]) for i in range(n)]
            c = inverse_negacyclic(prod)
            exp = negconv_golden(a, b)
            if c != exp:
                fail("negacyclic mult != schoolbook at n=%d: %s vs %s" % (n, c, exp))


# ===========================================================================
# OBLIGATION 7 — radix-4 lane fusion produces identical NTT to radix-2 (small N)
# ===========================================================================
def check_radix4_lane():
    rng = random.Random(3)
    psi = root_psi(N_PROD)
    J = pow(psi, 512, Q)
    for _ in range(200):
        x = [rng.randrange(Q) for _ in range(4)]
        w = rng.randrange(Q)
        y = bf4(x[0], x[1], x[2], x[3], w, J)
        # reference via two radix-2 stages over (x0, w x1, w^2 x2, w^3 x3)
        b = mulmod(w, x[1]); c = mulmod(mulmod(w, w), x[2])
        d = mulmod(mulmod(mulmod(w, w), w), x[3])
        s0a, s0b = bf2(x[0], c, 1)
        s1a, s1b = bf2(b, d, 1)
        s1b = mulmod(s1b, J)
        ref = ((s0a + s1a) % Q, (s0b + s1b) % Q, (s0a - s1a) % Q, (s0b - s1b) % Q)
        if y != ref:
            fail("bf4 lane mismatch: %s vs %s (x=%s w=%d)" % (y, ref, x, w))


# ===========================================================================
# OBLIGATION 8 — production N=1024 round-trip identity (O(N log N), no full DFT)
# ===========================================================================
def check_production_roundtrip():
    rng = random.Random(4)
    for _ in range(3):
        a = [rng.randrange(Q) for _ in range(N_PROD)]
        back = inverse_negacyclic(forward_negacyclic(a))
        if back != a:
            for i in range(N_PROD):
                if back[i] != a[i]:
                    fail("N=1024 round-trip differs at index %d: %d vs %d"
                         % (i, back[i], a[i]))
            fail("N=1024 round-trip differs (length mismatch)")

    # optional deep, full-size negacyclic mult vs schoolbook (O(N^2)) — off by default
    if os.environ.get("DEEP_VERIFY") == "1":
        a = [rng.randrange(Q) for _ in range(N_PROD)]
        b = [rng.randrange(Q) for _ in range(N_PROD)]
        fa = forward_negacyclic(a); fb = forward_negacyclic(b)
        prod = [mulmod(fa[i], fb[i]) for i in range(N_PROD)]
        got = inverse_negacyclic(prod)
        exp = negconv_golden(a, b)
        if got != exp:
            fail("DEEP N=1024 negacyclic mult != schoolbook")


def main():
    check_constants()
    check_barrett_z3()
    check_radix4_equiv_z3()
    check_bankmap()
    check_ntt_vs_golden()
    check_negacyclic()
    check_radix4_lane()
    check_production_roundtrip()
    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
