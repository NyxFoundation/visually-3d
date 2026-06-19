#!/usr/bin/env python3
"""
CFNTT Radix-2/4 NTT Multiplication Accelerator -- reproduced from the scene spec
ALONE.  Single self-contained, self-checking Python program.

What is implemented (from the AUTHORITATIVE `spec` fields only):
  * Barrett modular reduction  (q=12289, mu=21843, k=28, <=2 corrections)
  * radix-2 butterfly          (Cooley-Tukey: u=x0, v=w*x1 -> u+v, u-v)
  * radix-4 fused butterfly    (3 twiddles W1,W2,W3 + constant j=psi^512 rotator)
  * negacyclic forward NTT      via iterative radix-2 butterflies + Barrett modmul
  * inverse NTT (INTT)          with N^-1 and psi^-i post-twist
  * the conflict-free crossbar / 8-bank BRAM system is NOT simulated (the spec's
    bank map is admitted-buggy); the transform is computed numerically instead.

Verification strategy (independent golden models):
  1. z3 PROOF that Barrett == (x mod q) for ALL x in [0, 2^28)        [exhaustive]
  2. radix-2 butterfly == 2-point DFT                                  [algebra]
  3. radix-4 butterfly == 4-point DFT with root j                      [algebra]
  4. radix-4 DFT(j) == composition of two radix-2 stages   (the "fusion" claim)
  5. iterative-radix-2 forward NTT == O(N^2) direct-definition golden  [random]
  6. INTT(NTT(a)) == a                                                 [identity]
  7. NTT-based negacyclic convolution == schoolbook mod (x^N + 1)      [conv thm]
  8. constant sanity: psi/omega/j/N^-1/mu orders & values

Prints "VERIFIED" + exit 0 on success, else "FAIL: <reason+counterexample>".
"""

import random
import sys

# ---- AUTHORITATIVE parameters (verbatim from the spec) ----------------------
N   = 1024            # transform length              (metadata.spec.params.N)
Q   = 12289           # modulus q                      (modulus_q)
PSI = 1945            # 2N=2048-th primitive root      (twiddle_rom: psi=g^6)
OMEGA = 10302         # N-th root = psi^2              (twiddle_rom: omega)
NINV = 12277          # N^-1 mod q                      (intt_scale)
J    = pow(PSI, 512, Q)   # constant rotator psi^512   (ex_jrot, j^2 == -1)
MU   = 21843          # Barrett mu = floor(2^28/q)      (mod_red_mult)
KSH  = 28             # Barrett shift k                 (mod_red_mult)
LOGN = N.bit_length() - 1   # = 10

def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)

# =============================================================================
# IMPLEMENTATION (the "DUT")
# =============================================================================

def barrett_reduce(x):
    """Barrett reduction per spec: t=(x*mu)>>k ; r=x-t*q ; <=2 corrections.
    Valid for 0 <= x < 2^28 (covers products of two sub-q operands, < q^2)."""
    t = (x * MU) >> KSH
    r = x - t * Q
    if r >= Q:
        r -= Q
    if r >= Q:
        r -= Q
    return r

def modmul(a, b):
    """Modular multiply through the Barrett datapath (a,b in [0,Q))."""
    return barrett_reduce(a * b)

def radix2_butterfly(x0, x1, w):
    """config_radix_selector.radix2_butterfly: u=x0, v=w*x1 -> (u+v, u-v) mod q."""
    u = x0 % Q
    v = modmul(w % Q, x1 % Q)
    return ((u + v) % Q, (u - v) % Q)

def radix4_butterfly(x0, x1, x2, x3, w):
    """config_radix_selector.radix4_butterfly (spec equations verbatim).
    b'=W1*x1, c'=W2*x2, d'=W3*x3 with W1=w, W2=w^2, W3=w^3; j=psi^512."""
    w1 = w % Q
    w2 = modmul(w1, w1)
    w3 = modmul(w2, w1)
    b = modmul(w1, x1 % Q)
    c = modmul(w2, x2 % Q)
    d = modmul(w3, x3 % Q)
    jb = modmul(J, b)
    jd = modmul(J, d)
    x0 = x0 % Q
    y0 = (x0 + b + c + d) % Q
    y1 = (x0 + jb - c - jd) % Q
    y2 = (x0 - b + c - d) % Q
    y3 = (x0 - jb - c + jd) % Q
    return (y0, y1, y2, y3)

def _bit_reverse_copy(a):
    n = len(a)
    bits = n.bit_length() - 1
    res = [0] * n
    for i in range(n):
        r = int('{:0{}b}'.format(i, bits)[::-1], 2)
        res[r] = a[i]
    return res

