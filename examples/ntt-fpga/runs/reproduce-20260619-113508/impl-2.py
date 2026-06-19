#!/usr/bin/env python3
"""
CFNTT Radix-2/4 NTT Multiplication Accelerator -- reverse-implemented from spec.

We model only the FUNCTIONAL datapath: the conflict-free storage map, Barrett
modular reduction, radix-2 and radix-4 NTT butterflies, and the negacyclic
NTT/INTT (psi pre/post twist + N^-1) used for polynomial multiplication mod x^N+1.

Verification turns correctness into small finite obligations:
  * z3 proves Barrett reduction is exact over the WHOLE 28-bit product range,
    with <=2 corrections (one query generalizes all inputs).
  * z3 proves the storage map i->(bank,offset) is injective over i in [0,1024).
  * radix-2/4 engines are checked == an independent matrix-DFT golden on small N.
  * radix-4 == radix-2 on small N (op-fusion equivalence).
  * negacyclic convolution via NTT == an independent O(N^2) schoolbook golden
    (small N, plus one production-size N=1024 instance).
  * NTT then INTT == identity (cyclic + negacyclic) at production size N=1024.
"""

import sys, random

random.seed(0xCF77)

Q = 12289                 # 14-bit NTT-friendly prime, q = 3*2^12 + 1  (spec)
K_SHIFT = 28              # Barrett shift                              (spec)
MU = (1 << K_SHIFT) // Q  # Barrett constant floor(2^28/q)            (spec: 21843)
PSI = 1945                # 2N-th primitive root, order 2048           (spec)
OMEGA = pow(PSI, 2, Q)    # N-th root = psi^2                          (spec: 10302)
N_FULL = 1024
N_INV_FULL = pow(N_FULL, Q - 2, Q)   # 12277


class Fail(Exception):
    pass


def check(cond, msg):
    if not cond:
        raise Fail(msg)


# ---------------------------------------------------------------------------
# Barrett modular reduction (the shared reduction spine: q-multiply + correct)
# ---------------------------------------------------------------------------
def barrett_reduce(x):
    # x must be a non-negative 28-bit value (product of two operands in [0,q))
    t = (x * MU) >> K_SHIFT          # mod_red_mult:  t = (x*mu) >> k
    r = x - t * Q                    # mod_red_subshift: r = x - t*q
    c = 0
    while r >= Q:                    # up to 2 conditional subtractions
        r -= Q
        c += 1
    if c > 2 or r < 0:
        raise Fail(f"barrett out of bound x={x} r={r} c={c}")
    return r


_MUL_COUNT = [0]


def bmul(a, b):
    _MUL_COUNT[0] += 1
    return barrett_reduce(a * b)


# ---------------------------------------------------------------------------
# Conflict-free storage map (spec: b(i)=(i+(i>>3))%8, o(i)=i>>3)
# ---------------------------------------------------------------------------
def bank(i):
    return (i + (i >> 3)) % 8


def offset(i):
    return i >> 3


# ---------------------------------------------------------------------------
# NTT engines (Cooley-Tukey, natural-order in / natural-order out, no bit-rev)
# All runtime products go through Barrett (the hardware reduction).
# ---------------------------------------------------------------------------
def ntt_radix2(a, w):
    n = len(a)
    if n == 1:
        return a[:]
    w2 = bmul(w, w)
    e = ntt_radix2(a[0::2], w2)
    o = ntt_radix2(a[1::2], w2)
    out = [0] * n
    wk = 1
    m = n // 2
    for k in range(m):
        t = bmul(wk, o[k])
        out[k] = (e[k] + t) % Q
        out[k + m] = (e[k] - t) % Q
        wk = bmul(wk, w)
    return out


def ntt_radix4(a, w):
    n = len(a)
    if n == 1:
        return a[:]
    if n == 2:                        # base radix-2 butterfly (w = -1)
        return [(a[0] + a[1]) % Q, (a[0] - a[1]) % Q]
    # n % 4 == 0 here (all our n are powers of two >= 4)
    w4 = bmul(bmul(w, w), bmul(w, w))
    s0 = ntt_radix4(a[0::4], w4)
    s1 = ntt_radix4(a[1::4], w4)
    s2 = ntt_radix4(a[2::4], w4)
    s3 = ntt_radix4(a[3::4], w4)
    m = n // 4
    I = pow(w, m, Q)                  # constant 4th root (j-rotator analogue)
    out = [0] * n
    wk = 1
    for k in range(m):
        wk2 = bmul(wk, wk)
        wk3 = bmul(wk2, wk)
        A = s0[k]
        B = bmul(wk, s1[k])           # W1 * x1
        C = bmul(wk2, s2[k])          # W2 * x2
        D = bmul(wk3, s3[k])          # W3 * x3
        iB = bmul(I, B)
        iD = bmul(I, D)
        out[k]         = (A + B + C + D) % Q
        out[k + m]     = (A + iB - C - iD) % Q
        out[k + 2 * m] = (A - B + C - D) % Q
        out[k + 3 * m] = (A - iB - C + iD) % Q
        wk = bmul(wk, w)
    return out


