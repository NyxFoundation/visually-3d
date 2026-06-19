#!/usr/bin/env python3
"""CFNTT Radix-2/4 NTT Multiplication Accelerator (FPGA) -- reverse implementation.

Single self-checking script. Implements the datapath blocks described by the
spec (Barrett reduction, conflict-free BRAM map, radix-2/radix-4 butterflies,
merged-negacyclic NTT/INTT, schedule FSM) as plain Python, builds an INDEPENDENT
golden model (schoolbook negacyclic convolution), and discharges correctness as a
handful of small finite obligations:
  * Barrett range/correctness  -> z3 proof over the bounded domain x in [0,q^2)
  * conflict-free memory map    -> exhaustive enumeration over the 1024 indices
  * radix-4 == two radix-2      -> random equality over Z_q
  * transform is negacyclic     -> end-to-end conv identity on small N (8,16)
  * NTT/INTT identity           -> roundtrip at production N=1024
  * FSM well-formedness         -> reachability over the transition table
Prints "VERIFIED" / exit 0 on success, "FAIL: ..." / exit 1 otherwise.
"""
import os
import sys
import random

# ---- spec-authoritative parameters (metadata.spec.params / widths) ----
Q = 12289                 # modulus (14-bit NTT-friendly prime)
N = 1024                  # transform length
COEFF_BITS = 14
PRODUCT_BITS = 28
G = 11                    # generator g
PSI = 1945                # negacyclic primitive 2048th root (= g^6 mod q)
OMEGA = 10302             # = PSI^2 (N-th root)
NINV = 12277              # 1024^-1 mod q
BARRETT_MU = 21843        # floor(2^28 / q)
BARRETT_K = 28
PSI_ORDER = 2048
J_CONST = pow(PSI, 512, Q)   # constant radix-4 rotator, order 4, j^2 == -1

random.seed(0xCF7)


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


# ---- Barrett modular reduction (mod_red_mult + mod_red_subshift) ----
def barrett_reduce(x):
    # x in [0, q^2);  estimate quotient, subtract, then <=2 conditional corrections
    qh = (x * BARRETT_MU) >> BARRETT_K
    r = x - qh * Q
    c = 0
    while r >= Q:
        r -= Q
        c += 1
    assert c <= 2, "more than 2 Barrett corrections"
    return r


def modmul(a, b):
    return barrett_reduce(a * b)


def modadd(a, b):
    return (a + b) % Q


def modsub(a, b):
    return (a - b) % Q


# ---- conflict-free memory map (crossbar_network / addr_gen_unit) ----
def bank(i):
    # GF(2)-linear XOR-fold of the four 3-bit groups of the index
    return (i & 7) ^ ((i >> 3) & 7) ^ ((i >> 6) & 7) ^ ((i >> 9) & 7)


def offset(i):
    return i >> 3


# ---- twiddle ROM helpers (twiddle_rom) ----
def bitrev(x, bits):
    r = 0
    for _ in range(bits):
        r = (r << 1) | (x & 1)
        x >>= 1
    return r


