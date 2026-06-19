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

## 7. The second failure — the return edge poisoned the verifier

After the loop started climbing, a fresh 3-round `refine` on `ntt-fpga` stalled
differently: reproducibility went **42 → 68 → 52** (peaked below the 80 goal,
then *regressed*), fidelity stuck around 55, and the self-check never cleared
(0/2, 0/2, 1/2). Reading every run artifact (the per-round `reproduce` reports,
`impl-*-verify.txt`, the generated `check.py`, and the `amend` snapshots) gave
three distinct causes — see the run-log paths under *Sources* below.

- **The decisive one: `amend` wrote an arithmetically FALSE derived constant into
  the spec** — `N_inv_value: "8857 = 1024^-1 mod 12289"`, when the true inverse is
  **12277** (`1024·8857 ≡ 286 ≠ 1`). Because the self-check measures each impl
  *against the spec*, a false fact in the spec makes every faithful impl either
  fail the check or "diverge" — so the self-check could never reach 2/2. The
  generator (`amend`) and the verifier-substrate (the spec) were **entangled**:
  the model could write its own grading key. This is textbook reward-hacking /
  Goodhart, and it is exactly what successful self-improvement systems prevent by
  keeping the reward signal ungameable.
- **Harness fragility counted as semantic failure.** Round 2's impl-1 crashed on
  `random.Random(0xCFNTT)` — an invalid Python hex literal (codegen typo) — and
  round 1's checks died with empty output (consistent with the 180 s timeout on
  the first *cold* `uv run --with z3-solver`). A `SyntaxError` and a timeout carry
  **no** verdict, yet both were tallied as "the implementation is wrong".
- **No ratchet.** The loop overwrote the scene every round and ended on the worst
  one (52), discarding the better round-2 state.

## 8. Hardening — make the verifier-substrate ungameable, and never regress

The fixes, grounded in the recursive-self-improvement literature (see
*References*):

1. **Arithmetic guard (`lib/arith-audit.ts`).** A deterministic, pure
   check-and-repair for fully-numeric self-describing claims — `x = b^-1 mod q`,
   `b^e mod q = r`, `floor(a/b) = c`. It runs at three choke points: in `amend`
   before a scene is committed, in `reproduce` before the engineers ever read the
   spec, and in `refine` on any ratchet restore. A false constant therefore
   cannot survive on any path. This is *proof-gated self-modification* in
   miniature — the Gödel-machine principle that a change is only adopted when it
   can be shown sound — applied to the constants `amend` folds back.
2. **Verify-failure classification (`VerifyResult.kind`).** The backend now
   distinguishes a real `fail` (the check ran and printed a counterexample) from
   harness errors — `syntax` / `timeout` / `error` / `no-script` / `no-runner`.
   `reproduce` repairs a syntax/exception-broken check **once** (regenerate, fix
   only what stops it running) and reports `harness_errors` separately, so a
   codegen typo no longer masquerades as a wrong impl. Harness errors are also
   never fed back to `amend` as counterexamples. This mirrors V-STaR's stance that
   *how* an attempt failed is signal, not noise.
3. **Ratchet / best-keep (`refine`).** Each round scores its measured scene (a
   clean self-check outweighs the raw reproducibility number); the best scene is
   remembered and, if the final round regressed, restored — so the loop never
   ends worse than the best round it actually measured. This is the
   program-archive / selection idea from FunSearch, AlphaEvolve, and the Darwin
   Gödel Machine: only the best individual survives.
4. **`amend` prompt — ground in the source, don't invent (`buildAmendPrompt`).**
   It now receives the SOURCE (paper/datasheet metadata) to QUOTE; requires every
   derived constant be written as a verifiable expression (machine-checked,
   auto-corrected); tags each committed fact's provenance (`[src]` / `[conv]` /
   `[calc]`); and marks genuinely source-missing facts `[source-missing]` instead
   of fabricating architectural detail the scene lacks. Echoes Reflexion's
   evidence-grounded memory over confident self-narration.

Deliberately deferred (the asymptote, not yet built): full *delegation* of
constant computation (have `amend` emit only the derivation and let the backend
compute the value), and splitting the self-check's "matches the spec" from
"mathematically correct" beyond what the arithmetic guard already separates.

