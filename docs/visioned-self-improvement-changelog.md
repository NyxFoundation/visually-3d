# How the visioned self-improvement loop came to be

The development log of this agent loop — not a release changelog, but the
trial-and-error: what was broken, what we tried, and the clarifications that
reshaped the design along the way. Concept and final architecture live in
[`visioned-self-improvement.md`](./visioned-self-improvement.md).

---

## 0. The symptom

A `refine` run on `ntt-fpga` (the CFNTT NTT/FPGA accelerator) finished with the
**visual score at 93/100** and the **executable self-check passing**, but the
**reproducibility score never moved — 8/100 across all four rounds.** The
implementation "passed", yet the scene was no more reproducible than when it
started. That contradiction was the starting point.

## 1. Diagnosis — the loop was open

Reading the run logs and the code, the cause was structural, not a bug:

- **The visual loop and the reproducibility judge read disjoint information.**
  `improve` rewrote *geometry*; `reproduce` scored whether an engineer could
  rebuild the system from the scene's *functional* content. Polishing the render
  added zero functional content, so the score could not move.
- **There was nowhere to store functional facts.** The schema was geometry-only.
- **Nothing fed verification back into the scene.** `reproduce` reported and
  stopped; its findings never re-entered the model.

So the three "axes" (visual, implementation, verification) ran in series with no
return edge — a pipeline, not a loop.

## 2. First design — give the loop a substrate and a return edge

The fix had to add (a) a place to hold functional facts and (b) a path from
verification back into the scene:

- **Spec substrate** — `parts[].spec` + `metadata.spec`
  (params/widths/ports/ops/fsm/notes), mode-agnostic, fully optional so nothing
  breaks. The genome both axes share.
- **`amend`** — the return edge: fold `reproduce`'s missing fields, divergences
  and verifier counterexamples back into the spec, routing each fact to its part
  `id`. It *commits to one value* to kill an ambiguity.
- **`refine` as a real loop** — improve → reproduce → **amend** each round, with
  the spec read as authoritative so written-back facts actually raise the score.

We considered going further (deriving each implementation's golden model from the
spec, proving cross-implementation equivalence with z3) but kept those as
mechanism hooks — the highest-leverage, genuinely-working change was the return
edge, and the verifier's counterexamples already carry the actionable evidence.

## 3. A conceptual detour — "does it work" vs "is it *the paper's* system"

A key question came up: can you formally verify not that a circuit *works*, but
that it is *truly as described in the paper*? Working through it:

- Formal equivalence checking proves I/O equivalence — and **deliberately erases
  the internal structure** that distinguishes two correct-but-different designs.
  So "matches the paper" is not an equivalence-checking question.
- The paper is **not a formal object**; you can only check against your encoding
  of it (the oracle/formalization gap).
- But it **decomposes**: parameter facts (extract & compare), named properties
  like "conflict-free" or "NTT∘INTT = identity" (these *are* precisely checkable),
  and pure structural identity (the genuinely hard, paper-gated part).

This split the verification into two axes:

- **reproducibility** — can the spec rebuild the system at all (completeness);
- **fidelity** — do the implementations match the *specific* system in the
  source, not merely a correct one. Judged by the model (parameter_fidelity,
  property_checks, structural_findings), since the source is informal — while
  correctness stays executably checked by the backend.

`amend` was extended to fold fidelity gaps back too (write the source's value,
record named properties).

## 4. Clarification — "general" meant *automatic*, not *manual*

The first cut required tagging a scene with `metadata.backend: "python-smt"` to
get SMT on a hardware subject. The actual ask was the opposite: **the user should
never specify it** — hand a mechanical blueprint and it should use the physics
sim; hand a CPU/GPU/FPGA and it should use SMT, automatically.

So `selectBackend(scene)` was added to infer the substrate from the subject, and
the manual `metadata.backend` on `ntt-fpga` was removed.

**First attempt over-fired:** classifying on the full scene text routed several
*physical* machines to SMT — a quadcopter, a tractor, an EV, a CubeSat — because
they contain a microcontroller/flight-controller. The lesson: the **subject
noun** is what matters, not incidental digital parts. Reworked so the title
decides (mechanical title → sim, digital title → SMT), with full-text "digital
wins" only as a tie-break for genuinely ambiguous subjects. Re-checked across the
whole bundled gallery until every sample routed sensibly.

## 5. Clarification — decide it at `create` time

Next ask: make the decision when the scene is born. So `create` now classifies
from the title (+ `--url`, which it records as `metadata.reference` — the
fidelity ground truth), stamps the auto-selected `metadata.backend`, and logs it.
The visual self-improvement prompt was tightened to carry
mode/reference/backend/spec through unchanged so the decision survives later
edits (and `reproduce` re-derives it live if a scene ever lacks it).

## 6. Clarification — `create` should run the *same* loop

Finally: a created scene was still only getting the *visual* improve loop, never
verification or amend. The choice was made to wire `create`'s default
post-generation pass to the full closed `refine` loop (improve → reproduce →
amend), so a freshly created scene is convincing *and* reproducible out of the
box — accepting the extra model/SMT cost per create, controllable with
`--refine N` / `--no-refine`.

## Where it landed

A single closed loop, with no manual mode/backend, that works the same for a
chip, an algorithm, or a physical machine: **create → improve → reproduce
(auto-picked verifier, scoring reproducibility *and* fidelity) → amend → repeat**,
each pass writing verified facts into the spec so the scene becomes measurably
more reproducible. The `ntt-fpga` case that started this — stuck at 8/100 — now
has a path to climb, because verification findings finally flow back into the
scene.
