#!/usr/bin/env python3
"""
Self-checking reproduction of the CFNTT Radix-2/4 NTT multiplication accelerator
from its scene spec alone.

Implements (functional, value-exact):
  * Barrett modular reduction (mu=21843, k=28) for q=12289, proven == x%q over
    ALL 28-bit inputs with z3.
  * radix-2 NTT butterfly  : y0=u+w*x1, y1=u-w*x1
  * radix-4 NTT butterfly  : DFT4 of (x0, w*x1, w^2*x2, w^3*x3) with constant
    rotator j=psi^512 (matches the spec's y0..y3 equations verbatim).
  * full negacyclic NTT/INTT (psi pre/post twist, N^-1 scaling) -> identity.
  * negacyclic NTT-based polynomial multiply == schoolbook mult mod (x^N+1, q).

Verified against independent golden models. Prints VERIFIED / FAIL.
"""
import random
import sys

Q = 12289          # 14-bit NTT-friendly prime (spec: '14-bit prime'; fixed here)
N = 1024
G = 11             # generator (spec-provided)
MU = 21843         # floor(2^28 / q)
K_SHIFT = 28


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


# --------------------------------------------------------------------------
# Barrett modular reduction (the spec's two-member reduction stage)
# --------------------------------------------------------------------------
def barrett(x):
    # mod_red_mult : t = (x*mu) >> k   ;  mod_red_subshift : r = x - t*q, correct
    t = (x * MU) >> K_SHIFT
    r = x - t * Q
    if r >= Q:
        r -= Q
    if r >= Q:
        r -= Q
    return r


def modmul(a, b):
    return barrett(a * b)


def modadd(a, b):
    r = a + b
    return r - Q if r >= Q else r


def modsub(a, b):
    r = a - b
    return r + Q if r < 0 else r


