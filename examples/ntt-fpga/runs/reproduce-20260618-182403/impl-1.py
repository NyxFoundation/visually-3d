#!/usr/bin/env python3
"""
CFNTT Radix-2/4 NTT multiplication accelerator -- reverse-implemented from a
scene spec ALONE, with an independent golden model and self-checking.

Implementation (the "datapath"):
  * Barrett modular reduction  (mod_red_mult + mod_red_subshift)
  * symmetric modular add / sub (bu_add_* / bu_sub_*)
  * DSP modular multiplier      (bu_mult_* : barrett(a*b))
  * radix-2 butterfly           (config_radix_selector.radix2_butterfly)
  * radix-4 fused butterfly     (config_radix_selector.radix4_butterfly)
  * negacyclic fast NTT / INTT  (butterfly array + twiddle ROM + N^-1 scale)
  * conflict-free bank map      (addr_gen_unit: b(i)=(i+(i>>3))%8, o(i)=i>>3)

Golden / reference (independent):
  * x % q for Barrett
  * (u+/-v)%q for the symmetric operators
  * a two-radix-2-stage composition for the radix-4 butterfly
  * O(N^2) schoolbook negacyclic convolution (mod x^N+1, mod q) for the
    whole NTT-multiply pipeline

Bit-bounded logic (Barrett, modular add/sub) is proven over ALL inputs with z3;
the larger NTT domain is checked with randomized + edge-case property tests.
"""

import sys
import random

# ---- spec parameters (authoritative `spec` fields) -------------------------
N    = 1024
Q    = 12289
MU   = 21843          # floor(2^28 / q)
K    = 28
PSI  = 1945           # 2N=2048-th primitive root (negacyclic)
OMEGA= 10302          # psi^2, N-th root
LOGN = 10


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


# ===========================================================================
# 1. constant sanity (all from spec; cheap, catches a wrong root/modulus)
# ===========================================================================
def check_constants():
    if (1 << K) // Q != MU:
        fail(f"mu mismatch: floor(2^{K}/{Q})={(1<<K)//Q} != {MU}")
    if pow(PSI, 2048, Q) != 1:
        fail("psi^2048 != 1 mod q")
    if pow(PSI, 1024, Q) != Q - 1:
        fail("psi^1024 != -1 mod q (not negacyclic)")
    if pow(PSI, 2, Q) != OMEGA:
        fail(f"psi^2 != omega ({pow(PSI,2,Q)} != {OMEGA})")
    if pow(11, 6, Q) != PSI:
        fail("g^6 != psi for stated generator g=11")
    j = pow(PSI, 512, Q)
    if (j * j) % Q != Q - 1:
        fail("j=psi^512 is not an order-4 root (j^2 != -1)")
    if pow(OMEGA, 256, Q) != j:
        fail("omega^(N/4) != j")
    ninv = pow(N, Q - 2, Q)
    if ninv != 12277:
        fail(f"N^-1 != 12277 (got {ninv})")


# ===========================================================================
# 2. datapath primitives
# ===========================================================================
def barrett(x):
    # mod_red_mult: t=(x*mu)>>k ; mod_red_subshift: r=x-t*q ; <=2 corrections
    t = (x * MU) >> K
    r = x - t * Q
    if r >= Q:
        r -= Q
    if r >= Q:
        r -= Q
    return r


def modmul(a, b):            # DSP multiplier + shared Barrett reduction
    return barrett(a * b)


def modadd(a, b):            # symmetric adder (a,b in [0,q))
    s = a + b
    return s - Q if s >= Q else s


def modsub(a, b):            # symmetric subtractor (a,b in [0,q))
    d = a - b + Q
    return d - Q if d >= Q else d


def radix2_bf(x0, x1, w):    # Cooley-Tukey: u=x0, v=w*x1
    v = modmul(w, x1)
    return modadd(x0, v), modsub(x0, v)


def radix4_bf(x0, x1, x2, x3, w):
    j = pow(PSI, 512, Q)
    w2 = modmul(w, w)
    w3 = modmul(w2, w)
    b_ = modmul(w, x1)
    c_ = modmul(w2, x2)
    d_ = modmul(w3, x3)
    jb = modmul(j, b_)
    jd = modmul(j, d_)
    y0 = modadd(modadd(x0, b_), modadd(c_, d_))
    y1 = modsub(modsub(modadd(x0, jb), c_), jd)
    y2 = modadd(modsub(x0, b_), modsub(c_, d_))
    y3 = modadd(modsub(modsub(x0, jb), c_), jd)
    return y0, y1, y2, y3