def ntt_cyclic(a, root):
    """Iterative Cooley-Tukey DIT NTT (bit-reversed input -> natural output).
    Returns X[k] = sum_i a[i] * root^(i*k) mod q.  `root` is an N-th root."""
    a = _bit_reverse_copy(a)
    n = len(a)
    m = 2
    while m <= n:
        wm = pow(root, n // m, Q)
        for k in range(0, n, m):
            w = 1
            half = m // 2
            for j in range(half):
                t = modmul(w, a[k + j + half])
                u = a[k + j]
                a[k + j] = (u + t) % Q
                a[k + j + half] = (u - t) % Q
                w = modmul(w, wm)
        m *= 2
    return a

def fwd_ntt(a):
    """Negacyclic forward NTT: pre-twist by psi^i, then length-N cyclic NTT."""
    ap = [modmul(a[i], pow(PSI, i, Q)) for i in range(N)]
    return ntt_cyclic(ap, OMEGA)

def inv_ntt(X):
    """Negacyclic INTT: cyclic inverse (omega^-1), then N^-1 and psi^-i post-twist."""
    om_inv = pow(OMEGA, Q - 2, Q)
    psi_inv = pow(PSI, Q - 2, Q)
    y = ntt_cyclic(X, om_inv)
    return [modmul(modmul(y[i], NINV), pow(psi_inv, i, Q)) for i in range(N)]

# =============================================================================
# GOLDEN / REFERENCE MODELS  (independent: use plain Python % everywhere)
# =============================================================================

# precomputed power tables (golden uses these, never Barrett)
_PSI = [pow(PSI, i, Q) for i in range(N)]
_OM  = [pow(OMEGA, i, Q) for i in range(N)]

def golden_fwd(a):
    """Direct O(N^2) definition: X[k] = sum_i a[i] psi^i omega^(ik) mod q."""
    out = []
    for k in range(N):
        acc = 0
        for i in range(N):
            ap = a[i] * _PSI[i] % Q
            acc += ap * _OM[(i * k) % N]
        out.append(acc % Q)
    return out

def golden_dft2(x0, x1, w):
    """2-point DFT: (x0 + w*x1, x0 - w*x1)."""
    v = w * x1 % Q
    return ((x0 + v) % Q, (x0 - v) % Q)

def golden_dft4_j(X0, X1, X2, X3):
    """4-point DFT with root j: Y[m] = sum_n X_n j^(mn) mod q."""
    jp = [pow(J, e, Q) for e in range(16)]
    Xs = [X0 % Q, X1 % Q, X2 % Q, X3 % Q]
    return tuple(sum(Xs[n] * jp[(m * n) % 4] for n in range(4)) % Q for m in range(4))

def golden_dft4_two_radix2(X0, X1, X2, X3):
    """DFT4 as a fusion of two radix-2 stages (proves the radix-4 fusion claim)."""
    G0 = (X0 + X2) % Q
    G1 = (X0 - X2) % Q
    H0 = (X1 + X3) % Q
    H1 = (X1 - X3) % Q
    jH1 = J * H1 % Q
    Y0 = (G0 + H0) % Q
    Y1 = (G1 + jH1) % Q
    Y2 = (G0 - H0) % Q
    Y3 = (G1 - jH1) % Q
    return (Y0, Y1, Y2, Y3)

def schoolbook_negacyclic(a, b):
    """Reference negacyclic product c = a*b mod (x^N + 1) over Z_q."""
    full = [0] * (2 * N - 1)
    for i in range(N):
        ai = a[i]
        if ai == 0:
            continue
        for j in range(N):
            full[i + j] += ai * b[j]
    c = [0] * N
    for n in range(N):
        hi = full[n + N] if (n + N) < len(full) else 0
        c[n] = (full[n] - hi) % Q
    return c

def first_diff(u, v):
    for i in range(len(u)):
        if u[i] != v[i]:
            return "index %d: impl=%d golden=%d" % (i, u[i], v[i])
    return "len %d vs %d" % (len(u), len(v))

# =============================================================================
# CHECKS
# =============================================================================

def check_constants():
    if J * J % Q != Q - 1:
        fail("j^2 != -1 mod q (j=%d, j^2=%d)" % (J, J * J % Q))
    if pow(PSI, 1024, Q) != Q - 1:
        fail("psi^1024 != -1 (got %d) -> not negacyclic" % pow(PSI, 1024, Q))
    if pow(PSI, 2048, Q) != 1:
        fail("psi^2048 != 1 (got %d)" % pow(PSI, 2048, Q))
    if OMEGA != PSI * PSI % Q:
        fail("omega != psi^2 (omega=%d, psi^2=%d)" % (OMEGA, PSI * PSI % Q))
    if pow(OMEGA, N, Q) != 1 or pow(OMEGA, N // 2, Q) == 1:
        fail("omega is not a primitive N-th root of unity")
    if NINV * N % Q != 1:
        fail("N^-1 wrong: %d * %d mod q = %d" % (NINV, N, NINV * N % Q))
    if MU != (1 << KSH) // Q:
        fail("mu != floor(2^k/q): mu=%d expected=%d" % (MU, (1 << KSH) // Q))

def check_barrett_z3():
    """Exhaustive proof: barrett_reduce(x) == x mod q for all x in [0, 2^28)."""
    try:
        from z3 import BitVec, BitVecVal, LShR, UGE, ULT, URem, If, Solver, unsat
    except Exception as e:  # pragma: no cover
        fail("z3 unavailable for Barrett proof: %r" % (e,))
    x = BitVec('x', 64)
    mu = BitVecVal(MU, 64)
    q = BitVecVal(Q, 64)
    t = LShR(x * mu, KSH)
    r0 = x - t * q
    r1 = If(UGE(r0, q), r0 - q, r0)
    r2 = If(UGE(r1, q), r1 - q, r1)
    s = Solver()
    s.add(ULT(x, BitVecVal(1 << 28, 64)))
    s.add(r2 != URem(x, q))
    res = s.check()
    if res != unsat:
        m = s.model()
        xv = m[x].as_long() if m[x] is not None else -1
        fail("Barrett != x mod q at x=%d (impl=%d, mod=%d)"
             % (xv, barrett_reduce(xv), xv % Q))

def check_butterflies(rng):
    for _ in range(4000):
        x0 = rng.randrange(Q); x1 = rng.randrange(Q); w = rng.randrange(Q)
        if radix2_butterfly(x0, x1, w) != golden_dft2(x0, x1, w):
            fail("radix-2 butterfly mismatch at x0=%d x1=%d w=%d" % (x0, x1, w))
    # edge operands
    for x0 in (0, 1, Q - 1):
        for x1 in (0, 1, Q - 1):
            for w in (0, 1, Q - 1):
                if radix2_butterfly(x0, x1, w) != golden_dft2(x0, x1, w):
                    fail("radix-2 edge mismatch x0=%d x1=%d w=%d" % (x0, x1, w))

def check_radix4(rng):
    for _ in range(4000):
        x0 = rng.randrange(Q); x1 = rng.randrange(Q)
        x2 = rng.randrange(Q); x3 = rng.randrange(Q); w = rng.randrange(Q)
        # spec equations vs direct 4-point DFT with root j
        w1 = w % Q; w2 = w1 * w1 % Q; w3 = w2 * w1 % Q
        X1 = w1 * x1 % Q; X2 = w2 * x2 % Q; X3 = w3 * x3 % Q
        got = radix4_butterfly(x0, x1, x2, x3, w)
        ref = golden_dft4_j(x0, X1, X2, X3)
        if got != ref:
            fail("radix-4 != DFT4(j) at x=(%d,%d,%d,%d) w=%d: %s vs %s"
                 % (x0, x1, x2, x3, w, got, ref))
        # fusion: DFT4(j) == two radix-2 stages
        ref2 = golden_dft4_two_radix2(x0, X1, X2, X3)
        if ref != ref2:
            fail("radix-4 fusion (two radix-2 stages) mismatch: %s vs %s" % (ref, ref2))

def check_ntt(rng):
    for _ in range(2):
        a = [rng.randrange(Q) for _ in range(N)]
        impl = fwd_ntt(a)
        gold = golden_fwd(a)
        if impl != gold:
            fail("forward NTT vs golden: " + first_diff(impl, gold))
        # INTT(NTT(a)) == a
        back = inv_ntt(impl)
        if back != a:
            fail("INTT(NTT(a)) != a: " + first_diff(back, a))

def check_convolution(rng):
    a = [rng.randrange(Q) for _ in range(N)]
    b = [rng.randrange(Q) for _ in range(N)]
    A = fwd_ntt(a)
    B = fwd_ntt(b)
    P = [modmul(A[k], B[k]) for k in range(N)]
    c_ntt = inv_ntt(P)
    c_ref = schoolbook_negacyclic(a, b)
    if c_ntt != c_ref:
        fail("negacyclic convolution (NTT path) != schoolbook: "
             + first_diff(c_ntt, c_ref))

def main():
    rng = random.Random(0xCF47)
    check_constants()
    check_barrett_z3()
    check_butterflies(rng)
    check_radix4(rng)
    check_ntt(rng)
    check_convolution(rng)
    print("VERIFIED")
    sys.exit(0)

if __name__ == "__main__":
    main()