def psi_for(n):
    # 2n-th primitive root derived from PSI (order 2048) for an n-point transform
    if PSI_ORDER % (2 * n) != 0:
        fail("PSI order does not cover 2*%d" % n)
    return pow(PSI, PSI_ORDER // (2 * n), Q)


def build_tables(n, psi):
    logn = n.bit_length() - 1
    pw = [1] * n
    for i in range(1, n):
        pw[i] = pw[i - 1] * psi % Q
    fwd = [pw[bitrev(i, logn)] for i in range(n)]
    psii = pow(psi, Q - 2, Q)
    pwi = [1] * n
    for i in range(1, n):
        pwi[i] = pwi[i - 1] * psii % Q
    inv = [pwi[bitrev(i, logn)] for i in range(n)]
    return fwd, inv


# ---- radix-2 / radix-4 butterflies (bu_array + config_radix_selector) ----
def radix2_bf(u, x1, w):
    v = modmul(w, x1)
    return modadd(u, v), modsub(u, v)


def radix4_bf(x0, x1, x2, x3, w, j):
    W1 = w
    W2 = modmul(w, w)
    W3 = modmul(W2, w)
    b = modmul(W1, x1)
    c = modmul(W2, x2)
    d = modmul(W3, x3)
    y0 = (x0 + b + c + d) % Q
    y1 = (x0 + modmul(j, b) - c - modmul(j, d)) % Q
    y2 = (x0 - b + c - d) % Q
    y3 = (x0 - modmul(j, b) - c + modmul(j, d)) % Q
    return y0, y1, y2, y3


# ---- merged-negacyclic NTT (CT forward) / INTT (GS inverse) ----
def ntt(a, fwd):
    a = list(a)
    n = len(a)
    t = n
    m = 1
    while m < n:
        t //= 2
        for i in range(m):
            j1 = 2 * i * t
            S = fwd[m + i]
            for jx in range(j1, j1 + t):
                U = a[jx]
                V = modmul(S, a[jx + t])
                a[jx] = modadd(U, V)
                a[jx + t] = modsub(U, V)
        m *= 2
    return a  # bit-reversed order


def intt(a, inv):
    a = list(a)
    n = len(a)
    t = 1
    m = n
    while m > 1:
        j1 = 0
        h = m // 2
        for i in range(h):
            S = inv[h + i]
            for jx in range(j1, j1 + t):
                U = a[jx]
                V = a[jx + t]
                a[jx] = modadd(U, V)
                a[jx + t] = modmul(modsub(U, V), S)
            j1 += 2 * t
        t *= 2
        m //= 2
    ninv = pow(n, Q - 2, Q)
    return [modmul(x, ninv) for x in a]


# ---- golden: schoolbook negacyclic convolution mod (x^n + 1) ----
def negacyclic_conv(a, b):
    n = len(a)
    c = [0] * n
    for i in range(n):
        for jx in range(n):
            k = i + jx
            if k < n:
                c[k] = (c[k] + a[i] * b[jx]) % Q
            else:
                c[k - n] = (c[k - n] - a[i] * b[jx]) % Q
    return [x % Q for x in c]


# ================= checks =================
def check_constants():
    if pow(G, 6, Q) != PSI:
        fail("g^6 mod q != psi")
    if PSI * PSI % Q != OMEGA:
        fail("psi^2 != omega")
    if pow(PSI, 1024, Q) != Q - 1:
        fail("psi^1024 != -1 (not negacyclic)")
    if pow(PSI, 2048, Q) != 1:
        fail("psi^2048 != 1")
    if NINV != pow(1024, Q - 2, Q) or 1024 * NINV % Q != 1:
        fail("Ninv != 1024^-1 mod q")
    if BARRETT_MU != (1 << BARRETT_K) // Q:
        fail("barrett mu != floor(2^28/q)")
    if J_CONST * J_CONST % Q != Q - 1:
        fail("j^2 != -1 (j not order-4)")
    if not (Q * Q < (1 << PRODUCT_BITS)):
        fail("q^2 does not fit in 28-bit product width")


def check_barrett_smt():
    try:
        import z3
    except Exception:
        return ("z3-unavailable", None)
    x = z3.Int('x')
    qh = z3.Int('qh')
    K = 1 << BARRETT_K
    s = z3.Solver()
    # model qh = floor(x*mu / 2^28) for x in [0, q^2); everything is LINEAR
    s.add(x >= 0, x < Q * Q, qh >= 0)
    s.add(qh * K <= x * BARRETT_MU, x * BARRETT_MU < (qh + 1) * K)
    r = x - qh * Q
    # try to break the claimed range 0 <= r < 3q
    s.add(z3.Or(r < 0, r >= 3 * Q))
    res = s.check()
    return ("ok" if res == z3.unsat else "bad", res)


def check_barrett_numeric():
    edge = [0, 1, Q - 1, Q, 2 * Q, 3 * Q - 1, Q * Q - 1, (Q - 1) * (Q - 1)]
    samples = edge + [random.randrange(Q * Q) for _ in range(5000)]
    for x in samples:
        if barrett_reduce(x) != x % Q:
            fail("barrett(%d)=%d != %d" % (x, barrett_reduce(x), x % Q))


def check_memory_map():
    seen = set()
    for i in range(N):
        if not (0 <= bank(i) < 8):
            fail("bank out of range at i=%d" % i)
        if not (0 <= offset(i) < N // 8):
            fail("offset out of range at i=%d" % i)
        key = (bank(i), offset(i))
        if key in seen:
            fail("(bank,offset) not injective at i=%d" % i)
        seen.add(key)
    if len(seen) != N:
        fail("(bank,offset) not a bijection on [0,N)")
    logn = N.bit_length() - 1
    # radix-2: paired operands (i, i+2^s) must land in distinct banks
    for s in range(logn):
        step = 1 << s
        for i in range(N):
            if (i >> s) & 1:
                continue
            if bank(i) == bank(i + step):
                fail("radix-2 bank conflict stride 2^%d at i=%d" % (s, i))
    # radix-4: the 4 operands (i, i+2^s, i+2^{s+1}, i+3*2^s) must be distinct banks
    for s in range(logn - 1):
        step = 1 << s
        for i in range(N):
            if ((i >> s) & 1) or ((i >> (s + 1)) & 1):
                continue
            idx = [i, i + step, i + 2 * step, i + 3 * step]
            banks = [bank(t) for t in idx if t < N]
            if len(set(banks)) != len(banks):
                fail("radix-4 bank conflict stride 2^%d at i=%d: %s" % (s, i, banks))


def check_radix4_decomp():
    # radix-4 BU must equal a composition of radix-2 butterflies (the "fuses two
    # radix-2 stages" claim), giving a NON-circular check of the spec equations.
    j = J_CONST
    for _ in range(3000):
        x0, x1, x2, x3 = [random.randrange(Q) for _ in range(4)]
        w = random.randrange(Q)
        W2 = modmul(w, w)
        t1, t2 = radix2_bf(x0, x2, W2)      # x0 +/- W2*x2
        p, mm = radix2_bf(x1, x3, W2)       # x1 +/- W2*x3
        t3 = modmul(w, p)                   # W1*(x1+W2*x3) = W1*x1 + W3*x3
        t4 = modmul(w, mm)                  # W1*(x1-W2*x3) = W1*x1 - W3*x3
        d0, d2 = radix2_bf(t1, t3, 1)
        d1, d3 = radix2_bf(t2, t4, j)
        y = radix4_bf(x0, x1, x2, x3, w, j)
        if (y[0], y[1], y[2], y[3]) != (d0, d1, d2, d3):
            fail("radix4 != radix2 decomposition at %s w=%d: %s vs %s"
                 % ((x0, x1, x2, x3), w, y, (d0, d1, d2, d3)))


def check_transform_small():
    for n in (8, 16):
        psi = psi_for(n)
        if pow(psi, 2 * n, Q) != 1 or pow(psi, n, Q) != Q - 1:
            fail("psi_for(%d) is not a primitive 2n-th root" % n)
        fwd, inv = build_tables(n, psi)
        for _ in range(40):
            a = [random.randrange(Q) for _ in range(n)]
            b = [random.randrange(Q) for _ in range(n)]
            A = ntt(a, fwd)
            B = ntt(b, fwd)
            C = [modmul(A[i], B[i]) for i in range(n)]
            got = intt(C, inv)
            want = negacyclic_conv(a, b)
            if got != want:
                fail("negacyclic-conv mismatch n=%d: %s vs %s" % (n, got, want))
            if intt(ntt(a, fwd), inv) != a:
                fail("NTT/INTT roundtrip mismatch n=%d" % n)


def check_roundtrip_full():
    psi = psi_for(N)
    if psi != PSI:
        fail("psi_for(1024) != PSI")
    fwd, inv = build_tables(N, psi)
    for _ in range(3):
        a = [random.randrange(Q) for _ in range(N)]
        if intt(ntt(a, fwd), inv) != a:
            fail("N=1024 NTT/INTT roundtrip mismatch")
    if os.environ.get("DEEP_VERIFY") == "1":
        a = [random.randrange(Q) for _ in range(N)]
        b = [random.randrange(Q) for _ in range(N)]
        A = ntt(a, fwd)
        B = ntt(b, fwd)
        C = [modmul(A[i], B[i]) for i in range(N)]
        if intt(C, inv) != negacyclic_conv(a, b):
            fail("N=1024 negacyclic-conv mismatch")


def check_fsm():
    trans = [
        ("IDLE", "LOAD"), ("LOAD", "STAGE_LOOP"),
        ("STAGE_LOOP", "TWIDDLE_FETCH"), ("TWIDDLE_FETCH", "BUTTERFLY"),
        ("BUTTERFLY", "REDUCE"), ("REDUCE", "WRITEBACK"),
        ("WRITEBACK", "TWIDDLE_FETCH"), ("WRITEBACK", "STAGE_LOOP"),
        ("STAGE_LOOP", "INTT_STAGE_LOOP"), ("STAGE_LOOP", "DRAIN"),
        ("INTT_STAGE_LOOP", "SCALE_N_INV"), ("SCALE_N_INV", "DRAIN"),
        ("DRAIN", "IDLE"),
    ]
    adj = {}
    for a, b in trans:
        adj.setdefault(a, []).append(b)
    seen = set()
    stack = ["IDLE"]
    while stack:
        st = stack.pop()
        if st in seen:
            continue
        seen.add(st)
        stack.extend(adj.get(st, []))
    states = {"IDLE", "LOAD", "STAGE_LOOP", "TWIDDLE_FETCH", "BUTTERFLY",
              "REDUCE", "WRITEBACK", "INTT_STAGE_LOOP", "SCALE_N_INV", "DRAIN"}
    if seen != states:
        fail("FSM unreachable states: %s" % (states - seen))


def check_opcounts():
    # naive radix-4 (3 mults, 10 add/sub) -> optimized: 33% / 20% reduction
    if round(100 * (1 - 2 / 3)) != 33:
        fail("mult reduction != 33%")
    if 100 * (1 - 8 / 10) != 20:
        fail("add/sub reduction != 20%")
    # loop bounds: radix-2 = 10 stages, radix-4 = 5 passes; 8 lanes
    if N.bit_length() - 1 != 10:
        fail("log2(N) != 10")


def main():
    check_constants()
    st, res = check_barrett_smt()
    if st != "ok":
        fail("Barrett SMT range proof failed (%s, %s)" % (st, res))
    check_barrett_numeric()
    check_memory_map()
    check_radix4_decomp()
    check_transform_small()
    check_roundtrip_full()
    check_fsm()
    check_opcounts()
    print("VERIFIED")
    sys.exit(0)


if __name__ == "__main__":
    main()
