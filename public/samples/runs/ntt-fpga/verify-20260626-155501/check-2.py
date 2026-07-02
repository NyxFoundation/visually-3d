#!/usr/bin/env python3
"""
Formal verification of the CFNTT Radix-2 NTT multiplication accelerator
(Chen et al., IACR TCHES 2022(1):94-126; reference repo xiang-rc/cfntt_ref).

Ground truth = the cloned reference source:
  * cfntt_ref/model_code/poly_mult_radix_2.py  (q=12289, kesai=7, DIT/DIF, op21)
  * cfntt_ref/hardware_code_radix-2/modular_add.v / modular_half.v
  * cfntt_ref/hardware_code_radix-2/conflict_free_memory_map.v  (2-bank parity map)
  * cfntt_ref/hardware_code_radix-2/address_generator.v         (operand pair)

Everything below is modeled on those real functions/parameters.

Two tiers, deterministic, must finish well under 60s:

TIER 1 — size-independent, proven at FULL bit width / over the FULL finite domain:
  (A) modular_add   == (x+y) mod q          z3 / QF_BV, exact gate model      [src]
  (B) modular_sub   == (x-y) mod q          z3 / QF_BV                         [conv]
  (C) modular_half  == x * 2^-1 mod q        z3 / QF_BV, exact gate model (op21)[src]
  (D) Barrett(x)    == x mod q  for x in [0,(q-1)^2], <=2 cond. subs           [src]
  (E) conflict-free memory map: (bank,offset) is a bijection of the 10-bit
      address, AND for EVERY power-of-two stride 2^p the two butterfly operands
      land in DIFFERENT banks.  z3 over the real parity map.                   [src]

TIER 2 — whole-system equivalence at the SMALLEST structure-preserving sizes
(N in {8,16}), using the source's EXACT DIT_NR_NTT / DIF_RN_INTT / op21 with a
negacyclic twiddle table psi^bitrev derived from the source root (psi = 7^(2048/2N)):
  (F) INVERTIBILITY  INTT(NTT(e_i)) == e_i on the FULL basis  -> proves
      INTT o NTT = identity for ALL inputs (linear map).
  (G) CONVOLUTION    INTT(NTT(e_i) (.) NTT(e_j)) == negacyclic_conv(e_i,e_j)
      on all basis PAIRS -> proves the transform diagonalises negacyclic
      convolution (bilinear, hence for all inputs).

Production-size (N=1024) grounding: round-trip on the REAL source negacyclic
table (psi=kesai=7, bit-reversed) over a deterministic O(N log N) vector set.

Prints exactly "VERIFIED" / exit 0 iff every required check passes, else
"FAIL: <reason + counterexample>" / exit 1.
"""

import sys
import math
import random

try:
    from z3 import (
        BitVec, BitVecVal, Extract, ZeroExt, LShR, URem, UGE, ULE, ULT, If,
        And, Or, Then, unsat, sat,
    )
except Exception as exc:  # z3 is allowed and required
    print("FAIL: z3 unavailable (%r)" % (exc,))
    sys.exit(1)

Q = 12289          # 14-bit NTT-friendly prime, q = 3*2^12 + 1            [src]
KESAI = 7          # negacyclic 2N-th root psi used by the reference        [src]
MU = 21843         # Barrett mu = floor(2^28 / q)                          [src]
KBAR = 28          # Barrett shift k                                       [src]


# ---------------------------------------------------------------------------
# z3 helper: a property is PROVEN when the negation is UNSAT.  We bit-blast so
# every pure bit-vector obligation is decidable (never accept 'unknown').
# ---------------------------------------------------------------------------
def _qfbv_solver():
    return Then('simplify', 'bit-blast', 'smt').solver()


def prove_unsat(name, constraints):
    s = _qfbv_solver()
    s.add(*constraints)
    r = s.check()
    if r == unsat:
        return True, ""
    if r == sat:
        return False, "%s: z3 found a violating model %s" % (name, s.model())
    return False, "%s: z3 returned 'unknown' (encoding not decided)" % name