# ---- twiddle-ROM tables (bit-reversed powers, Longa-Naehrig style) ---------
def bitrev(x, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (x & 1)
        x >>= 1
    return r


PSI_POW    = [pow(PSI, i, Q) for i in range(N)]
PSI_INV    = pow(PSI, Q - 2, Q)
PSIINV_POW = [pow(PSI_INV, i, Q) for i in range(N)]
PSI_REV    = [PSI_POW[bitrev(i, LOGN)] for i in range(N)]
PSIINV_REV = [PSIINV_POW[bitrev(i, LOGN)] for i in range(N)]
N_INV      = pow(N, Q - 2, Q)


def ntt(a):                  # forward, CT, output in bit-reversed order
    a = a[:]
    t = N
    m = 1
    while m < N:
        t //= 2
        for i in range(m):
            j1 = 2 * i * t
            S = PSI_REV[m + i]
            for j in range(j1, j1 + t):
                U = a[j]
                V = modmul(a[j + t], S)
                a[j] = modadd(U, V)
                a[j + t] = modsub(U, V)
        m *= 2
    return a


def intt(a):                 # inverse, GS, output in natural order, *N^-1
    a = a[:]
    t = 1
    m = N
    while m > 1:
        j1 = 0
        h = m // 2
        for i in range(h):
            S = PSIINV_REV[h + i]
            for j in range(j1, j1 + t):
                U = a[j]
                V = a[j + t]
                a[j] = modadd(U, V)
                a[j + t] = modmul(modsub(U, V), S)
            j1 += 2 * t
        t *= 2
        m = h
    return [modmul(x, N_INV) for x in a]


def ntt_mul(a, b):           # full accelerator pipeline (NTT . pointwise . INTT)
    A = ntt(a)
    B = ntt(b)
    return intt([modmul(A[i], B[i]) for i in range(N)])


# ---- conflict-free bank map (addr_gen_unit) -------------------------------
def bank(i):
    return (i + (i >> 3)) % 8


def offset(i):
    return i >> 3


# ===========================================================================
# 3. golden / reference model (independent)
# ===========================================================================
def negaconv_ref(a, b):      # schoolbook  a*b mod (x^N+1) mod q
    c = [0] * N
    for i in range(N):
        ai = a[i]
        if ai == 0:
            continue
        for j in range(N):
            v = (ai * b[j]) % Q
            k = i + j
            if k < N:
                c[k] = (c[k] + v) % Q
            else:
                c[k - N] = (c[k - N] - v) % Q
    return c


def radix4_ref(x0, x1, x2, x3, w):
    # independent golden: radix-4 butterfly == two radix-2 stages
    w2 = (w * w) % Q
    p0 = (x0 + (w2 * x2)) % Q
    p2 = (x0 - (w2 * x2)) % Q
    p1 = (x1 + (w2 * x3)) % Q
    p3 = (x1 - (w2 * x3)) % Q
    wj = (w * pow(PSI, 512, Q)) % Q
    y0 = (p0 + (w * p1)) % Q
    y2 = (p0 - (w * p1)) % Q
    y1 = (p2 + (wj * p3)) % Q
    y3 = (p2 - (wj * p3)) % Q
    return y0, y1, y2, y3


# ===========================================================================
# 4. z3 proofs over ALL inputs for the bit-bounded logic
# ===========================================================================
def prove_bitbounded():
    from z3 import (BitVec, BitVecVal, LShR, If, UGE, ULE, ULT, URem,
                    Solver, sat)

    # ---- Barrett == x % q for all x in [0, (q-1)^2] ----
    x = BitVec('x', 64)
    qv = BitVecVal(Q, 64)
    t = LShR(x * BitVecVal(MU, 64), K)
    r = x - t * qv
    r = If(UGE(r, qv), r - qv, r)
    r = If(UGE(r, qv), r - qv, r)
    s = Solver()
    s.add(ULE(x, BitVecVal((Q - 1) * (Q - 1), 64)))
    s.add(r != URem(x, qv))
    if s.check() == sat:
        cx = s.model()[x]
        fail(f"Barrett wrong at x={cx}: got {s.model().eval(r)} expected {int(cx.as_long())%Q}")

    # ---- modular add / sub == (u +/- v) % q for all u,v in [0,q) ----
    u = BitVec('u', 32)
    v = BitVec('v', 32)
    q32 = BitVecVal(Q, 32)
    bounds = [ULT(u, q32), ULT(v, q32)]

    add = u + v
    add = If(UGE(add, q32), add - q32, add)
    s = Solver()
    s.add(bounds)
    s.add(add != URem(u + v, q32))
    if s.check() == sat:
        m = s.model()
        fail(f"modadd wrong at u={m[u]},v={m[v]}")

    sub = u + (q32 - v)
    sub = If(UGE(sub, q32), sub - q32, sub)
    exp = If(UGE(u, v), u - v, u - v + q32)
    s = Solver()
    s.add(bounds)
    s.add(sub != exp)
    if s.check() == sat:
        m = s.model()
        fail(f"modsub wrong at u={m[u]},v={m[v]}")


# ===========================================================================
# 5. property tests for the NTT-scale logic
# ===========================================================================
def test_radix4():
    rnd = random.Random(1)
    for _ in range(4000):
        xs = [rnd.randrange(Q) for _ in range(4)]
        w = rnd.randrange(Q)
        got = radix4_bf(*xs, w)
        exp = radix4_ref(*xs, w)
        if got != exp:
            fail(f"radix-4 butterfly mismatch xs={xs} w={w}: {got} != {exp}")


def test_butterfly2():
    rnd = random.Random(2)
    for _ in range(4000):
        x0 = rnd.randrange(Q)
        x1 = rnd.randrange(Q)
        w = rnd.randrange(Q)
        got = radix2_bf(x0, x1, w)
        exp = ((x0 + (w * x1)) % Q, (x0 - (w * x1)) % Q)
        if got != exp:
            fail(f"radix-2 butterfly mismatch x0={x0} x1={x1} w={w}: {got} != {exp}")


def test_ntt_pipeline():
    rnd = random.Random(3)

    # identity: INTT(NTT(a)) == a  (spec property)
    for _ in range(3):
        a = [rnd.randrange(Q) for _ in range(N)]
        if intt(ntt(a)) != a:
            fail("INTT(NTT(a)) != a (forward/inverse not identity)")

    # NTT-based multiply == schoolbook negacyclic convolution
    def one(a, b, tag):
        if ntt_mul(a, b) != negaconv_ref(a, b):
            got = ntt_mul(a, b)
            ref = negaconv_ref(a, b)
            idx = next(i for i in range(N) if got[i] != ref[i])
            fail(f"ntt_mul != negacyclic conv ({tag}) at index {idx}: "
                 f"{got[idx]} != {ref[idx]}")

    # impulse: a*delta == a
    delta = [1] + [0] * (N - 1)
    base = [rnd.randrange(Q) for _ in range(N)]
    one(base, delta, "impulse")

    # x^(N-1) shift (negacyclic sign flip) edge case
    shift = [0] * (N - 1) + [1]
    one(base, shift, "x^{N-1} shift")

    # random full-size products
    for k in range(4):
        a = [rnd.randrange(Q) for _ in range(N)]
        b = [rnd.randrange(Q) for _ in range(N)]
        one(a, b, f"random#{k}")


def test_bank_balance():
    # the map must at least be balanced (each of 8 banks holds N/8 coeffs)
    counts = [0] * 8
    seen = {}
    for i in range(N):
        counts[bank(i)] += 1
        seen.setdefault(bank(i), set()).add(offset(i))
    if any(c != N // 8 for c in counts):
        fail(f"bank map not balanced: {counts}")
    # within a bank, offsets must be unique (addressable without collision)
    for b, offs in seen.items():
        if len(offs) != N // 8:
            fail(f"bank {b} has colliding offsets")


# ===========================================================================
# main
# ===========================================================================
def main():
    check_constants()
    prove_bitbounded()
    test_butterfly2()
    test_radix4()
    test_bank_balance()
    test_ntt_pipeline()
    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
