# Curated learnings — ntt-fpga (CFNTT, TCHES 2022)

Distilled from many `refine` rounds (v1–v23). This is honest about what is
settled, what is still missing, and what this backend simply cannot grade —
it is NOT a transcription of the paper. `refine` will fetch the paper's real
values autonomously when it stalls below the reproducibility goal (writing
`paper.md` into the workspace evidence store), and `amend` then quotes it; the
gaps below say what that fetch needs to resolve.

Source: "CFNTT: A Scalable Conflict-Free NTT Multiplication Architecture"
(IACR TCHES 2022). See `index.json` for URLs.

## Settled — matches the source, keep pinned in the spec
The numeric/algebraic core is reproducible and the two independent reverse
implementations agree on it. These belong in `metadata.spec` / `parts[].spec`
with `[src]`/`[calc]` provenance and should not regress:
- transform size N, modulus q, coefficient bit-width, number of butterfly units;
- Barrett reduction constants (mu, k) and the negacyclic (psi-twisted) flavor;
- psi / omega / N^-1 and the generator choice (derivable, machine-checked by the
  arithmetic guard);
- round-trip identity NTT∘INTT = id (proven on small N by the self-check).

## Still missing — the paper's SIGNATURE structures (the real ceiling)
These are the contributions a short summary omits, so two engineers each invent a
different valid version → permanent divergence → reproducibility caps in the
mid-70s. They are `[source-missing]` until the paper text is gathered:
- the **conflict-free bank-index and bank-offset functions** (the Sec. III
  headline result) — a reconstructed XOR-fold is NOT the paper's map and fails
  per-stage operand-distinctness at large strides;
- the **per-stage crossbar permutation σ_s** routing table;
- the **twiddle-ROM address function** f(stage, block) under the reuse loop;
- the **radix-4 full-transform index/stride schedule** and how the radix-2 lanes
  reconfigure into radix-4 BUs per stage;
- the **complete FSM** state list and transition table (the scene has carried two
  contradictory FSM lists and an unwired DONE state — fix at the source);
- the exact **Barrett correction** output bound / number of conditional
  subtractions, and the internal coefficient ordering (natural vs bit-reversed).

## Out of scope for python-smt — do NOT count these against fidelity
These are RTL/synthesis/area-timing claims a functional Python+Z3 model can never
verify. Record them in the spec as documentary `[src]` facts, but treat their
`property_checks` as `unverifiable` by construction, not as failures:
- "~50% butterfly hardware saved via symmetric operators";
- ATP / resource ratios (LUT / FF / DSP / BRAM vs radix-2);
- pipeline latency in cycles/lane and clock frequency;
- the "33% fewer mults / 20% fewer add-sub" reductions (need a stated naive
  baseline; verify only the per-BU operation count, which IS finite).

## Process lessons (apply to any paper-derived scene)
- A timed-out self-check is a HARNESS fault, not a wrong implementation — keep
  default verification finite (see `lib/backends/python-smt.ts`).
- `amend` must never fabricate a `[source-missing]` value; gather evidence first.
- Resource/timing claims need a different backend (RTL synthesis) — until then,
  reproducibility, not fidelity-on-hardware-claims, is the axis that can move.