## 9. Third failure — practical verification, not heroic verification

Another `ntt-fpga` refine produced versions v19/v20 but still failed the
executable check. The generated verifier did not report a semantic
counterexample; it timed out. The checks had drifted into full-size work such as
1024-point NTT comparisons backed by `O(N^2)` reference convolution, so the
default verifier could spend minutes without producing any verdict. At the same
time, `amend` had regressed: it asked the model for a full updated scene while
only providing report metadata, so the model refused and no `amended.json` was
written.

The fix is to make both loops smaller and more mechanical:

- **Patch-based `amend`.** The model now returns only a spec patch
  (`metadata_spec` and `part_specs` for existing part ids). The host program
  merges it into the real scene, so geometry, part ids, connections, materials,
  and assembly text cannot be dropped or rewritten.
- **Fast default SMT checks.** The Python+Z3 backend now asks for bounded,
  compositional checks by default: prove reducers, butterflies, bank mappings,
  address schedules, and FSM steps locally; run end-to-end equivalence only on
  small reduced instances; use `O(N log N)` production-size smoke checks.
  Full-size exhaustive or `O(N^2)` checks must be guarded behind `DEEP_VERIFY=1`.

For CFNTT specifically, the useful fast formal targets are the conflict-free
bank-index/offset property per stage/lane, radix-2/radix-4 butterfly equivalence
mod `q`, Barrett reduction range/correctness over the legal input interval, and
twiddle address/schedule invariants. Those are precise, finite properties; a
full 1024-point schoolbook convolution is a deep regression test, not the normal
proof obligation for every refine round.

### 9.1 Generalizing the pattern beyond NTT

CFNTT was just the case that exposed the failure; the fix is not NTT-specific.
The Python+Z3 backend prompt now states the verification method as a **single
subject-agnostic thinking pattern**: *decompose correctness into a handful of
small finite obligations, then discharge each with the cheapest sound check*.
The decomposition examples deliberately span domains — a codec's
`decode(encode(x)) == x`, a sort being a permutation *and* ordered, a
data-structure invariant preserved by an operation — alongside the circuit
targets (one reducer/butterfly/FSM transition). So any new subject a `refine`
run encounters inherits the same "prove it small, terminate fast, gate the heavy
full-size check behind `DEEP_VERIFY=1`" discipline, instead of the pattern being
re-derived (or forgotten) per subject. `backends.test.mjs` pins this generality
so a later edit cannot quietly narrow the prompt back to circuits-only.

## 10. Feedback-driven visual budget

The closed loop ran a fixed visual budget every round — `improve` re-rendered and
rewrote the *whole* scene `--iters` (was 2) times, regardless of whether the
scene's picture was already good. That is the loop's single most token-heavy step
(a render attachment plus a full-scene regeneration), and once the visual score
has cleared its goal the loop is really only chasing reproducibility. Spending two
full visual passes per round on an already-convincing scene was pure waste — and,
worse, an unprovoked rewrite can perturb a scene the spec work was not asking to
change.

The visual pass is now spent **reactively**, not on a schedule (`lib/refine.ts`):

- **Below the goal** — one improving visual pass per round (`--iters`, default
  lowered 2 → 1).
- **At/above the goal** — the visual pass runs ONLY when the previous round's
  `amend` actually changed the spec (`lastAmendApplied`). That one pass folds the
  new spec/impl feedback into the visual annotations so the picture stays
  consistent with what `amend` wrote. If the spec did not move, the visual pass is
  **skipped entirely** and the whole budget goes to `reproduce`/`amend`.
- **Self-correcting** — a reactive pass that regresses visual back below the goal
  clears `visualCleared`, so the per-round improving pass resumes automatically.

So the visual axis now behaves like the spec axis already does: it only grows when
there is concrete feedback to fold in. Once both the picture and the spec
stabilize, the loop spends nothing on visuals and converges on the implementation
work that is still open. The same reproduce-findings seed that already steered the
visual pass (`seedFromReport`) is what makes the reactive pass *feedback-driven*
rather than a blind re-render.

## 11. Source evidence — fixing the information ceiling, not the loop

