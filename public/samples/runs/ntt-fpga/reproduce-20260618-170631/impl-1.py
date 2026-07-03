#!/usr/bin/env python3
"""
CFNTT Radix-2/4 NTT Multiplication Accelerator — reverse-implemented from spec.

Functional model (from spec): a negacyclic NTT/INTT polynomial-multiplication
engine for q=12289, N=1024, 14-bit coefficients, with:
  - Barrett modular reduction (mu=21843, k=28, <=2 corrections)
  - radix-2 butterfly  : u=x0, v=w*x1 -> (u+v, u-v) mod q
  - radix-4 butterfly  : b'=W1 x1, c'=W2 x2, d'=W3 x3, j=psi^512:
       y0=x0+b'+c'+d', y1=x0+j b'-c'-j d', y2=x0-b'+c'-d', y3=x0-j b'-c'+j d'
  - conflict-free 8-bank mapping b(i)=(i+(i>>3))%8, o(i)=i>>3
  - INTT = NTT(omega^-1) then * N^-1 ; NTT∘INTT = identity

Self-checks (independent golden models):
  * z3 proves the Barrett unit == true (x mod q) over the whole product domain.
  * recursive radix-2 NTT == O(N^2) direct DFT.
  * recursive radix-4 NTT == radix-2 NTT (the scalable-radix claim).
  * negacyclic NTT-multiply == schoolbook negacyclic convolution.
  * NTT then INTT == identity.
  * bank mapping is conflict-free (8-block permutation) and injective.
Prints VERIFIED / exit 0, or FAIL: <reason+counterexample> / exit 1.
"""

import random
import sys

# ---------------------------------------------------------------------------
# Parameters (authoritative spec values; reproduction-chosen ones flagged above)
# ---------------------------------------------------------------------------
q       = 12289            # modulus (spec: q=12289=3*2^12+1)
N       = 1024             # transform length
G       = 11               # generator
PSI     = pow(G, 6, q)     # 2N-th root  -> 1945
OMEGA   = (PSI * PSI) % q  # N-th root    -> 10302
J       = pow(PSI, 512, q) # order-4 rotator (j^2 = -1)
N_INV   = pow(N, q - 2, q) # 1024^-1 mod q -> 8857
PSI_INV = pow(PSI, q - 2, q)
OMEGA_INV = pow(OMEGA, q - 2, q)
MU      = 21843            # floor(2^28 / q)
KSHIFT  = 28


def die(msg):
    print("FAIL: " + msg)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Parameter sanity (catches an inconsistent spec immediately)
