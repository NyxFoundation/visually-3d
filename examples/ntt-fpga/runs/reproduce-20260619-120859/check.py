#!/usr/bin/env python3
"""
CFNTT Radix-2/4 NTT Multiplication Accelerator (FPGA) -- reverse-implemented
from a scene spec, as runnable Python, with a self-checking verifier.

Authoritative spec values used verbatim:
  N=1024, q=12289, psi=1945 (order 2048, negacyclic), omega=psi^2=10302,
  Ninv=1024^-1=12277, Barrett mu=floor(2^28/q)=21843, k=28,
  bank(i)=(i^(i>>3)^(i>>6)^(i>>9))&7, offset(i)=i>>3, j=psi^512.

The functional core is a negacyclic NTT (CT/DIT) + INTT (GS/DIF) datapath; the
radix-4 fused butterfly (2 mults via W3=W1*(W2*x3) chaining) is verified as a
local equivalence to two radix-2 stages. Barrett reduction is proven correct
with z3 over its full legal input range [0, q^2). Conflict-free bank mapping is
verified exhaustively for the butterfly operand pairs and as a storage bijection.
"""
import os, sys, random
from z3 import Solver, Int, Or, sat, unsat

# ----------------------------------------------------------------------------
# Authoritative parameters (from spec.metadata.spec.params)
# ----------------------------------------------------------------------------
N      = 1024
Q      = 12289
PSI    = 1945
OMEGA  = 10302
NINV   = 12277
MU     = 21843
K      = 28
LOGN   = N.bit_length() - 1   # 10

def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)

# ----------------------------------------------------------------------------
# Barrett modular reduction (mod_red_mult -> mod_red_subshift)
#   t = (x*mu) >> k ; r = x - t*q ; up to 2 conditional subtractions
# Valid for x in [0, q^2) (product of two reduced operands).  [spec authoritative]
# ----------------------------------------------------------------------------
def barrett(x, q=Q, mu=MU, k=K):
    t = (x * mu) >> k
    r = x - t * q
    if r >= q: r -= q
    if r >= q: r -= q
    return r

def mulmod(a, b, q=Q):
    # a,b in [0,q) -> a*b < q^2 < 2^28, Barrett-reducible
    return barrett(a * b, q)

# ----------------------------------------------------------------------------
# Conflict-free memory mapping (crossbar_network / addr_gen_unit)  [authoritative]
# ----------------------------------------------------------------------------
def bank(i):
    return (i ^ (i >> 3) ^ (i >> 6) ^ (i >> 9)) & 7
def offset(i):
    return i >> 3

