#!/usr/bin/env python3
"""
Reverse-implementation of the CFNTT Radix-2/4 NTT Multiplication Accelerator
from its scene descriptor (functional fields only).

Implemented & self-checked:
  * Barrett modular reduction  (mu=21843, k=28, q=12289)  -- proven == mod by z3
  * Modular add / sub                                       -- proven correct by z3
  * Conflict-free interleaved memory map b(i)=(i+(i>>3))%8, o(i)=i>>3
        - proven a bijection (exhaustive) and invertible (write-back addressing)
        - proven every aligned block of 8 consecutive indices spans all 8 banks
  * Negacyclic NTT (CT forward) + INTT (GS inverse) datapath, modmul via Barrett
        - INTT(NTT(a)) == a               (identity property)
        - NTT-based multiply == schoolbook negacyclic poly mult mod (x^N+1, q)
        - independent direct-DFT golden cross-checks the root choice
Prints VERIFIED / exit 0 on success, else FAIL: <reason> / exit 1.
"""
import sys, random
from z3 import (BitVec, BitVecVal, LShR, If, UGE, ULT, URem, And, Not, Solver,
                sat)

# ----------------------------------------------------------------------------
# Parameters (authoritative spec fields)
# ----------------------------------------------------------------------------
N        = 1024          # transform length          (metadata.spec.params.N)
LOGN     = 10            # log2 N
Q        = 12289         # modulus q                 (mod_red params)
K_SHIFT  = 28            # Barrett shift k
MU       = 21843         # Barrett mu = floor(2^28/q)
N_INV    = 8857          # N^-1 mod q                (intt_scale spec)
BANKS    = 8             # interleaved BRAM banks / parallel butterfly units
COEFF_BITS = 14

def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)

# ----------------------------------------------------------------------------
# Sanity of the authoritative constants
# ----------------------------------------------------------------------------
if MU != (1 << K_SHIFT) // Q:
    fail(f"mu mismatch: spec {MU} != floor(2^{K_SHIFT}/q) {(1<<K_SHIFT)//Q}")
if N_INV != pow(N, Q - 2, Q):
    fail(f"N^-1 mismatch: spec {N_INV} != {pow(N, Q-2, Q)}")

# negacyclic root: smallest psi of multiplicative order 2N=2048 (GUESS: flavor+root)
PSI = None
for c in range(2, Q):
    if pow(c, 2 * N, Q) == 1 and pow(c, N, Q) == Q - 1:
        PSI = c
        break
if PSI is None:
    fail("no primitive 2N-th root of unity mod q found")
PSIINV = pow(PSI, Q - 2, Q)
if pow(PSI, 2 * N, Q) != 1 or pow(PSI, N, Q) != Q - 1:
    fail("psi does not satisfy psi^2048==1, psi^1024==-1")

# ----------------------------------------------------------------------------
# Hardware datapath primitives (plain Python)
# ----------------------------------------------------------------------------
def barrett(x):
    """mod_red_mult + mod_red_subshift: reduce x in [0,q^2) to [0,q)."""
    t = (x * MU) >> K_SHIFT          # Barrett quotient estimate
    r = x - t * Q                    # r = x - t*q
    while r >= Q:                    # <=2 conditional subtractions (spec)
        r -= Q
    return r

def madd(a, b):                      # symmetric modular adder (sum path)
    s = a + b
    return s - Q if s >= Q else s

def msub(a, b):                      # symmetric modular subtractor (diff path)
    return a - b if a >= b else a - b + Q

# conflict-free interleaved memory map (crossbar / addr_gen spec)
def bank(i):   return (i + (i >> 3)) % BANKS
def offset(i): return i >> 3
def recover(b, o):                   # write-back: (bank,offset) -> index
    return 8 * o + ((b - o) % BANKS)

