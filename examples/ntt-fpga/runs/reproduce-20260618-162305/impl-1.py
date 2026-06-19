#!/usr/bin/env python3
"""
Reverse-implementation of the CFNTT Radix-2/4 NTT Multiplication Accelerator
from its scene spec alone.

What the spec authoritatively pins down and what we implement here:
  - N = 1024, 8 parallel butterfly units, scalable radix 2/4
  - 14-bit coefficients, a 14-bit NTT-friendly prime modulus q  (q EXACT value
    NOT given -> we GUESS q = 12289, the canonical one)
  - Barrett modular reduction: "q-multiply then shift/subtract + correct"
  - Symmetric butterfly: one product feeds a shared modular adder & subtractor
  - Twiddle-factor reuse / broadcast (a scheduling detail; numerically inert)
  - Conflict-free, no-bit-reversal memory mapping (an addressing detail;
    numerically inert -> output is natural-order)
  - "NTT followed by INTT (with N^-1 scaling) is the identity"

Verification strategy:
  * z3 PROVES, over ALL inputs in range, that the hardware Barrett path equals
    x mod q, and that the modular adder/subtractor equal (a+-b) mod q.  These
    three proofs validate the entire modular ALU (the modular multiplier is
    Barrett(a*b)).
  * The NTT/INTT datapath is then checked against an INDEPENDENT O(N^2)
    DFT-by-definition golden, against the cyclic-convolution definition for the
    polynomial multiplier, and the INTT(NTT(x)) == x identity is checked --
    over random + structured edge vectors with a fixed seed.
  * A recursive radix-4 transform is checked to agree with both the radix-2
    transform and the naive golden (validating the radix-2/4 scalability claim).

Prints exactly "VERIFIED" and exits 0 on success; otherwise "FAIL: ...".
Only stdlib + z3 are used.
"""

import sys
import random

# --------------------------------------------------------------------------
# Parameters (q is a GUESS: canonical 14-bit NTT-friendly prime, q = 12*1024+1)
# --------------------------------------------------------------------------
Q = 12289               # 14-bit prime, q - 1 = 12288 = 2^12 * 3, q congruent 1 mod 2N
NBITS = 14              # coefficient width (authoritative)
K = 2 * NBITS           # Barrett shift = 28 (GUESS)
MU = (1 << K) // Q      # Barrett constant mu = floor(2^K / q) (GUESS)


# --------------------------------------------------------------------------
# Hardware modular ALU  (the "implementation")
# --------------------------------------------------------------------------
def barrett(x):
    """Barrett reduction: q-multiply (mu), shift right K, subtract q*qhat, correct.
    Correct for all 0 <= x < q^2."""
    qhat = (x * MU) >> K
    r = x - qhat * Q
    if r >= Q:          # correction (at most 2 needed; 1 actually suffices here)
        r -= Q
    if r >= Q:
        r -= Q
    return r


def modmul(a, b):
    """DSP modular multiplier: full product then Barrett reduction."""
    return barrett(a * b)


def modadd(a, b):
    """Symmetric adder: sum then a single conditional -q (the 'sum path')."""
    s = a + b
    return s - Q if s >= Q else s


def modsub(a, b):
    """Symmetric subtractor sharing operands with the adder ('difference path')."""
    d = a - b
    return d + Q if d < 0 else d


def butterfly(a, b, t):
    """Symmetric radix-2 butterfly: one product p = t*b shared by add & sub."""
    p = modmul(t, b)
    return modadd(a, p), modsub(a, p)


# --------------------------------------------------------------------------
# Roots of unity (GUESS: derived from a primitive root of GF(q))
# --------------------------------------------------------------------------
def factorize(m):
    f = set()
    d = 2
    while d * d <= m:
        while m % d == 0:
            f.add(d)
            m //= d
        d += 1
    if m > 1:
        f.add(m)
    return f