def intt(A, w, ninv):
    winv = pow(w, Q - 2, Q)
    y = ntt_radix4(A, winv)
    return [bmul(v, ninv) for v in y]


# ---------------------------------------------------------------------------
# Independent golden: matrix DFT (small N only)
# ---------------------------------------------------------------------------
def dft_matrix(a, w):
    n = len(a)
    return [sum(a[i] * pow(w, (i * k) % n, Q) for i in range(n)) % Q
            for k in range(n)]


# ---------------------------------------------------------------------------
# Negacyclic NTT (psi pre-twist, INTT psi^{-i} post-twist + N^-1)
# ---------------------------------------------------------------------------
def roots(n):
    r2n = pow(PSI, 2048 // (2 * n), Q)        # order 2n
    return r2n, pow(r2n, 2, Q), pow(n, Q - 2, Q)  # psi_n, omega_n, ninv_n


def neg_ntt(a, psi, omega):
    pre = [bmul(a[i], pow(psi, i, Q)) for i in range(len(a))]
    return ntt_radix4(pre, omega)


def neg_intt(A, psi, omega, ninv):
    y = intt(A, omega, ninv)
    pinv = pow(psi, Q - 2, Q)
    return [bmul(y[i], pow(pinv, i, Q)) for i in range(len(A))]


def negaconv_via_ntt(a, b, psi, omega, ninv):
    X = neg_ntt(a, psi, omega)
    Y = neg_ntt(b, psi, omega)
    P = [bmul(X[i], Y[i]) for i in range(len(a))]
    return neg_intt(P, psi, omega, ninv)


# Independent golden: schoolbook negacyclic convolution mod (x^N + 1)
def negaconv_schoolbook(a, b):
    n = len(a)
    c = [0] * n
    for i in range(n):
        ai = a[i]
        for j in range(n):
            v = (ai * b[j]) % Q
            k = i + j
            if k < n:
                c[k] = (c[k] + v) % Q
            else:
                c[k - n] = (c[k - n] - v) % Q
    return [x % Q for x in c]


# ---------------------------------------------------------------------------
# z3 proofs
# ---------------------------------------------------------------------------
def prove_barrett():
    from z3 import Int, Solver, Or, unsat
    x, t, rem = Int('x'), Int('t'), Int('rem')
    s = Solver()
    s.add(x >= 0, x < Q * Q)              # products of two reduced operands
    s.add(rem >= 0, rem < (1 << K_SHIFT))
    s.add(x * MU == (1 << K_SHIFT) * t + rem)   # t = floor(x*mu/2^k)
    r = x - t * Q
    s.add(Or(r < 0, r >= 3 * Q))          # search a violation of [0,3q)
    return s.check() == unsat


def prove_storage_injective():
    from z3 import Int, Solver, And, unsat
    i, j = Int('i'), Int('j')
    s = Solver()
    s.add(i >= 0, i < N_FULL, j >= 0, j < N_FULL, i != j)
    bi, oi = (i + i / 8) % 8, i / 8
    bj, oj = (j + j / 8) % 8, j / 8
    s.add(And(bi == bj, oi == oj))        # two distinct indices collide?
    return s.check() == unsat


# ---------------------------------------------------------------------------
# FSM reachability (spec schedule_controller)
# ---------------------------------------------------------------------------
FSM_STATES = ["IDLE", "LOAD", "STAGE_LOOP", "TWIDDLE_FETCH", "BUTTERFLY",
              "REDUCE", "WRITEBACK", "INTT_STAGE_LOOP", "SCALE_N_INV", "DRAIN"]
FSM_EDGES = [("IDLE", "LOAD"), ("LOAD", "STAGE_LOOP"),
             ("STAGE_LOOP", "TWIDDLE_FETCH"), ("TWIDDLE_FETCH", "BUTTERFLY"),
             ("BUTTERFLY", "REDUCE"), ("REDUCE", "WRITEBACK"),
             ("WRITEBACK", "TWIDDLE_FETCH"), ("WRITEBACK", "STAGE_LOOP"),
             ("STAGE_LOOP", "INTT_STAGE_LOOP"), ("STAGE_LOOP", "DRAIN"),
             ("INTT_STAGE_LOOP", "SCALE_N_INV"), ("SCALE_N_INV", "DRAIN"),
             ("DRAIN", "IDLE")]


def fsm_reachable():
    adj = {s: [] for s in FSM_STATES}
    for a, b in FSM_EDGES:
        adj[a].append(b)
    seen, stack = set(), ["IDLE"]
    while stack:
        s = stack.pop()
        if s in seen:
            continue
        seen.add(s)
        stack.extend(adj[s])
    return seen == set(FSM_STATES) and ("DRAIN", "IDLE") in FSM_EDGES


# ---------------------------------------------------------------------------
# Verification driver
# ---------------------------------------------------------------------------
def main():
    # 1. Spec parameter identities (authoritative values must hold mod q).
    check(MU == 21843, f"mu={MU}")
    check(OMEGA == 10302, f"omega={OMEGA}")
    check(N_INV_FULL == 12277, f"Ninv={N_INV_FULL}")
    check(pow(PSI, 2048, Q) == 1, "psi^2048 != 1")
    check(pow(PSI, 1024, Q) == Q - 1, "psi^1024 != -1 (not negacyclic)")
    check(pow(OMEGA, 1024, Q) == 1, "omega^1024 != 1")
    check(pow(OMEGA, 512, Q) == Q - 1, "omega^512 != -1")
    j = pow(PSI, 512, Q)
    check((j * j) % Q == Q - 1, "j^2 != -1")
    check((N_FULL * N_INV_FULL) % Q == 1, "N*N^-1 != 1")
    check(pow(11, 6, Q) == PSI, "generator g=11 -> psi mismatch")

    # 2. Barrett: exact over full product range via z3, plus concrete sampling.
    check(prove_barrett(), "z3: Barrett not exact / >2 corrections")
    for x in [0, 1, Q - 1, Q, Q * Q - 1, (Q - 1) * (Q - 1), 268435455]:
        check(barrett_reduce(x) == x % Q, f"barrett({x})")
    for _ in range(20000):
        a, b = random.randrange(Q), random.randrange(Q)
        check(bmul(a, b) == (a * b) % Q, f"bmul({a},{b})")

    # 3. Storage map is an injective (bank,offset) placement via z3.
    check(prove_storage_injective(), "z3: storage map not injective")

    # 4. Engines == independent matrix-DFT golden, and radix-4 == radix-2.
    for n in (4, 8, 16, 64):
        psi_n, omega_n, _ = roots(n)
        for _ in range(8):
            a = [random.randrange(Q) for _ in range(n)]
            g = dft_matrix(a, omega_n)
            check(ntt_radix2(a, omega_n) == g, f"radix2 != DFT n={n}")
            check(ntt_radix4(a, omega_n) == g, f"radix4 != DFT n={n}")
        # basis vectors: column m must be [omega^(m*k)]
        for m in range(min(n, 8)):
            e = [1 if i == m else 0 for i in range(n)]
            col = [pow(omega_n, (m * k) % n, Q) for k in range(n)]
            check(ntt_radix4(e, omega_n) == col, f"basis n={n} m={m}")

    # 5. Radix-4 uses strictly fewer modular mults than radix-2 (spec claim).
    n = 64
    _, omega_n, _ = roots(n)
    a = [random.randrange(Q) for _ in range(n)]
    _MUL_COUNT[0] = 0
    ntt_radix2(a, omega_n)
    c2 = _MUL_COUNT[0]
    _MUL_COUNT[0] = 0
    ntt_radix4(a, omega_n)
    c4 = _MUL_COUNT[0]
    check(c4 < c2, f"radix-4 mults {c4} not < radix-2 {c2}")

    # 6. Negacyclic convolution via NTT == schoolbook golden (small N).
    for n in (4, 8, 16):
        psi_n, omega_n, ninv_n = roots(n)
        for _ in range(8):
            a = [random.randrange(Q) for _ in range(n)]
            b = [random.randrange(Q) for _ in range(n)]
            got = negaconv_via_ntt(a, b, psi_n, omega_n, ninv_n)
            exp = negaconv_schoolbook(a, b)
            check(got == exp, f"negaconv n={n}: {got} != {exp}")
        # round-trip identity
        for _ in range(4):
            a = [random.randrange(Q) for _ in range(n)]
            rt = neg_intt(neg_ntt(a, psi_n, omega_n), psi_n, omega_n, ninv_n)
            check(rt == a, f"neg round-trip n={n}")

    # 7. Production-size N=1024: round trips (O(N log N)) + one heavy golden.
    for _ in range(2):
        a = [random.randrange(Q) for _ in range(N_FULL)]
        # cyclic NTT/INTT identity
        rt = intt(ntt_radix4(a, OMEGA), OMEGA, N_INV_FULL)
        check(rt == a, "cyclic round-trip N=1024")
        # negacyclic NTT/INTT identity
        nrt = neg_intt(neg_ntt(a, PSI, OMEGA), PSI, OMEGA, N_INV_FULL)
        check(nrt == a, "negacyclic round-trip N=1024")
        # radix-4 == radix-2 at full size
        check(ntt_radix4(a, OMEGA) == ntt_radix2(a, OMEGA),
              "radix4 != radix2 N=1024")
    # one full-size negacyclic conv vs independent schoolbook golden
    a = [random.randrange(Q) for _ in range(N_FULL)]
    b = [random.randrange(Q) for _ in range(N_FULL)]
    got = negaconv_via_ntt(a, b, PSI, OMEGA, N_INV_FULL)
    exp = negaconv_schoolbook(a, b)
    check(got == exp, "negaconv mismatch N=1024")

    # 8. Schedule FSM is fully reachable and terminates back to IDLE.
    check(fsm_reachable(), "FSM not fully reachable / no DRAIN->IDLE")

    print("VERIFIED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as e:
        print(f"FAIL: {e}")
        sys.exit(1)
    except Exception as e:  # noqa: BLE001 - report any unexpected break as failure
        print(f"FAIL: unexpected {type(e).__name__}: {e}")
        sys.exit(1)