# ----------------------------------------------------------------------------
# Twiddle tables (psi^brv(k)) for the merged negacyclic NTT
# ----------------------------------------------------------------------------
def brv(i, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (i & 1)
        i >>= 1
    return r

PSI_TAB    = [pow(PSI,    brv(i, LOGN), Q) for i in range(N)]
PSIINV_TAB = [pow(PSIINV, brv(i, LOGN), Q) for i in range(N)]

def ntt_fast(a):
    """Cooley-Tukey forward negacyclic NTT (natural in, bit-reversed out).
    Modular multiply realised by the Barrett datapath; +/- by madd/msub."""
    a = list(a); m = 1; t = N
    while m < N:
        t //= 2
        for i in range(m):
            j1 = 2 * i * t
            S = PSI_TAB[m + i]
            for j in range(j1, j1 + t):
                U = a[j]
                V = barrett(a[j + t] * S)
                a[j]     = madd(U, V)
                a[j + t] = msub(U, V)
        m *= 2
    return a

def intt_fast(a):
    """Gentleman-Sande inverse NTT (bit-reversed in, natural out) + N^-1."""
    a = list(a); t = 1; m = N
    while m > 1:
        j1 = 0; h = m // 2
        for i in range(h):
            S = PSIINV_TAB[h + i]
            for j in range(j1, j1 + t):
                U = a[j]; V = a[j + t]
                a[j]     = madd(U, V)
                a[j + t] = barrett(msub(U, V) * S)
            j1 += 2 * t
        t *= 2; m //= 2
    return [barrett(x * N_INV) for x in a]

def ntt_mul(a, b):
    A = ntt_fast(a); B = ntt_fast(b)
    C = [barrett(A[i] * B[i]) for i in range(N)]
    return intt_fast(C)

# ----------------------------------------------------------------------------
# Independent golden models
# ----------------------------------------------------------------------------
def negacyclic_mul(a, b):
    """Golden: schoolbook polynomial multiply mod (x^N + 1, q)."""
    c = [0] * N
    for i in range(N):
        ai = a[i]
        if ai == 0:
            continue
        for j in range(N):
            v = ai * b[j] % Q
            k = i + j
            if k < N:
                c[k] = (c[k] + v) % Q
            else:
                c[k - N] = (c[k - N] - v) % Q
    return c

# direct negacyclic DFT golden (independent of the fast butterfly code)
_PW    = [pow(PSI,    e, Q) for e in range(2 * N)]
_PWINV = [pow(PSIINV, e, Q) for e in range(2 * N)]
def ntt_direct(a):
    return [sum(a[i] * _PW[(i * (2 * k + 1)) % (2 * N)] for i in range(N)) % Q
            for k in range(N)]
def intt_direct(A):
    out = []
    for i in range(N):
        s = sum(A[k] * _PWINV[((2 * k + 1) * i) % (2 * N)] for k in range(N))
        out.append(s * N_INV % Q)
    return out

# ----------------------------------------------------------------------------
# z3 proofs: Barrett == mod, and modular add/sub over their full domains
# ----------------------------------------------------------------------------
def prove_barrett():
    x = BitVec('x', 64)
    mu = BitVecVal(MU, 64); q = BitVecVal(Q, 64)
    t  = LShR(x * mu, K_SHIFT)
    r0 = x - t * q
    r1 = If(UGE(r0, q), r0 - q, r0)
    r2 = If(UGE(r1, q), r1 - q, r1)
    good = And(r2 == URem(x, q),      # result equals true remainder
               ULT(r0, 3 * Q))        # <=2 corrections actually suffice
    s = Solver()
    s.add(ULT(x, BitVecVal(Q * Q, 64)))   # valid input domain [0, q^2)
    s.add(Not(good))
    if s.check() == sat:
        return s.model()[x]
    return None

def prove_modaddsub():
    a = BitVec('a', 32); b = BitVec('b', 32)
    q = BitVecVal(Q, 32)
    add = If(UGE(a + b, q), a + b - q, a + b)
    sub = If(ULT(a, b), a + q - b, a - b)
    bad = Or = Not(And(add == URem(a + b, q),
                       sub == URem(a + q - b, q)))
    s = Solver()
    s.add(ULT(a, q), ULT(b, q))
    s.add(bad)
    if s.check() == sat:
        m = s.model()
        return (m[a], m[b])
    return None

# z3 'Or' name collision guard (we only used And/Not above); import Or properly
from z3 import Or  # noqa: E402  (kept explicit for clarity)

# ----------------------------------------------------------------------------
# Run all checks
# ----------------------------------------------------------------------------
def main():
    random.seed(12345)

    # 1) Barrett reduction proven over ALL inputs in [0, q^2)
    cex = prove_barrett()
    if cex is not None:
        fail(f"Barrett != mod at x={cex}")

    # 2) modular add/sub proven over ALL [0,q)^2
    cex = prove_modaddsub()
    if cex is not None:
        a, b = cex
        fail(f"mod add/sub wrong at a={a}, b={b}")

    # 3) conflict-free memory map: bijection + invertible + bank coverage
    seen = {}
    for i in range(N):
        key = (bank(i), offset(i))
        if key in seen:
            fail(f"bank map collision: i={i} and i={seen[key]} -> {key}")
        seen[key] = i
        if recover(bank(i), offset(i)) != i:
            fail(f"bank map not invertible at i={i}")
    for blk in range(N // BANKS):
        banks = {bank(8 * blk + r) for r in range(BANKS)}
        if banks != set(range(BANKS)):
            fail(f"block {blk} does not span all banks: {sorted(banks)}")

    # 4) direct-DFT golden self-consistency (validates negacyclic root choice)
    v = [random.randrange(Q) for _ in range(N)]
    if intt_direct(ntt_direct(v)) != v:
        fail("direct negacyclic NTT/INTT is not the identity")

    # 5) fast datapath identity: INTT(NTT(a)) == a
    edge = [
        [0] * N,
        [1] * N,
        [Q - 1] * N,
        [1] + [0] * (N - 1),                 # delta at 0
        [0, 1] + [0] * (N - 2),              # delta at 1
    ]
    rand_vecs = [[random.randrange(Q) for _ in range(N)] for _ in range(3)]
    for a in edge + rand_vecs:
        if intt_fast(ntt_fast(a)) != a:
            fail("INTT(NTT(a)) != a")

    # 6) NTT-based multiply == schoolbook negacyclic multiply (golden)
    test_pairs = [
        ([1] + [0] * (N - 1), rand_vecs[0]),         # identity element
        (rand_vecs[0], rand_vecs[1]),
        (rand_vecs[1], rand_vecs[2]),
        ([Q - 1] + [0] * (N - 1), rand_vecs[2]),     # negation by -1
    ]
    for a, b in test_pairs:
        got  = ntt_mul(a, b)
        want = negacyclic_mul(a, b)
        if got != want:
            k = next(i for i in range(N) if got[i] != want[i])
            fail(f"ntt_mul != negacyclic_mul at coeff {k}: "
                 f"got {got[k]} want {want[k]}")

    print("VERIFIED")
    sys.exit(0)

if __name__ == "__main__":
    main()