# ===========================================================================
# TIER 1 (A) modular_add.v  — exact gate model, prove == (x+y) mod q
#   {c,s} = x + y ; {b,d} = s - M ; sel = ~((~c)&b) ; z = sel ? d : s
# ===========================================================================
def check_modular_add():
    x = BitVec('x', 14)
    y = BitVec('y', 14)
    M15 = BitVecVal(Q, 15)
    sum15 = ZeroExt(1, x) + ZeroExt(1, y)          # {c,s}
    c = Extract(14, 14, sum15)
    s = Extract(13, 0, sum15)
    diff = ZeroExt(1, s) - M15                      # {b,d} = s - M
    b = Extract(14, 14, diff)                       # borrow (1 = s < M)
    d = Extract(13, 0, diff)
    sel = ~((~c) & b)                               # 1-bit
    z = If(sel == BitVecVal(1, 1), d, s)            # hardware output (14-bit)
    gold = If(UGE(sum15, M15), Extract(13, 0, sum15 - M15), s)
    pre = And(ULT(x, BitVecVal(Q, 14)), ULT(y, BitVecVal(Q, 14)))
    return prove_unsat("modular_add", [pre, z != gold])


# ===========================================================================
# TIER 1 (B) modular subtraction — prove == (x-y) mod q  (standard borrow+add)
# ===========================================================================
def check_modular_sub():
    x = BitVec('x', 14)
    y = BitVec('y', 14)
    diff15 = ZeroExt(1, x) - ZeroExt(1, y)
    borrow = Extract(14, 14, diff15)               # 1 => x < y
    s = Extract(13, 0, diff15)
    corr = Extract(13, 0, ZeroExt(1, s) + BitVecVal(Q, 15))
    z = If(borrow == BitVecVal(1, 1), corr, s)     # 14-bit result
    # golden: (x - y + q) mod q on a wider unsigned word (no Int/BV mixing)
    gold = URem(ZeroExt(2, x) - ZeroExt(2, y) + BitVecVal(Q, 16), BitVecVal(Q, 16))
    pre = And(ULT(x, BitVecVal(Q, 14)), ULT(y, BitVecVal(Q, 14)))
    return prove_unsat("modular_sub", [pre, ZeroExt(2, z) != gold])


# ===========================================================================
# TIER 1 (C) modular_half.v / op21 — exact gate model, prove == x * 2^-1 mod q
#   x_sh = x>>1 ; {c,s} = x_sh + (M+1)/2 ; y = x[0] ? s : x_sh
#   (2^-1 mod q == (q+1)/2 == 6145)
# ===========================================================================
def check_modular_half():
    INV2 = (Q + 1) // 2                             # 6145
    a = BitVec('a', 14)
    xsh = LShR(a, 1)                                # a >> 1
    s = Extract(13, 0, ZeroExt(1, xsh) + BitVecVal(INV2, 15))
    y = If(Extract(0, 0, a) == BitVecVal(1, 1), s, xsh)
    # golden: (a * INV2) mod q in 32-bit BV
    gold = URem(ZeroExt(18, a) * BitVecVal(INV2, 32), BitVecVal(Q, 32))
    pre = ULT(a, BitVecVal(Q, 14))
    return prove_unsat("modular_half", [pre, ZeroExt(18, y) != gold])


# ===========================================================================
# TIER 1 (D) Barrett reduction — prove == x mod q for x in [0,(q-1)^2]
#   t = (x*mu)>>k ; r = x - t*q ; <=2 conditional subtractions of q
#
# Proved WITHOUT a 44-bit division (URem over 44 bits bit-blasts into an
# intractable circuit -> that was the timeout).  By construction
#   r2 = x - (t+s)*q,  s in {0,1,2},
# and each subtraction is guarded by UGE(.,q), so it is exact and stays >= 0.
# Therefore r2 == x (mod q) AUTOMATICALLY, *provided*:
#   (1) no underflow:   t*q <= x   (so r0 = x - t*q is the true remainder, no wrap)
#   (2) fully reduced:  r2 < q
# We z3-PROVE (1) AND (2) over the whole domain; that is the full proof of
# Barrett correctness, and it only ever multiplies by CONSTANTS (fast).
# ===========================================================================
def check_barrett():
    W = 44
    x = BitVec('x', W)
    q = BitVecVal(Q, W)
    t = LShR(x * BitVecVal(MU, W), KBAR)            # quotient estimate
    tq = t * q
    r0 = x - tq
    r1 = If(UGE(r0, q), r0 - q, r0)
    r2 = If(UGE(r1, q), r1 - q, r1)                 # at most 2 cond. subs   [src]
    pre = ULE(x, BitVecVal((Q - 1) * (Q - 1), W))
    # bad  <=>  underflow (t*q > x)  OR  result not fully reduced (r2 >= q)
    bad = Or(ULT(x, tq), UGE(r2, q))
    return prove_unsat("barrett", [pre, bad])