Running `ntt-fpga` to v23 showed the loop working correctly yet stuck:
`reproducibility` oscillated 62 → 74 → 70 and never reached 80, while the
self-check finally PASSED (the timeout was gone). The cause was not a loop bug —
it was an **information ceiling**. The scene held only the CFNTT paper's URL and a
summary, so the paper's signature structures (the conflict-free bank/offset map,
the per-stage crossbar permutation, the twiddle-ROM addressing, the radix-4
schedule and FSM) were never in the loop. Two reverse-implementers each invented a
different valid reconstruction → permanent divergence → reproducibility capped;
`amend` could not help because it (correctly) will not fabricate a
`[source-missing]` value.

The fix is to give the loop the missing information instead of asking it to invent
more:

- **Autonomous gathering inside `refine` (`lib/evidence.ts`).** There is no
  separate command — the loop decides. The first time a round stalls below the
  reproducibility goal on source-dependent gaps (`hasSourceGaps`), refine fetches
  the scene's `metadata.info.sources` with web tools, transcribes the technical
  sections to Markdown, and caches them under `~/.visually-3d/evidence/<id>/`
  (once per loop; skipped with no source or when already fetched; `--no-evidence`
  / `--evidence-refs` to control). This is the **only tool-enabled step**;
  `runClaudeStreaming` now takes a `tools` option, and the rest of the loop stays
  tool-less and deterministic.
- **Checked-in seed (`examples/<id>/`).** Curated learnings ship with the package
  and are the fallback when no evidence has been fetched. `examples/ntt-fpga/`
  distills the v1–v23 trial-and-error honestly: what is settled and matches the
  source, what is still `[source-missing]`, and which resource/ATP/timing claims
  a functional backend can *never* verify.
- **`amend` quotes the evidence.** `buildAmendPrompt` injects the gathered
  evidence and a provenance scheme (`[paper]` authoritative, `[ref-impl]`
  secondary, `[src]`/`[conv]`/`[calc]` as before); a value the evidence supplies
  for a prior `[source-missing]` note is promoted to `[paper]`.

**Invariant preserved.** Evidence enters `amend` ONLY. reproduce's
reverse-implementers still see the spec alone, so reproducibility keeps measuring
the spec's completeness — evidence enriches the spec, then reproduce grades the
richer spec. What evidence cannot lift (synthesis-only resource/ATP/timing claims)
is documented as out-of-scope for `python-smt` rather than counted as failure.

## 12. Accumulating, cache-first evidence (autonomy + coherence)

The first cut fetched once and overwrote `paper.md`. The substrate is now an
**accumulating cache** with an explicit policy, so the loop gets more autonomous
without losing coherence:

- **Cache-first.** Gathered evidence is the default input; `amend` reads it from
  `~/.visually-3d/evidence/<id>/` (or the `examples/<id>/` seed) and nothing is
  re-fetched while it covers the open gaps. The curated seed `notes.md` is now
  *merged* with a fetched `paper.md` (a fetch never drops the hand-distilled
  learnings).
- **Accumulate, don't overwrite.** Each pass is **appended** to `paper.md` under a
  dated, method-tagged header, so evidence grows across rounds and across separate
  `refine` runs.
- **Gap-targeted.** `summarizeGaps(report)` turns the report's open
  missing-fields / fidelity items into explicit hunting targets handed to the
  gatherer, so each fetch goes after the specific blocked facts.
- **Escalation ladder + stop.** A persistent `index.json → attempts[]` log drives
  `planEvidence`: `paper` → `refs` (GitHub, secondary) → exhausted. A method is
  never repeated; a second stall or a re-run advances the ladder rather than
  re-fetching, and once exhausted the loop stops and leaves the residue honestly
  `[source-missing]` instead of fetching forever.
- **Loose coupling.** `refine` only owns the trigger (stalled below goal on
  source gaps) and calls `ensureEvidence`; the cache, policy, and accumulation
  live entirely in `lib/evidence.ts`. The evidence→amend-only invariant is
  unchanged.
- **Control surface.** The policy is selectable both ways: CLI flags
  `--evidence-refs` (search GitHub from the first pass) / `--no-evidence` (offline,
  spec-only), and a TUI **Refine → source evidence policy** sub-menu offering the
  same three presets (auto / GitHub-upfront / no-web). Default in both:
  paper-first, auto-escalate to GitHub only if the paper doesn't close the gaps.