# ----------------------------------------------------------------------------
# Negacyclic NTT / INTT datapath (radix-2 lane primitives)
#   GUESS: CT/DIT forward + GS/DIF inverse with bit-reversed psi-power table.
# ----------------------------------------------------------------------------
def brv(x, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (x & 1); x >>= 1
    return r

def _psi_table(psi, q, n, logn):
    return [pow(psi, brv(i, logn), q) for i in range(n)]

def ntt(a, psi=PSI, q=Q):
    n = len(a); logn = n.bit_length() - 1
    a = list(a)
    T = _psi_table(psi, q, n, logn)
    t = n; m = 1
    while m < n:
        t //= 2
        for i in range(m):
            j1 = 2 * i * t
            S = T[m + i]
            for j in range(j1, j1 + t):
                U = a[j]
                V = mulmod(a[j + t], S, q)
                a[j]     = (U + V) % q
                a[j + t] = (U - V) % q
        m *= 2
    return a  # bit-reversed order

def intt(a, psi=PSI, q=Q):
    n = len(a); logn = n.bit_length() - 1
    a = list(a)
    psiinv = pow(psi, q - 2, q)
    Tinv = _psi_table(psiinv, q, n, logn)
    ninv = pow(n, q - 2, q)
    t = 1; m = n
    while m > 1:
        j1 = 0; h = m // 2
        for i in range(h):
            S = Tinv[h + i]
            for j in range(j1, j1 + t):
                U = a[j]; V = a[j + t]
                a[j]     = (U + V) % q
                a[j + t] = mulmod((U - V) % q, S, q)
            j1 += 2 * t
        t *= 2; m //= 2
    return [mulmod(v, ninv, q) for v in a]  # natural order

def pointwise(x, y, q=Q):
    return [mulmod(x[i], y[i], q) for i in range(len(x))]

# Independent golden: schoolbook negacyclic convolution mod (x^n + 1).
def negconv(a, b, q=Q):
    n = len(a); c = [0] * n
    for i in range(n):
        ai = a[i]
        if ai == 0: continue
        for jx in range(n):
            v = ai * b[jx] % q
            k = i + jx
            if k < n: c[k] = (c[k] + v) % q
            else:     c[k - n] = (c[k - n] - v) % q
    return c

# ----------------------------------------------------------------------------
# Radix-4 fused butterfly (r4_fuse / config_radix_selector / exploded view)
#   2 physical mults: b'=W1*x1, c'=W2*x2, d'=W1*(W2*x3) [chained -> W3=w^3]
#   j = psi^512 (j^2 = -1).  GUESS: sign placement taken verbatim from spec.
# ----------------------------------------------------------------------------
def radix4_bu(x0, x1, x2, x3, w, q, j):
    W1 = w; W2 = (w * w) % q
    b = (W1 * x1) % q
    c = (W2 * x2) % q
    d = (W1 * ((W2 * x3) % q)) % q          # chained third product (2 mults total)
    y0 = (x0 + b + c + d) % q
    y1 = (x0 + j * b - c - j * d) % q
    y2 = (x0 - b + c - d) % q
    y3 = (x0 - j * b - c + j * d) % q
    return (y0, y1, y2, y3)

# Independent golden: two radix-2 DIT stages over the same 4 (twiddled) points.
def radix4_golden_two_r2(x0, x1, x2, x3, w, q, j):
    t0 = x0
    t1 = (w * x1) % q
    t2 = (w * w % q * x2) % q
    t3 = (w * w % q * w % q * x3) % q
    G0 = (t0 + t2) % q; G1 = (t0 - t2) % q
    H0 = (t1 + t3) % q; H1 = (t1 - t3) % q
    y0 = (G0 + H0) % q
    y1 = (G1 + j * H1) % q
    y2 = (G0 - H0) % q
    y3 = (G1 - j * H1) % q
    return (y0, y1, y2, y3)

# ----------------------------------------------------------------------------
# schedule_controller FSM (reconstructed transition graph)  [spec: reconstructed]
# ----------------------------------------------------------------------------
FSM_STATES = ["IDLE","LOAD","STAGE_LOOP","TWIDDLE_FETCH","BUTTERFLY","REDUCE",
              "WRITEBACK","INTT_STAGE_LOOP","SCALE_N_INV","DRAIN","DONE"]
FSM_EDGES = [
    ("IDLE","LOAD"),("LOAD","STAGE_LOOP"),("STAGE_LOOP","TWIDDLE_FETCH"),
    ("TWIDDLE_FETCH","BUTTERFLY"),("BUTTERFLY","REDUCE"),("REDUCE","WRITEBACK"),
    ("WRITEBACK","TWIDDLE_FETCH"),("WRITEBACK","STAGE_LOOP"),
    ("STAGE_LOOP","INTT_STAGE_LOOP"),("STAGE_LOOP","DRAIN"),
    ("INTT_STAGE_LOOP","SCALE_N_INV"),("SCALE_N_INV","DRAIN"),
    ("DRAIN","DONE"),("DONE","IDLE"),
]

# ============================================================================
# VERIFICATION
# ============================================================================
def check_constants():
    if pow(PSI, 2048, Q) != 1:            fail("psi^2048 != 1 mod q")
    if pow(PSI, 1024, Q) != Q - 1:        fail("psi^1024 != -1 mod q (not negacyclic)")
    if (PSI * PSI) % Q != OMEGA:          fail("omega != psi^2")
    if pow(OMEGA, 1024, Q) != 1 or pow(OMEGA, 512, Q) == 1:
        fail("omega is not a primitive 1024th root")
    if (N * NINV) % Q != 1:               fail("Ninv != 1024^-1 mod q")
    if pow(N, Q - 2, Q) != NINV:          fail("Ninv mismatch vs Fermat inverse")
    if MU != (1 << K) // Q:               fail("mu != floor(2^28/q)")
    if pow(11, 6, Q) != PSI:              fail("psi != 11^6 mod q (generator g=11)")
    j = pow(PSI, 512, Q)
    if (j * j) % Q != Q - 1:              fail("j=psi^512 does not satisfy j^2=-1")
    if Q * Q >= (1 << K):                 fail("q^2 not < 2^28 (Barrett k too small)")
    # loop bounds
    if LOGN != 10:                        fail("log2(N) != 10")

def check_barrett_z3():
    # Prove: for all x in [0, q^2), 0 <= x - floor(x*mu/2^28)*q < 3q.
    # Then <=2 conditional subtractions land r in [0,q) and r == x mod q
    # (since x - t*q is congruent to x). Model floor div with a fresh qh.
    x = Int('x'); qh = Int('qh')
    s = Solver()
    s.add(x >= 0, x < Q * Q)
    s.add(qh * (1 << K) <= x * MU, x * MU < (qh + 1) * (1 << K))
    r = x - qh * Q
    s.add(Or(r < 0, r >= 3 * Q))          # negation of the bound
    res = s.check()
    if res == sat:
        m = s.model()
        fail("Barrett bound violated at x=%s" % m[x])
    if res != unsat:
        fail("Barrett z3 query inconclusive (%s)" % res)
    # spot-check the executable barrett against ground truth at edges + random
    for xv in [0, 1, Q - 1, Q, Q + 1, Q * Q - 1, 268435455 % (Q*Q)]:
        if barrett(xv) != xv % Q:
            fail("barrett(%d)=%d != %d" % (xv, barrett(xv), xv % Q))
    rng = random.Random(1)
    for _ in range(20000):
        xv = rng.randrange(Q * Q)
        if barrett(xv) != xv % Q:
            fail("barrett(%d)=%d != %d" % (xv, barrett(xv), xv % Q))

def check_bank_mapping():
    # (bank, offset) is a bijection on [0, N): valid conflict-free storage.
    seen = set()
    for i in range(N):
        key = (bank(i), offset(i))
        if key in seen:
            fail("(bank,offset) collision at i=%d -> %s" % (i, key))
        seen.add(key)
    if len(seen) != N:
        fail("(bank,offset) not a bijection over [0,N)")
    # Butterfly operand pairs (j, j+t) at every DIT stage land in distinct banks
    # for ALL strides incl. 512 -> conflict-free per-butterfly.
    t = N
    while t > 1:
        t //= 2
        j1 = 0
        while j1 < N:
            for j in range(j1, j1 + t):
                if bank(j) == bank(j + t):
                    fail("bank conflict stride=%d: bank(%d)==bank(%d)=%d"
                         % (t, j, j + t, bank(j)))
            j1 += 2 * t

def check_radix4():
    # Exhaustive over GF(17): impl and golden are GF(q)-linear in (x0..x3) for
    # fixed w, so agreement on the standard basis {e0,e1,e2,e3} + zero proves
    # full equivalence for every w in the field. j=4 (4^2=16=-1 mod 17).
    qs, js = 17, 4
    if (js * js) % qs != qs - 1: fail("test field: j^2 != -1")
    basis = [(0,0,0,0),(1,0,0,0),(0,1,0,0),(0,0,1,0),(0,0,0,1)]
    for w in range(qs):
        for (a,b,c,d) in basis:
            if radix4_bu(a,b,c,d,w,qs,js) != radix4_golden_two_r2(a,b,c,d,w,qs,js):
                fail("radix-4 BU != two-radix-2 over GF(17) at w=%d,x=%s"
                     % (w, (a,b,c,d)))
    # Real-q randomized spot check with the actual rotator j=psi^512.
    j = pow(PSI, 512, Q)
    rng = random.Random(2)
    for _ in range(4000):
        a,b,c,d,w = (rng.randrange(Q) for _ in range(5))
        if radix4_bu(a,b,c,d,w,Q,j) != radix4_golden_two_r2(a,b,c,d,w,Q,j):
            fail("radix-4 BU mismatch over GF(q) at (%d,%d,%d,%d,%d)"%(a,b,c,d,w))

def check_ntt_small():
    # Structural: round-trip identity + negacyclic-convolution identity at
    # small sizes against the schoolbook golden (own field params, see GUESS).
    cases = [(2,17,4),(4,17,9),(8,17,3)]
    for (n,q,psi) in cases:
        if pow(psi, n, q) != q - 1:  fail("small psi not negacyclic n=%d"%n)
        rng = random.Random(100 + n)
        for _ in range(30):
            a = [rng.randrange(q) for _ in range(n)]
            if intt(ntt(a, psi, q), psi, q) != a:
                fail("round-trip failed at n=%d"%n)
            b = [rng.randrange(q) for _ in range(n)]
            got = intt(pointwise(ntt(a,psi,q), ntt(b,psi,q), q), psi, q)
            exp = negconv(a, b, q)
            if got != exp:
                fail("negacyclic conv mismatch n=%d: %s != %s"%(n,got,exp))

def check_ntt_full():
    rng = random.Random(7)
    # Full-size round-trip (O(N log N)) -- the INTT(NTT)=identity property.
    for _ in range(8):
        a = [rng.randrange(Q) for _ in range(N)]
        if intt(ntt(a)) != a:
            fail("N=1024 round-trip (INTT.NTT != id) failed")
    # Full-size negacyclic multiply vs schoolbook, kept cheap via SPARSE a.
    for _ in range(5):
        a = [0] * N
        for _ in range(6):
            a[rng.randrange(N)] = rng.randrange(Q)
        b = [rng.randrange(Q) for _ in range(N)]
        got = intt(pointwise(ntt(a), ntt(b)))
        exp = negconv(a, b)            # O(nnz*N), sparse -> fast & independent
        if got != exp:
            fail("N=1024 negacyclic multiply != schoolbook (poly-mult identity)")

def check_fsm():
    states = set(FSM_STATES)
    adj = {s: [] for s in states}
    for u, v in FSM_EDGES:
        if u not in states or v not in states:
            fail("FSM edge references unknown state: %s->%s" % (u, v))
        adj[u].append(v)
    # reachability from IDLE
    seen = set(); stack = ["IDLE"]
    while stack:
        s = stack.pop()
        if s in seen: continue
        seen.add(s)
        stack.extend(adj[s])
    if seen != states:
        fail("FSM has unreachable states: %s" % (states - seen))
    if "DONE" not in seen:
        fail("FSM cannot reach DONE")
    if "IDLE" not in adj["DONE"]:
        fail("FSM DONE does not return to IDLE on ack")
    # SCALE_N_INV must be on the INTT branch only (reached via INTT_STAGE_LOOP)
    preds = [u for (u, v) in FSM_EDGES if v == "SCALE_N_INV"]
    if preds != ["INTT_STAGE_LOOP"]:
        fail("SCALE_N_INV not exclusively on the INTT path: %s" % preds)

def main():
    check_constants()
    check_barrett_z3()
    check_bank_mapping()
    check_radix4()
    check_ntt_small()
    check_ntt_full()
    check_fsm()
    if os.environ.get("DEEP_VERIFY") == "1":
        # Optional deep check: dense full-size negacyclic multiply (O(N^2)).
        rng = random.Random(99)
        a = [rng.randrange(Q) for _ in range(N)]
        b = [rng.randrange(Q) for _ in range(N)]
        if intt(pointwise(ntt(a), ntt(b))) != negconv(a, b):
            fail("DEEP: dense N=1024 negacyclic multiply mismatch")
    print("VERIFIED")
    sys.exit(0)

if __name__ == "__main__":
    main()