# ===========================================================================
# TIER 1 (E) conflict-free memory map  (conflict_free_memory_map.v +
#            address_generator.v): bank = parity of the 10-bit address,
#            offset = address >> 1.  The two butterfly operands at stage p
#            differ in exactly bit p, so their parities (banks) differ.
# ===========================================================================
def _parity10(a):
    p = Extract(0, 0, a)
    for i in range(1, 10):
        p = p ^ Extract(i, i, a)
    return p                                        # BV1 = bank number


def check_cfmap_bijection():
    # (bank, offset) is injective over the full 10-bit address space.
    a = BitVec('a', 10)
    b = BitVec('b', 10)
    same_bank = _parity10(a) == _parity10(b)
    same_off = Extract(9, 1, a) == Extract(9, 1, b)        # addr >> 1
    return prove_unsat("cfmap_bijection", [a != b, same_bank, same_off])


def check_cfmap_conflict_free():
    # For EVERY power-of-two stride 2^p (p=0..9): operand0 (bit p = 0) and its
    # partner operand1 = operand0 | (1<<p) land in DIFFERENT banks.
    for p in range(10):
        a = BitVec('a_%d' % p, 10)
        mask = BitVecVal(1 << p, 10)
        op0 = a & ~mask                              # force bit p = 0 (lower)
        op1 = op0 | mask                             # partner at stride 2^p
        ok, msg = prove_unsat(
            "cfmap_stride_2^%d" % p,
            [_parity10(op0) == _parity10(op1)],      # same bank -> must be UNSAT
        )
        if not ok:
            return False, msg
    return True, ""


# ===========================================================================
# TIER 2 reference: the source's EXACT functions (poly_mult_radix_2.py),
# parameterised by q and the twiddle table.
# ===========================================================================
def op21(a, q):
    if a & 1 == 0:
        r = (a >> 1) % q
    else:
        r = ((a >> 1) + ((q + 1) >> 1)) % q
    return r