# --------------------------------------------------------------------------
# Root parameters (spec-provided; verified below)
# --------------------------------------------------------------------------
def derive_roots():
    psi = pow(G, 6, Q)                 # 11^6 = 1945, order 2048
    if pow(psi, 1024, Q) != Q - 1 or pow(psi, 2048, Q) != 1:
        fail("psi=g^6 is not a primitive 2N-th root: psi^1024=%d" %
             pow(psi, 1024, Q))
    omega = (psi * psi) % Q            # N-th root
    if pow(omega, N, Q) != 1 or pow(omega, N // 2, Q) != Q - 1:
        fail("omega=psi^2 is not a primitive N-th root")
    j = pow(psi, 512, Q)              # constant radix-4 rotator
    if (j * j) % Q != Q - 1:
        fail("j=psi^512 does not satisfy j^2 = -1")
    return psi, omega, j


PSI, OMEGA, JC = derive_roots()
OMEGA_INV = pow(OMEGA, -1, Q)
PSI_INV = pow(PSI, -1, Q)
N_INV = pow(N, -1, Q)                  # = 12277 (spec's 8857 is wrong)
PSI_POW = [pow(PSI, i, Q) for i in range(N)]
PSI_INV_POW = [pow(PSI_INV, i, Q) for i in range(N)]


# --------------------------------------------------------------------------
# Radix-2 cyclic NTT (recursive Cooley-Tukey, natural order, radix-2 butterfly)
# --------------------------------------------------------------------------
def ntt_r2(a, root):
    n = len(a)
    if n == 1:
        return a[:]
    root2 = modmul(root, root)
    E = ntt_r2(a[0::2], root2)
    O = ntt_r2(a[1::2], root2)
    A = [0] * n
    h = n // 2
    wk = 1
    for k in range(h):
        t = modmul(O[k], wk)           # radix-2 butterfly: y0=u+t, y1=u-t
        A[k] = modadd(E[k], t)
        A[k + h] = modsub(E[k], t)
        wk = modmul(wk, root)
    return A


# --------------------------------------------------------------------------
# Radix-4 cyclic NTT (recursive, radix-4 butterfly = spec's y0..y3 equations)
# --------------------------------------------------------------------------
def ntt_r4(a, root):
    n = len(a)
    if n == 1:
        return a[:]
    root4 = pow(root, 4, Q)
    A0 = ntt_r4(a[0::4], root4)
    A1 = ntt_r4(a[1::4], root4)
    A2 = ntt_r4(a[2::4], root4)
    A3 = ntt_r4(a[3::4], root4)
    A = [0] * n
    q = n // 4
    wk = 1
    for k in range(q):
        w2k = modmul(wk, wk)
        w3k = modmul(w2k, wk)
        x0 = A0[k]
        b = modmul(A1[k], wk)          # W1*x1
        c = modmul(A2[k], w2k)         # W2*x2
        d = modmul(A3[k], w3k)         # W3*x3
        jb = modmul(JC, b)
        jd = modmul(JC, d)
        # y0 = x0+b+c+d ; y1 = x0+j*b-c-j*d ; y2 = x0-b+c-d ; y3 = x0-j*b-c+j*d
        A[k]          = modadd(modadd(x0, b), modadd(c, d))
        A[k + q]      = modsub(modadd(x0, jb), modadd(c, jd))
        A[k + 2 * q]  = modsub(modadd(x0, c), modadd(b, d))
        A[k + 3 * q]  = modadd(modsub(modsub(x0, jb), c), jd)
        wk = modmul(wk, root)
    return A


def intt_cyclic(A):
    inv = ntt_r2(A, OMEGA_INV)
    return [modmul(N_INV, v) for v in inv]


# --------------------------------------------------------------------------
# Negacyclic NTT / INTT (pre/post twist by psi^i)
# --------------------------------------------------------------------------
def ntt_neg(a):
    twisted = [modmul(a[i], PSI_POW[i]) for i in range(N)]
    return ntt_r2(twisted, OMEGA)


def intt_neg(A):
    b = intt_cyclic(A)
    return [modmul(b[i], PSI_INV_POW[i]) for i in range(N)]


def poly_mul_ntt(a, b):
    Fa = ntt_neg(a)
    Fb = ntt_neg(b)
    Fc = [modmul(Fa[i], Fb[i]) for i in range(N)]
    return intt_neg(Fc)


# --------------------------------------------------------------------------
# GOLDEN reference models (independent)
# --------------------------------------------------------------------------
def golden_dft(a, root):
    n = len(a)
    rt = [pow(root, e, Q) for e in range(n)]
    out = [0] * n
    for k in range(n):
        s = 0
        for i in range(n):
            s += a[i] * rt[(i * k) % n]
        out[k] = s % Q
    return out


def golden_neg_eval(a):
    # negacyclic NTT = evaluate a(X) at X = psi^(2k+1):  â[k] = sum a_i psi^{i(2k+1)}
    out = [0] * N
    for k in range(N):
        e0 = (2 * k + 1)
        s = 0
        pw = 1
        step = pow(PSI, e0 % (2 * N), Q)
        for i in range(N):
            s += a[i] * pw
            pw = (pw * step) % Q
        out[k] = s % Q
    return out


def golden_schoolbook_negacyclic(a, b):
    c = [0] * N
    for i in range(N):
        ai = a[i]
        if ai == 0:
            continue
        for j in range(N):
            idx = i + j
            prod = ai * b[j]
            if idx < N:
                c[idx] = (c[idx] + prod) % Q
            else:
                c[idx - N] = (c[idx - N] - prod) % Q
    return [x % Q for x in c]


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------
def prove_barrett_with_z3():
    try:
        from z3 import Int, And, Or, If, Solver, sat
    except Exception as e:  # pragma: no cover
        fail("z3 unavailable: %s" % e)
    x = Int('x')
    t = Int('t')
    Kc = 1 << K_SHIFT
    # t = floor(mu*x / 2^k) encoded linearly; r0=x-q*t; two conditional subtracts.
    cons = And(x >= 0, x < Kc, Kc * t <= MU * x, MU * x < Kc * (t + 1))
    r0 = x - Q * t
    r1 = If(r0 >= Q, r0 - Q, r0)
    r2 = If(r1 >= Q, r1 - Q, r1)
    s = Solver()
    s.add(cons)
    s.add(Or(r0 < 0, r2 >= Q))          # counterexample to (0<=r0 and r2<q)
    res = s.check()
    if res == sat:
        m = s.model()
        fail("Barrett incorrect for x=%s (z3 counterexample)" % m[x])
    # r2 in [0,q) and r2 = x - q*(t+corr) => r2 == x mod q for all 28-bit x.


def main():
    random.seed(0)

    # 1) parameter sanity already done in derive_roots(); confirm N_inv really inverts.
    if (N * N_INV) % Q != 1:
        fail("N_INV does not invert N mod q")
    if (N * 8857) % Q == 1:
        fail("spec's 8857 unexpectedly inverts N (it should not)")

    # 2) Barrett == x % q  : exhaustive proof over all 28-bit inputs via z3.
    prove_barrett_with_z3()
    # plus concrete edge cases against Python's %:
    for x in [0, 1, Q - 1, Q, Q + 1, 2 * Q, (Q - 1) * (Q - 1),
              (1 << K_SHIFT) - 1, 123456789, 268435455]:
        if barrett(x) != x % Q:
            fail("barrett(%d)=%d != %d" % (x, barrett(x), x % Q))
    for _ in range(20000):
        x = random.randint(0, (1 << K_SHIFT) - 1)
        if barrett(x) != x % Q:
            fail("barrett(%d) mismatch" % x)

    # 3) radix-2 / radix-4 cyclic NTT == golden DFT, and radix-2 == radix-4.
    for _ in range(2):
        a = [random.randrange(Q) for _ in range(N)]
        g = golden_dft(a, OMEGA)
        r2 = ntt_r2(a, OMEGA)
        r4 = ntt_r4(a, OMEGA)
        if r2 != g:
            i = next(k for k in range(N) if r2[k] != g[k])
            fail("radix-2 NTT != golden DFT at k=%d (%d vs %d)" % (i, r2[i], g[i]))
        if r4 != g:
            i = next(k for k in range(N) if r4[k] != g[k])
            fail("radix-4 NTT != golden DFT at k=%d (%d vs %d)" % (i, r4[i], g[i]))
        if r2 != r4:
            i = next(k for k in range(N) if r2[k] != r4[k])
            fail("radix-2 vs radix-4 disagree at k=%d" % i)

    # 4) negacyclic forward == direct evaluation at psi^(2k+1).
    a = [random.randrange(Q) for _ in range(N)]
    fwd = ntt_neg(a)
    gneg = golden_neg_eval(a)
    if fwd != gneg:
        i = next(k for k in range(N) if fwd[k] != gneg[k])
        fail("negacyclic NTT != a(psi^(2k+1)) at k=%d (%d vs %d)" %
             (i, fwd[i], gneg[i]))

    # 5) INTT(NTT(a)) == a   (the spec's identity property).
    for _ in range(5):
        a = [random.randrange(Q) for _ in range(N)]
        back = intt_neg(ntt_neg(a))
        if back != a:
            i = next(k for k in range(N) if back[k] != a[k])
            fail("INTT(NTT(a)) != a at i=%d (%d vs %d)" % (i, back[i], a[i]))

    # 6) NTT-based negacyclic multiply == schoolbook mult mod (x^N+1, q).
    for _ in range(2):
        a = [random.randrange(Q) for _ in range(N)]
        b = [random.randrange(Q) for _ in range(N)]
        c_ntt = poly_mul_ntt(a, b)
        c_ref = golden_schoolbook_negacyclic(a, b)
        if c_ntt != c_ref:
            i = next(k for k in range(N) if c_ntt[k] != c_ref[k])
            fail("NTT poly-mul != schoolbook at i=%d (%d vs %d)" %
                 (i, c_ntt[i], c_ref[i]))

    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
