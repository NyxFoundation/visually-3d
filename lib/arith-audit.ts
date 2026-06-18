// Deterministic arithmetic auditor for the spec substrate.
//
// `amend` folds verification findings back into the scene's functional spec by
// asking a model to write CONCRETE values. Nothing downstream checked those
// values arithmetically, so a hallucinated derived constant (e.g. a wrong
// modular inverse) could be committed and then poison every later `reproduce`:
// any faithful implementation that trusts the spec fails the self-check, while
// one that recomputes the value "diverges" from the spec — the loop can never
// reach a passing self-check while the spec carries a false constant.
//
// This module audits self-describing, fully-NUMERIC arithmetic claims embedded
// in spec strings and repairs the few classes we can verify with certainty:
//
//   "<x> = <b>^-1 mod <q>"   /  "<b>^-1 mod <q> = <x>"   (modular inverse)
//   "<base>^<exp> mod <q> = <r>"                          (modular power)
//   "floor(<a> / <b>) = <c>"                              (floor division)
//
// It is intentionally conservative: only claims whose operands AND result are
// concrete integers are checked, so there is never a symbol table to resolve and
// never a false repair. Symbolic claims ("N^-1 = 8857", "floor(2^28 / q)") are
// left untouched. Pure (no I/O) so it is unit-testable.

export interface ArithRepair {
  path: string; // dotted path to the string that was repaired
  claim: string; // the kind of claim ('modular-inverse' | 'modular-power' | 'floor-div')
  before: string; // the original (wrong) substring
  after: string; // the corrected substring
}

// Floored modular reduction for BigInt (keeps results in [0, m) for m > 0).
function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

// Modular inverse via the extended Euclidean algorithm. Returns null when `a`
// is not invertible modulo `m` (so we leave such claims untouched).
function modInverse(a: bigint, m: bigint): bigint | null {
  if (m <= 0n) return null;
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) return null; // gcd(a, m) != 1
  return mod(oldS, m);
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  if (m <= 0n || exp < 0n) return -1n;
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return result;
}

// One auditable claim pattern: a global regex, the capture group holding the
// CLAIMED result, whether that result sits at the start or end of the match
// (so we can rebuild the match without needing capture-index support), and a
// function computing what the result should actually be from the operands.
interface ClaimPattern {
  kind: string;
  re: RegExp;
  resultGroup: number;
  resultAt: 'start' | 'end';
  expected(groups: bigint[]): bigint | null;
}

const PATTERNS: ClaimPattern[] = [
  {
    // "<x> = <b>^-1 mod <q>"  (result first)
    kind: 'modular-inverse',
    re: /(\d+)\s*=\s*(\d+)\s*\^\s*(?:-1|\{-1\})\s*mod\s*(\d+)/g,
    resultGroup: 1,
    resultAt: 'start',
    expected: ([, b, q]) => modInverse(b, q),
  },
  {
    // "<b>^-1 mod <q> = <x>"  (result last)
    kind: 'modular-inverse',
    re: /(\d+)\s*\^\s*(?:-1|\{-1\})\s*mod\s*(\d+)\s*=\s*(\d+)/g,
    resultGroup: 3,
    resultAt: 'end',
    expected: ([b, q]) => modInverse(b, q),
  },
  {
    // "<base>^<exp> mod <q> = <r>"
    kind: 'modular-power',
    re: /(\d+)\s*\^\s*(\d+)\s*mod\s*(\d+)\s*=\s*(\d+)/g,
    resultGroup: 4,
    resultAt: 'end',
    expected: ([base, exp, q]) => modPow(base, exp, q),
  },
  {
    // "floor(<a> / <b>) = <c>"
    kind: 'floor-div',
    re: /floor\(\s*(\d+)\s*\/\s*(\d+)\s*\)\s*=\s*(\d+)/g,
    resultGroup: 3,
    resultAt: 'end',
    expected: ([a, b]) => (b === 0n ? null : a / b),
  },
];

interface Splice {
  start: number;
  end: number;
  value: string;
  kind: string;
}

// Audit a single string, returning the corrected string and the splices applied.
function auditString(s: string): { fixed: string; splices: Splice[] } {
  const splices: Splice[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of s.matchAll(p.re)) {
      const full = m[0];
      const groups = m.slice(1).map((g) => BigInt(g));
      const statedStr = m[p.resultGroup];
      const want = p.expected(groups);
      if (want === null || want < 0n || want === BigInt(statedStr)) continue;
      // Rebuild the matched substring with the corrected result. The result is
      // always the first or last numeric token of the match, so a positional
      // splice on `full` is unambiguous.
      const correctedFull = p.resultAt === 'start'
        ? want.toString() + full.slice(statedStr.length)
        : full.slice(0, full.length - statedStr.length) + want.toString();
      const start = m.index ?? 0;
      splices.push({ start, end: start + full.length, value: correctedFull, kind: p.kind });
    }
  }
  if (splices.length === 0) return { fixed: s, splices: [] };
  // Apply right-to-left so earlier offsets stay valid. Dedupe overlapping
  // matches (e.g. two patterns matching the same span) keeping the first.
  splices.sort((a, b) => b.start - a.start);
  const applied: Splice[] = [];
  let fixed = s;
  let lastStart = Infinity;
  for (const sp of splices) {
    if (sp.end > lastStart) continue; // overlaps an already-applied splice
    fixed = fixed.slice(0, sp.start) + sp.value + fixed.slice(sp.end);
    applied.push(sp);
    lastStart = sp.start;
  }
  return { fixed, splices: applied };
}

// Recursively repair every string value in a parsed scene (or any JSON value),
// returning a new value plus the list of repairs made. The input is not mutated.
export function repairArithmeticClaims(value: unknown): { value: unknown; repairs: ArithRepair[] } {
  const repairs: ArithRepair[] = [];

  const walk = (node: unknown, pathStr: string): unknown => {
    if (typeof node === 'string') {
      const { fixed, splices } = auditString(node);
      if (fixed !== node) {
        for (const sp of splices) {
          repairs.push({ path: pathStr, claim: sp.kind, before: node, after: fixed });
        }
      }
      return fixed;
    }
    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, `${pathStr}[${i}]`));
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v, pathStr ? `${pathStr}.${k}` : k);
      }
      return out;
    }
    return node;
  };

  const repaired = walk(value, '');
  return { value: repaired, repairs };
}
