#!/usr/bin/env python3
"""
Reverse-implementation of the CFNTT Radix-2/4 NTT Multiplication Accelerator,
built from the scene spec alone, with an independent golden model and self-checks.

Verified properties (all gate VERIFIED):
  1. Parameter consistency (psi order, omega, j, N^-1).
  2. Barrett reduction == true modulo, proven over ALL inputs in [0,(q-1)^2] (z3).
  3. modmul (Barrett-based) == (a*b) % q on random inputs.
  4. Radix-4 fused butterfly == two composed radix-2 stages (the headline fusion).
  5. INTT(NTT(a)) == a   (round-trip identity, no explicit bit-reversal pass).
  6. INTT(NTT(a) (.) NTT(b)) == schoolbook negacyclic convolution a*b mod (x^N+1)
     -- a fully independent golden for the accelerator's actual purpose.
  7. Conflict-free address map i -> (bank(i), offset(i)) is injective.
"""
import sys
import random

# ---------------------------------------------------------------- parameters
q      = 12289          # 14-bit NTT-friendly prime (3*2^12 + 1)   [guessed]
N      = 1024           # transform length
LOGN   = 10
PSI    = 1945           # 2N-th primitive root (negacyclic)        [guessed]
OMEGA  = 10302          # psi^2, N-th root
N_INV  = 12277          # 1024^-1 mod q
J      = pow(PSI, 512, q)   # constant 4th-root rotator (j^2 == -1)
MU     = 21843          # floor(2^28 / q)  Barrett quotient const  [guessed]
KSH    = 28             # Barrett shift                            [guessed]


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


# ----------------------------------------------- modular reduction datapath
def barrett_reduce(x):
    """mod_red_mult (t = (x*mu)>>k) then mod_red_subshift (r = x - t*q, <=2 corr)."""
    t = (x * MU) >> KSH
    r = x - t * q
    if r >= q:
        r -= q
    if r >= q:
        r -= q
    return r


def modmul(a, b):
    return barrett_reduce(a * b)


def modadd(a, b):
    r = a + b
    return r - q if r >= q else r


def modsub(a, b):
    r = a - b
    return r + q if r < 0 else r


# --------------------------------------------------------- butterfly units
def radix2_butterfly(x0, x1, w):
    """Cooley-Tukey: v = w*x1; (x0+v, x0-v) mod q."""
    v = modmul(w, x1)
    return modadd(x0, v), modsub(x0, v)


def radix4_butterfly(x0, x1, x2, x3, w):
    """Fused 4-input BU (spec eqns), 3 twiddle mults W1=w,W2=w^2,W3=w^3 + j-rotator."""
    w2 = modmul(w, w)
    w3 = modmul(w2, w)
    b = modmul(w,  x1)
    c = modmul(w2, x2)
    d = modmul(w3, x3)
    jb = modmul(J, b)
    jd = modmul(J, d)
    y0 = modadd(modadd(x0, b), modadd(c, d))          # x0+b+c+d
    y1 = modsub(modsub(modadd(x0, jb), c), jd)        # x0+j*b-c-j*d
    y2 = modsub(modadd(modsub(x0, b), c), d)          # x0-b+c-d
    y3 = modadd(modsub(modsub(x0, jb), c), jd)        # x0-j*b-c+j*d
    return y0, y1, y2, y3


# --------------------------------------------- conflict-free address mapping
def bank(i):
    return (i + (i >> 3)) % 8


def offset(i):
    return i >> 3