def DIT_NR_NTT(a, w_rom, q):
    n = len(a)
    log_n = n.bit_length() - 1
    r = 1
    for p in range(log_n - 1, -1, -1):
        J = 1 << p
        for k in range(n // (2 * J)):
            w = w_rom[r]
            r += 1
            for j in range(J):
                u = a[k * 2 * J + j] % q
                t = (a[k * 2 * J + j + J] * w) % q
                a[k * 2 * J + j] = (u + t) % q
                a[k * 2 * J + j + J] = (u - t) % q
    return a


def DIF_RN_INTT(a, w_rom, q):
    n = len(a)
    log_n = n.bit_length() - 1
    r = len(w_rom) - 1
    for i in range(log_n):
        J = 1 << i
        for k in range(n // (2 * J)):
            w = w_rom[r]
            r -= 1
            for j in range(J):
                u = a[k * 2 * J + j] % q
                t = a[k * 2 * J + j + J] % q
                a[k * 2 * J + j] = (op21(u + t, q)) % q
                a[k * 2 * J + j + J] = (op21(t - u, q) * w) % q
    return a


def pwm(x, y, q):
    return [(x[i] * y[i]) % q for i in range(len(x))]


def bitrev(x, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (x & 1)
        x >>= 1
    return r


def build_wrom(Ns, psi, q):
    """Negacyclic twiddle table in the source's bit-reversed layout:
       w_rom[i] = psi^bitrev(i, log2 Ns).  (Matches kesai-power table at N=1024.)"""
    logn = Ns.bit_length() - 1
    return [pow(psi, bitrev(i, logn), q) for i in range(Ns)]


def negacyclic_conv(a, b, q):
    """Independent golden: product in Z_q[x]/(x^N + 1)."""
    N = len(a)
    c = [0] * N
    for i in range(N):
        for j in range(N):
            k = i + j
            v = a[i] * b[j]
            if k >= N:
                k -= N
                v = -v
            c[k] = (c[k] + v) % q
    return c


def small_root(Ns, q):
    """psi = 7^(2048/(2*Ns)) is a primitive 2N-th root mod q (order(7)=2048)."""
    psi = pow(KESAI, 2048 // (2 * Ns), q)
    if pow(psi, Ns, q) != q - 1 or pow(psi, 2 * Ns, q) != 1:
        return None
    return psi


# ---- (F) invertibility on the FULL basis (proves INTT o NTT = id) ----------
def check_invertibility(Ns):
    q = Q
    psi = small_root(Ns, q)
    if psi is None:
        return False, "invertibility N=%d: 7 is not a primitive 2N-th root" % Ns
    w = build_wrom(Ns, psi, q)
    for idx in range(Ns):
        e = [0] * Ns
        e[idx] = 1
        spec = DIT_NR_NTT(e[:], w, q)
        back = DIF_RN_INTT(spec[:], w, q)
        if back != e:
            return False, ("invertibility N=%d: INTT(NTT(e_%d)) = %s != e_%d"
                           % (Ns, idx, back, idx))
    return True, ""


# ---- (G) convolution theorem on all basis pairs (proves diagonalisation) ---
def check_convolution(Ns):
    q = Q
    psi = small_root(Ns, q)
    if psi is None:
        return False, "convolution N=%d: 7 is not a primitive 2N-th root" % Ns
    w = build_wrom(Ns, psi, q)
    for i in range(Ns):
        ei = [0] * Ns
        ei[i] = 1
        fi = DIT_NR_NTT(ei[:], w, q)
        for j in range(Ns):
            ej = [0] * Ns
            ej[j] = 1
            fj = DIT_NR_NTT(ej[:], w, q)
            got = DIF_RN_INTT(pwm(fi, fj, q), w, q)
            gold = negacyclic_conv(ei, ej, q)
            if got != gold:
                return False, ("convolution N=%d: INTT(NTT(e_%d).NTT(e_%d)) = %s"
                               " != negacyclic %s" % (Ns, i, j, got, gold))
    return True, ""


# ---- production-size grounding: round-trip on the REAL source table --------
def check_production_roundtrip():
    q = Q
    N = 1024
    w = build_wrom(N, KESAI, q)                     # psi = kesai = 7, bit-reversed
    # Grounding cross-check: the derived table reproduces the source w_rom.
    src_spot = {0: 1, 1: 10810, 2: 7143, 3: 4043, 1023: 3511}
    for i, v in src_spot.items():
        if w[i] != v:
            return False, ("production table: derived w_rom[%d]=%d != source %d"
                           % (i, w[i], v))
    rng = random.Random(0)
    vecs = [
        [0] * N,                                     # zero
        [1] + [0] * (N - 1),                         # e_0
        [0] * (N - 1) + [1],                         # e_{N-1}
        [1] * N,                                     # all ones
        [i % q for i in range(N)],                   # ramp
    ]
    vecs[0][0] = 0
    for _ in range(8):
        vecs.append([rng.randrange(q) for _ in range(N)])
    for vi, v in enumerate(vecs):
        back = DIF_RN_INTT(DIT_NR_NTT(v[:], w, q), w, q)
        ref = [c % q for c in v]
        if back != ref:
            return False, ("production roundtrip: INTT(NTT(v_%d)) != v_%d" % (vi, vi))
    return True, ""


# ===========================================================================
def main():
    checks = [
        ("modular_add == (x+y) mod q  [full 14-bit domain, z3]", check_modular_add),
        ("modular_sub == (x-y) mod q  [full 14-bit domain, z3]", check_modular_sub),
        ("modular_half == x/2 mod q   [full 14-bit domain, z3]", check_modular_half),
        ("Barrett == x mod q          [x in [0,(q-1)^2], z3]", check_barrett),
        ("conflict-free map: (bank,offset) bijective [z3]", check_cfmap_bijection),
        ("conflict-free map: distinct banks every stride [z3]", check_cfmap_conflict_free),
        ("INTT o NTT = identity        [full basis, N=8]", lambda: check_invertibility(8)),
        ("INTT o NTT = identity        [full basis, N=16]", lambda: check_invertibility(16)),
        ("diagonalises negacyclic conv [basis pairs, N=8]", lambda: check_convolution(8)),
        ("diagonalises negacyclic conv [basis pairs, N=16]", lambda: check_convolution(16)),
        ("production round-trip on REAL source table [N=1024]", check_production_roundtrip),
    ]
    for label, fn in checks:
        try:
            ok, msg = fn()
        except Exception as exc:
            print("FAIL: %s raised %r" % (label, exc))
            sys.exit(1)
        if not ok:
            print("FAIL: %s" % msg)
            sys.exit(1)
        sys.stderr.write("ok  %s\n" % label)
    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