## 13. Two-tier verification — small-N e2e + at-full-width proofs

Re-running `ntt-fpga` with evidence enabled regressed the self-check from PASS to
**timeout**: the now richer, more "authoritative"-looking spec nudged the
reimplementers back into a full-size `O(N^2)` schoolbook golden at `N = 1024`
(`impl-1.py` literally hard-codes `N = 1024` and an `O(N^2)` reference). The
verification philosophy was right; one tier had collapsed into a heroic check.

The fix makes the two tiers explicit and adds teeth, three ways:

- **Backend prompt (`python-smt`).** Restated as TIER 1 — *size-independent*
  properties proved with z3 **at the real bit-widths / over every stride class**
  (these hold for all N and are where large-N-only bugs are actually caught) — and
  TIER 2 — whole-system equivalence **only at the smallest structure-preserving
  instance** (`N ≤ 16`, honoring `metadata.spec.verification.e2e_N` if set).
  Building an `O(N^2)` golden at the production size is forbidden by default
  *even when N is pinned large*.
- **Recorded recipe (`amend`).** When the report shows a timed-out self-check,
  `amend` pins `metadata.spec.verification = { e2e_N, proofs[] }` into the spec, so
  the next round's engineers all verify the same cheap, fixed way instead of each
  re-guessing the test size.
- **Timeout recovery (`reproduce`).** The harness-recovery that already repairs a
  syntax/exception check now also handles `timeout`: one shrink-and-retry that
  moves the whole-system pass to a small instance (keeping the at-full-width
  proofs) before a non-verdict is recorded — so a too-heavy check no longer
  masquerades as a failing implementation.

Why this is the general discipline, not an NTT patch: every subject splits the
same way — local invariants that are size-independent (prove once, symbolically)
plus a composition checkable at small scale. "Verify small" is right *because*
the at-full-width proofs carry the generality; small-N alone would only be
"tested small". What this still cannot touch is synthesis-only fidelity
(resource/area/ATP/timing) — a separate axis from functional/structural
correctness.

## References

The hardening borrows directly from prior recursive-self-improvement work:

- **Gödel machine** — Schmidhuber, *Gödel Machines: Self-Referential Universal
  Problem Solvers* (2003). Self-modify only with a proof of benefit → the
  proof-gated arithmetic guard.
- **STOP: Self-Taught Optimizer** — Zelikman et al., arXiv:2310.02304. A scaffold
  improving itself against a *fixed, trustworthy* meta-utility → why the
  measuring-stick (the spec) must not be writable by the generator.
- **V-STaR: Training Verifiers for Self-Taught Reasoners** — Hosseini et al.,
  arXiv:2402.06457. Use *both* correct and incorrect attempts → failures are
  classified signal (the verify-kind split).
- **FunSearch** — Romera-Paredes et al., *Nature* (2023) — and **AlphaEvolve**,
  arXiv:2506.13131. An executed evaluator + a program *database* that keeps the
  best individuals → the ratchet / best-keep.
- **Darwin Gödel Machine** — Zhang et al., arXiv:2505.22954. Empirical-fitness
  archive of self-improving agents → keep, don't overwrite, the best scene.
- **Reflexion** — Shinn et al., arXiv:2303.11366 — and **Self-Refine**, Madaan et
  al., arXiv:2303.17651. Self-critique plateaus without external grounding →
  `amend` must read the source, and provenance must be explicit.

Sources (this repo's run artifacts that diagnosed §7), under
`$VISUALLY_HOME/runs/ntt-fpga/`:

- `reproduce-20260618-{162305,164625,170631}/report.json` — the 42 → 68 → 52
  reproducibility trajectory and self-check 0/2 → 0/2 → 1/2.
- `reproduce-20260618-164625/impl-1.py:261` — the `0xCFNTT` codegen typo.
- `reproduce-20260618-170631/check.py` — impl-2 hard-coding `N_INV = 12277` with
  the comment "spec's 8857 is wrong", i.e. passing only by *disobeying* the spec.
- `amend-20260618-165124/report.json` — the counterexample `spec 8857 != 12277`
  that `amend` recorded but did not fix.