# ----------------------------------------------------- negacyclic NTT / INTT
def _bitrev(i, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (i & 1)
        i >>= 1
    return r


PSI_INV     = pow(PSI, q - 2, q)
PSI_REV     = [pow(PSI,     _bitrev(i, LOGN), q) for i in range(N)]
PSI_INV_REV = [pow(PSI_INV, _bitrev(i, LOGN), q) for i in range(N)]


def ntt(a):
    """Forward negacyclic NTT (CT), natural input -> bit-reversed-order output."""
    a = list(a)
    t = N
    m = 1
    while m < N:
        t //= 2
        for i in range(m):
            j1 = 2 * i * t
            S = PSI_REV[m + i]
            for jj in range(j1, j1 + t):
                U = a[jj]
                V = modmul(a[jj + t], S)
                a[jj]     = modadd(U, V)
                a[jj + t] = modsub(U, V)
        m *= 2
    return a


def intt(a):
    """Inverse negacyclic NTT (GS), bit-reversed-order input -> natural output."""
    a = list(a)
    t = 1
    m = N
    while m > 1:
        j1 = 0
        h = m // 2
        for i in range(h):
            S = PSI_INV_REV[h + i]
            for jj in range(j1, j1 + t):
                U = a[jj]
                V = a[jj + t]
                a[jj]     = modadd(U, V)
                a[jj + t] = modmul(modsub(U, V), S)
            j1 += 2 * t
        t *= 2
        m = h
    return [modmul(x, N_INV) for x in a]


# ===================================================== INDEPENDENT GOLDENS
def golden_negacyclic_conv(a, b):
    """Schoolbook multiply in Z_q[x]/(x^N+1) -- the accelerator's real purpose."""
    c = [0] * N
    for i in range(N):
        ai = a[i]
        if ai == 0:
            continue
        for jx in range(N):
            prod = (ai * b[jx]) % q
            k = i + jx
            if k < N:
                c[k] = (c[k] + prod) % q
            else:
                c[k - N] = (c[k - N] - prod) % q
    return [x % q for x in c]


def golden_radix4_via_two_radix2(x0, x1, x2, x3, w):
    """Independent ref: a length-4 stage as two composed radix-2 stages."""
    w2 = (w * w) % q
    w3 = (w2 * w) % q
    t0, t1, t2, t3 = x0, (w * x1) % q, (w2 * x2) % q, (w3 * x3) % q
    e0, e1 = (t0 + t2) % q, (t0 - t2) % q
    o0, o1 = (t1 + t3) % q, (t1 - t3) % q
    Y0 = (e0 + o0) % q
    Y2 = (e0 - o0) % q
    Y1 = (e1 + J * o1) % q
    Y3 = (e1 - J * o1) % q
    return Y0 % q, Y1 % q, Y2 % q, Y3 % q


# ===================================================== VERIFICATION HARNESS
def check_parameters():
    if pow(PSI, 2048, q) != 1:
        fail("psi^2048 != 1 (psi=%d not order-2048)" % PSI)
    if pow(PSI, 1024, q) != q - 1:
        fail("psi^1024 != -1 (not negacyclic): got %d" % pow(PSI, 1024, q))
    if OMEGA != pow(PSI, 2, q):
        fail("omega != psi^2: %d vs %d" % (OMEGA, pow(PSI, 2, q)))
    if pow(J, 2, q) != q - 1:
        fail("j^2 != -1: got %d" % pow(J, 2, q))
    if (N * N_INV) % q != 1:
        fail("N*N_inv != 1 mod q: got %d" % ((N * N_INV) % q))
    if MU != (1 << KSH) // q:
        fail("mu != floor(2^k/q): %d vs %d" % (MU, (1 << KSH) // q))


def prove_barrett():
    """Prove barrett_reduce(x) == x % q for ALL x in [0,(q-1)^2] using z3."""
    bound = (q - 1) * (q - 1)
    try:
        from z3 import BitVec, LShR, URem, UGE, ULE, If, Solver, unsat
    except ImportError:
        # Fallback: dense boundary + random sampling (not a proof).
        rng = random.Random(1)
        samples = set()
        for a in range(q):
            samples.add(a * (q - 1))
            samples.add(a * a)
        for _ in range(200000):
            samples.add(rng.randint(0, bound))
        samples |= {0, 1, q - 1, q, q + 1, bound, bound - 1}
        for x in samples:
            if barrett_reduce(x) != x % q:
                fail("Barrett mismatch at x=%d: got %d want %d (z3 unavailable)"
                     % (x, barrett_reduce(x), x % q))
        return
    W = 48
    x = BitVec('x', W)
    t = LShR(x * MU, KSH)
    r = x - t * q
    r1 = If(UGE(r, q), r - q, r)
    r2 = If(UGE(r1, q), r1 - q, r1)
    s = Solver()
    s.add(ULE(x, bound))
    s.add(r2 != URem(x, q))
    res = s.check()
    if res != unsat:
        cx = s.model()[x]
        fail("Barrett NOT equivalent to mod: counterexample x=%s" % cx)


def check_modmul():
    rng = random.Random(2)
    for _ in range(2000):
        a = rng.randrange(q)
        b = rng.randrange(q)
        if modmul(a, b) != (a * b) % q:
            fail("modmul(%d,%d)=%d != %d" % (a, b, modmul(a, b), (a * b) % q))


def check_radix4_fusion():
    rng = random.Random(3)
    for _ in range(2000):
        x0, x1, x2, x3 = (rng.randrange(q) for _ in range(4))
        w = rng.randrange(q)
        got = radix4_butterfly(x0, x1, x2, x3, w)
        want = golden_radix4_via_two_radix2(x0, x1, x2, x3, w)
        if got != want:
            fail("radix4 != two radix2 for x=(%d,%d,%d,%d) w=%d: %s vs %s"
                 % (x0, x1, x2, x3, w, got, want))


def check_roundtrip():
    rng = random.Random(4)
    for _ in range(8):
        a = [rng.randrange(q) for _ in range(N)]
        if intt(ntt(a)) != a:
            # locate first diff for a concrete counterexample
            r = intt(ntt(a))
            for i in range(N):
                if r[i] != a[i]:
                    fail("INTT(NTT(a)) != a at index %d: %d vs %d"
                         % (i, r[i], a[i]))
            fail("INTT(NTT(a)) != a (length mismatch)")


def check_polymul():
    rng = random.Random(5)
    cases = []
    for _ in range(2):
        cases.append(([rng.randrange(q) for _ in range(N)],
                      [rng.randrange(q) for _ in range(N)]))
    # structured edge: a = x (shift), b = x^(N-1)  ->  a*b = -1 (negacyclic wrap)
    a = [0] * N; a[1] = 1
    b = [0] * N; b[N - 1] = 1
    cases.append((a, b))
    for a, b in cases:
        A = ntt(a)
        B = ntt(b)
        C = [modmul(A[i], B[i]) for i in range(N)]
        got = intt(C)
        want = golden_negacyclic_conv(a, b)
        if got != want:
            for i in range(N):
                if got[i] != want[i]:
                    fail("poly-mult mismatch at coeff %d: got %d want %d"
                         % (i, got[i], want[i]))
            fail("poly-mult length mismatch")
    # explicit check of the structured wrap case
    aw = golden_negacyclic_conv(a, b)
    if aw[0] != q - 1 or any(aw[i] != 0 for i in range(1, N)):
        fail("negacyclic wrap wrong: x*x^(N-1) should be -1, got %s..." % aw[:3])


def check_address_map():
    seen = set()
    for i in range(N):
        bk, off = bank(i), offset(i)
        if not (0 <= bk < 8):
            fail("bank(%d)=%d out of range" % (i, bk))
        if not (0 <= off < 256):
            fail("offset(%d)=%d out of range" % (i, off))
        cell = (bk, off)
        if cell in seen:
            fail("address map NOT injective: collision at i=%d -> %s" % (i, cell))
        seen.add(cell)


def main():
    check_parameters()
    prove_barrett()
    check_modmul()
    check_radix4_fusion()
    check_roundtrip()
    check_polymul()
    check_address_map()
    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