def find_generator(q):
    phi = q - 1
    fs = factorize(phi)
    for g in range(2, q):
        if all(pow(g, phi // f, q) != 1 for f in fs):
            return g
    raise RuntimeError("no generator")


G = find_generator(Q)


def root(n):
    """Primitive n-th root of unity mod q (n must divide q-1)."""
    if (Q - 1) % n != 0:
        raise ValueError("n does not divide q-1")
    return pow(G, (Q - 1) // n, Q)


# --------------------------------------------------------------------------
# Datapath: radix-2 NTT (DIT), radix-4 NTT (recursive split), INTT
# --------------------------------------------------------------------------
def ntt_radix2(a, w):
    """Iterative radix-2 DIT NTT through the hardware ALU.
    Bit-reversed input / natural-order output -> X[k] = sum_t a[t] * w^(t*k)."""
    a = a[:]
    n = len(a)
    # bit-reversal permutation
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    length = 2
    while length <= n:
        wlen = pow(w, n // length, Q)
        half = length // 2
        for i in range(0, n, length):
            wj = 1
            for k in range(half):
                u = a[i + k]
                top, bot = butterfly(u, a[i + k + half], wj)
                a[i + k] = top
                a[i + k + half] = bot
                wj = modmul(wj, wlen)
        length <<= 1
    return a


def ntt_radix4(x, w):
    """Recursive radix-4 NTT (n must be a power of 4): splits into 4 phases,
    independent of the radix-2 routine -> cross-check of the scalable datapath."""
    n = len(x)
    if n == 1:
        return [x[0] % Q]
    sub = [ntt_radix4(x[r::4], pow(w, 4, Q)) for r in range(4)]
    wpow = [pow(w, i, Q) for i in range(n)]
    m = n // 4
    X = [0] * n
    for k in range(n):
        kk = k % m
        acc = 0
        for r in range(4):
            acc = modadd(acc, modmul(wpow[(r * k) % n], sub[r][kk]))
        X[k] = acc
    return X


def intt_radix2(a, w):
    """Inverse NTT on the same array: omega^-1 then * N^-1 mod q (N^-1 scaling unit)."""
    n = len(a)
    winv = pow(w, Q - 2, Q)
    y = ntt_radix2(a, winv)
    ninv = pow(n, Q - 2, Q)
    return [modmul(v, ninv) for v in y]


def poly_mul_ntt(a, b):
    """Polynomial multiplication (cyclic, mod x^N - 1) via the NTT engine."""
    n = len(a)
    w = root(n)
    A = ntt_radix2(a, w)
    B = ntt_radix2(b, w)
    C = [modmul(A[i], B[i]) for i in range(n)]
    return intt_radix2(C, w)


# --------------------------------------------------------------------------
# Independent golden models
# --------------------------------------------------------------------------
def dft_naive(x, w):
    """O(N^2) DFT by definition: X[k] = sum_t x[t] * w^(t*k) mod q."""
    n = len(x)
    wpow = [pow(w, i, Q) for i in range(n)]
    X = [0] * n
    for k in range(n):
        s = 0
        for t in range(n):
            s += x[t] * wpow[(t * k) % n]
        X[k] = s % Q
    return X


def conv_cyclic_naive(a, b):
    """O(N^2) cyclic convolution mod q -> golden for the polynomial multiplier."""
    n = len(a)
    c = [0] * n
    for i in range(n):
        ai = a[i]
        if ai == 0:
            continue
        for j in range(n):
            c[(i + j) % n] = (c[(i + j) % n] + ai * b[j]) % Q
    return c


# --------------------------------------------------------------------------
# z3 proofs (exhaustive over the full input domain)
# --------------------------------------------------------------------------
def z3_proofs():
    from z3 import (BitVec, BitVecVal, URem, LShR, UGE, ULT, If, Solver, unsat)

    # Barrett == x mod q for all 0 <= x < q^2
    x = BitVec('x', 64)
    mu = BitVecVal(MU, 64)
    q = BitVecVal(Q, 64)
    qhat = LShR(x * mu, K)
    r = x - qhat * q
    r = If(UGE(r, q), r - q, r)
    r = If(UGE(r, q), r - q, r)
    s = Solver()
    s.add(ULT(x, BitVecVal(Q * Q, 64)))
    s.add(r != URem(x, q))
    if s.check() != unsat:
        return "Barrett reduction wrong, counterexample x = %s" % s.model()[x]

    # modular adder == (a+b) mod q for all a,b in [0,q)
    a = BitVec('a', 32)
    b = BitVec('b', 32)
    q32 = BitVecVal(Q, 32)
    radd = If(UGE(a + b, q32), a + b - q32, a + b)
    s = Solver()
    s.add(ULT(a, q32), ULT(b, q32))
    s.add(radd != URem(a + b, q32))
    if s.check() != unsat:
        m = s.model()
        return "modadd wrong, a=%s b=%s" % (m[a], m[b])

    # modular subtractor == (a-b) mod q for all a,b in [0,q)
    rsub = If(ULT(a, b), a + q32 - b, a - b)
    golden = URem(a + q32 - b, q32)
    s = Solver()
    s.add(ULT(a, q32), ULT(b, q32))
    s.add(rsub != golden)
    if s.check() != unsat:
        m = s.model()
        return "modsub wrong, a=%s b=%s" % (m[a], m[b])

    return None


# --------------------------------------------------------------------------
# Property / equivalence checks
# --------------------------------------------------------------------------
def first_diff(u, v):
    for i in range(len(u)):
        if u[i] != v[i]:
            return i
    return -1


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


def edge_vectors(n):
    return [
        [0] * n,
        [1] * n,
        [Q - 1] * n,
        [1] + [0] * (n - 1),
        [0] * (n - 1) + [1],
        [(i * 7 + 3) % Q for i in range(n)],
    ]


def main():
    rng = random.Random(20260618)

    # 1) Exhaustive z3 proofs of the modular ALU
    err = z3_proofs()
    if err:
        fail(err)

    # 2) Root sanity: omega must have exact order n
    for n in (2, 4, 8, 16, 64, 256, 1024):
        w = root(n)
        if pow(w, n, Q) != 1 or pow(w, n // 2, Q) == 1:
            fail("root of unity for n=%d has wrong order" % n)

    # 3) radix-2 NTT == naive DFT, and INTT(NTT)=identity, on small/medium n
    for n in (2, 4, 8, 16, 32, 64, 128, 256):
        w = root(n)
        vecs = edge_vectors(n) + [[rng.randrange(Q) for _ in range(n)]
                                  for _ in range(3)]
        for v in vecs:
            got = ntt_radix2(v, w)
            ref = dft_naive(v, w)
            d = first_diff(got, ref)
            if d != -1:
                fail("radix-2 NTT != DFT at n=%d idx=%d got=%d exp=%d"
                     % (n, d, got[d], ref[d]))
            back = intt_radix2(got, w)
            d = first_diff(back, v)
            if d != -1:
                fail("INTT(NTT(x)) != x at n=%d idx=%d got=%d exp=%d"
                     % (n, d, back[d], v[d]))

    # 4) radix-4 NTT == naive DFT on powers of 4
    for n in (4, 16, 64, 256, 1024):
        w = root(n)
        vecs = edge_vectors(n) + [[rng.randrange(Q) for _ in range(n)]]
        for v in vecs:
            got = ntt_radix4(v, w)
            ref = dft_naive(v, w)
            d = first_diff(got, ref)
            if d != -1:
                fail("radix-4 NTT != DFT at n=%d idx=%d got=%d exp=%d"
                     % (n, d, got[d], ref[d]))

    # 5) Large-N (N=1024) radix-2 vs golden + radix-2 vs radix-4 + identity
    n = 1024
    w = root(n)
    v = [rng.randrange(Q) for _ in range(n)]
    r2 = ntt_radix2(v, w)
    ref = dft_naive(v, w)
    d = first_diff(r2, ref)
    if d != -1:
        fail("N=1024 radix-2 NTT != DFT at idx=%d got=%d exp=%d"
             % (d, r2[d], ref[d]))
    r4 = ntt_radix4(v, w)
    d = first_diff(r4, r2)
    if d != -1:
        fail("N=1024 radix-2 != radix-4 at idx=%d r2=%d r4=%d"
             % (d, r2[d], r4[d]))
    back = intt_radix2(r2, w)
    d = first_diff(back, v)
    if d != -1:
        fail("N=1024 INTT(NTT(x)) != x at idx=%d got=%d exp=%d"
             % (d, back[d], v[d]))

    # 6) Polynomial multiplier == cyclic convolution golden
    for n in (16, 64, 256):
        for _ in range(3):
            a = [rng.randrange(Q) for _ in range(n)]
            b = [rng.randrange(Q) for _ in range(n)]
            got = poly_mul_ntt(a, b)
            ref = conv_cyclic_naive(a, b)
            d = first_diff(got, ref)
            if d != -1:
                fail("poly-mul != conv at n=%d idx=%d got=%d exp=%d"
                     % (n, d, got[d], ref[d]))

    # 7) Symmetric butterfly: one shared product feeds add & sub
    for _ in range(20000):
        a = rng.randrange(Q)
        b = rng.randrange(Q)
        t = rng.randrange(Q)
        top, bot = butterfly(a, b, t)
        p = (t * b) % Q
        if top != (a + p) % Q or bot != (a - p) % Q:
            fail("butterfly wrong for a=%d b=%d t=%d" % (a, b, t))

    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