# ---------------------------------------------------------------------------
def check_params():
    if PSI != 1945:        die(f"psi expected 1945, got {PSI}")
    if OMEGA != 10302:     die(f"omega expected 10302, got {OMEGA}")
    if N_INV != 8857:      die(f"N^-1 expected 8857, got {N_INV}")
    if MU != (1 << KSHIFT) // q: die(f"mu != floor(2^28/q)")
    if pow(PSI, 2 * N, q) != 1:        die("psi^2048 != 1")
    if pow(PSI, N, q) != q - 1:        die("psi^1024 != -1 (not negacyclic)")
    if pow(OMEGA, N, q) != 1:          die("omega^1024 != 1")
    if (J * J) % q != q - 1:           die("j^2 != -1")
    if (N * N_INV) % q != 1:           die("N * N^-1 != 1")
    if pow(OMEGA, N // 4, q) != J:     die("omega^(N/4) != j")


# ---------------------------------------------------------------------------
# Barrett modular reduction unit (mod_red_mult + mod_red_subshift)
# ---------------------------------------------------------------------------
def barrett_reduce(x):
    """x in [0, (q-1)^2]; returns x mod q via Barrett with <=2 corrections."""
    t = (x * MU) >> KSHIFT          # quotient estimate (mod_red_mult)
    r = x - t * q                   # shift/subtract (mod_red_subshift)
    if r >= q:                      # correction 1
        r -= q
    if r >= q:                      # correction 2
        r -= q
    return r


def modmul(a, b):
    # a, b are both < q, so the product is in the proven Barrett domain.
    return barrett_reduce(a * b)


def modadd(a, b):
    s = a + b
    return s - q if s >= q else s


def modsub(a, b):
    d = a - b
    return d + q if d < 0 else d


# ---------------------------------------------------------------------------
# Butterfly units
# ---------------------------------------------------------------------------
def radix2_butterfly(u, x1, w):
    v = modmul(w, x1)
    return modadd(u, v), modsub(u, v)


def radix4_butterfly(x0, t1, t2, t3, jj):
    # t1=W1*x1, t2=W2*x2, t3=W3*x3 already twiddled; jj = w^(n/4)
    jb = modmul(jj, t1)
    jd = modmul(jj, t3)
    y0 = (x0 + t1 + t2 + t3) % q
    y1 = (x0 + jb - t2 - jd) % q
    y2 = (x0 - t1 + t2 - t3) % q
    y3 = (x0 - jb - t2 + jd) % q
    return y0, y1, y2, y3


# ---------------------------------------------------------------------------
# Transforms (architecture model)
# ---------------------------------------------------------------------------
def ntt_radix2(x, w):
    """Cyclic NTT: X_k = sum_n x_n w^{nk} mod q, natural order, no bit-reversal."""
    n = len(x)
    if n == 1:
        return x[:]
    w2 = modmul(w, w)
    E = ntt_radix2(x[0::2], w2)
    O = ntt_radix2(x[1::2], w2)
    half = n // 2
    X = [0] * n
    wk = 1
    for k in range(half):
        a, b = radix2_butterfly(E[k], O[k], wk)
        X[k] = a
        X[k + half] = b
        wk = modmul(wk, w)
    return X


def ntt_radix4(x, w):
    """Same cyclic NTT computed with the radix-4 fused butterfly."""
    n = len(x)
    if n == 1:
        return x[:]
    if n % 4 != 0:                      # safety; never hit for N=4^5
        return ntt_radix2(x, w)
    w4 = modmul(modmul(w, w), modmul(w, w))
    A0 = ntt_radix4(x[0::4], w4)
    A1 = ntt_radix4(x[1::4], w4)
    A2 = ntt_radix4(x[2::4], w4)
    A3 = ntt_radix4(x[3::4], w4)
    quarter = n // 4
    jj = pow(w, n // 4, q)              # order-4 rotator for this level
    X = [0] * n
    wk = 1
    for k in range(quarter):
        wk2 = modmul(wk, wk)
        wk3 = modmul(wk2, wk)
        t1 = modmul(wk, A1[k])          # W1*x1
        t2 = modmul(wk2, A2[k])         # W2*x2
        t3 = modmul(wk3, A3[k])         # W3*x3
        y0, y1, y2, y3 = radix4_butterfly(A0[k], t1, t2, t3, jj)
        X[k] = y0
        X[k + quarter] = y1
        X[k + 2 * quarter] = y2
        X[k + 3 * quarter] = y3
        wk = modmul(wk, w)
    return X


def intt_radix2(X):
    y = ntt_radix2(X, OMEGA_INV)
    return [modmul(N_INV, v) for v in y]


# negacyclic pre/post twist tables (twiddle ROM low/high halves)
PSI_POW     = [pow(PSI, i, q) for i in range(N)]
PSI_INV_POW = [pow(PSI_INV, i, q) for i in range(N)]


def negacyclic_mul(a, b):
    """c = a * b mod (x^N + 1), via psi-twisted cyclic NTT."""
    at = [modmul(a[i], PSI_POW[i]) for i in range(N)]
    bt = [modmul(b[i], PSI_POW[i]) for i in range(N)]
    A = ntt_radix2(at, OMEGA)
    B = ntt_radix2(bt, OMEGA)
    C = [modmul(A[i], B[i]) for i in range(N)]
    ct = intt_radix2(C)
    return [modmul(ct[i], PSI_INV_POW[i]) for i in range(N)]


# ---------------------------------------------------------------------------
# Conflict-free memory mapping (addr_gen_unit / crossbar)
# ---------------------------------------------------------------------------
def bank_index(i):
    return (i + (i >> 3)) % 8


def offset(i):
    return i >> 3


# ---------------------------------------------------------------------------
# Independent golden models
# ---------------------------------------------------------------------------
def direct_dft(x, w):
    n = len(x)
    wp = [pow(w, e, q) for e in range(n)]
    X = [0] * n
    for k in range(n):
        acc = 0
        for nn in range(n):
            acc += x[nn] * wp[(nn * k) % n]
        X[k] = acc % q
    return X


def golden_negacyclic_mul(a, b):
    c = [0] * N
    for i in range(N):
        ai = a[i]
        if ai == 0:
            continue
        for jx in range(N):
            k = i + jx
            p = ai * b[jx]
            if k < N:
                c[k] += p
            else:
                c[k - N] -= p
    return [v % q for v in c]


# ---------------------------------------------------------------------------
# z3 proof: Barrett unit == true modulo over the full operand-product domain
# ---------------------------------------------------------------------------
def prove_barrett():
    from z3 import (BitVec, BitVecVal, LShR, URem, UGE, ULE, If, Solver, unsat)
    x = BitVec('x', 64)
    Qv = BitVecVal(q, 64)
    Mv = BitVecVal(MU, 64)
    t = LShR(x * Mv, KSHIFT)
    r = x - t * Qv
    r = If(UGE(r, Qv), r - Qv, r)
    r = If(UGE(r, Qv), r - Qv, r)
    s = Solver()
    s.add(ULE(x, (q - 1) * (q - 1)))   # actual butterfly-product domain
    s.add(r != URem(x, Qv))
    res = s.check()
    if res == unsat:
        return
    m = s.model()
    cx = m[x].as_long()
    die(f"Barrett != mod for x={cx}: barrett={barrett_reduce(cx)} mod={cx % q}")


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
def main():
    random.seed(12345)
    check_params()
    prove_barrett()

    # vectors: random, impulse, all-ones, ascending
    vecs = [
        [random.randrange(q) for _ in range(N)],
        [1] + [0] * (N - 1),
        [1] * N,
        [i % q for i in range(N)],
    ]

    # 1) radix-2 NTT == direct DFT  (check a subset of vectors for time budget)
    for v in (vecs[0], vecs[1], vecs[2]):
        fast = ntt_radix2(v, OMEGA)
        ref = direct_dft(v, OMEGA)
        if fast != ref:
            k = next(i for i in range(N) if fast[i] != ref[i])
            die(f"radix-2 NTT != DFT at k={k}: {fast[k]} vs {ref[k]}")

    # 2) radix-4 NTT == radix-2 NTT
    for v in vecs:
        r2 = ntt_radix2(v, OMEGA)
        r4 = ntt_radix4(v, OMEGA)
        if r2 != r4:
            k = next(i for i in range(N) if r2[i] != r4[i])
            die(f"radix-4 NTT != radix-2 at k={k}: {r4[k]} vs {r2[k]}")

    # 3) NTT then INTT == identity
    for v in vecs:
        rt = intt_radix2(ntt_radix2(v, OMEGA))
        rv = [c % q for c in v]
        if rt != rv:
            k = next(i for i in range(N) if rt[i] != rv[i])
            die(f"INTT(NTT(x)) != x at i={k}: {rt[k]} vs {rv[k]}")

    # 4) negacyclic NTT-multiply == schoolbook negacyclic convolution
    pairs = [
        ([random.randrange(q) for _ in range(N)],
         [random.randrange(q) for _ in range(N)]),
        ([0, 1] + [0] * (N - 2),                       # x  ->  shift w/ sign wrap
         [random.randrange(q) for _ in range(N)]),
    ]
    for a, b in pairs:
        got = negacyclic_mul(a, b)
        exp = golden_negacyclic_mul(a, b)
        if got != exp:
            k = next(i for i in range(N) if got[i] != exp[i])
            die(f"negacyclic mul mismatch at k={k}: {got[k]} vs {exp[k]}")

    # 5) conflict-free bank mapping: every 8-block is a permutation of 0..7,
    #    and (bank, offset) is a unique address per index.
    seen = set()
    for base in range(0, N, 8):
        banks = [bank_index(base + t) for t in range(8)]
        if sorted(banks) != list(range(8)):
            die(f"bank conflict in 8-block at base={base}: {banks}")
    for i in range(N):
        addr = (bank_index(i), offset(i))
        if addr in seen:
            die(f"bank/offset address collision at i={i}: {addr}")
        seen.add(addr)

    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
