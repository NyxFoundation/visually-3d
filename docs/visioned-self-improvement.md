# Visioned self-improvement

> A 3D model and a real implementation co-evolve: build the model → critique it
> visually → reverse-implement it → verify the implementation → fold the findings
> back into the model. Each pass makes the scene both *more convincing to look at*
> and *more faithfully reproducible* as the real system.

This document explains the loop, why the earlier version could not improve, the
architecture that fixes it, and how to run it.

---

## 1. The idea

A `visually-3d` scene descriptor is two things at once:

- a **3D model** — geometry, materials, an exploded view: what the machine *looks
  like*; and
- a **spec** — the parameters, operations, ports, and named properties of the
  real system it depicts: what the machine *does*.

"Visioned self-improvement" is the loop that improves both at the same time and
keeps them consistent:

```
        ┌──────────────────────────────────────────────────────────┐
        │                                                          │
        ▼                                                          │
   ┌─────────┐     ┌───────────┐     ┌────────────────────┐    ┌───┴────┐
   │ improve │ ──► │ reproduce │ ──► │ verify (SMT / sim) │ ──►│ amend  │
   │ (visual)│     │ (N impls) │     │  + judge fidelity  │    │(→ spec)│
   └─────────┘     └───────────┘     └────────────────────┘    └────────┘
   render→critique  reverse-impl       run each impl's          write the
   →rewrite the     from the spec      self-check; LLM-judge     findings back
   scene            ALONE              reproducibility+fidelity  into the scene
```

`refine` is the loop driver; `improve`, `reproduce`, and `amend` are the stages
and also stand-alone commands.

---

## 2. Why the old loop could not improve

The original `refine` ran `improve` then `reproduce` in series, but **there was
no return edge and no shared substrate**:

1. **`improve` wrote geometry; `reproduce` read semantics.** The two stages
   touched disjoint information. `improve` optimized how the scene *looks*;
   `reproduce` scored whether an engineer could rebuild the system from the
   scene's *functional* content. Polishing the render added zero functional
   content, so the reproducibility score could not move.
2. **There was nowhere to put functional facts.** The scene schema was
   geometry-only. Even if verification discovered "the modulus is 12289", there
   was no field to store it in.
3. **Nothing fed verification back.** `reproduce` produced a report and stopped.
   Its findings never re-entered the scene.

Concretely, the `ntt-fpga` scene sat at **reproducibility 8/100 across four
rounds** while its visual score reached 93 and the executable self-check passed —
the loop was open.

---

## 3. The architecture

Three additions close the loop. All are **mode-agnostic** (hardware / algorithm /
architecture) and **backend-agnostic** (SMT / physics sim).

### 3.1 The spec substrate (`lib/types.ts`, `lib/scene.ts`)

Each part may carry a `spec`, and the scene a top-level `metadata.spec`:

```jsonc
"spec": {
  "params":     { "N": 1024, "q": 12289 },
  "widths":     { "coefficient": 14 },
  "ports":      [{ "name": "din", "dir": "in", "width": 14 }],
  "ops":        ["barrett_reduce", "ct_butterfly_dit"],
  "fsm":        ["IDLE", "LOAD", "RUN", "DRAIN"],
  "properties": ["conflict-free memory mapping", "no bit-reversal"],
  "notes":      "..."
}
```

It is the genome both axes read and write. Every field is optional and the
schema is `.loose()`, so it is fully back- and forward-compatible: old scenes
without it still validate, and `amend` may add fields the schema does not yet
name. `specCoverage(scene)` measures how much spec a scene carries.

### 3.2 The return edge — `amend` (`lib/amend.ts`)

After `reproduce`, `amend` takes the report's **missing fields**, **divergences**
(where independent implementations disagreed → the spec was ambiguous), the
verifier's **counterexamples**, and the **fidelity gaps**, and writes concrete
values back into the spec substrate — routing each fact to the part `id` it
belongs to, or `metadata.spec` for global facts. To resolve an ambiguity it
*commits to one value* (the one the passing / highest-confidence implementation
used, or the standard convention), making the bad state unrepresentable.

The merged scene passes the same parse/validate gate as `create`/`improve`
before it is committed; a malformed amend never corrupts the scene, and an amend
that drops parts is discarded.

This is the edge the old loop lacked: once a fact is in the spec, the **next**
`reproduce` reads it, the independent implementations converge, and
reproducibility climbs.

### 3.3 Two verification axes (`lib/reproduce.ts`)

`reproduce` has N independent agents reverse-implement the scene **from the spec
alone**, runs each implementation's self-check through a backend, then an
LLM-judge scores two different things:

- **reproducibility (0–100)** — could a competent engineer rebuild the system
  from the spec alone, with no guessing? This is about the spec's completeness.
- **fidelity (0–100)** — do the implementations match the **specific** system in
  the source (the paper/datasheet in `metadata.reference`), not merely *a*
  correct one? Many distinct implementations all "work"; fidelity asks whether
  this is *the* one. It is reported as:
  - `parameter_fidelity` — impl value vs the source's value, per parameter;
  - `property_checks` — each named claim (e.g. "conflict-free", "NTT∘INTT =
    identity") judged satisfied / violated / unverifiable;
  - `structural_findings` — where the architecture diverges from the source.

> **Why fidelity is a separate, LLM-judged axis.** "Does it work" is decidable by
> equivalence checking. "Is it *the paper's* system" is not: the paper is not a
> formal object, and equivalence checking deliberately erases the internal
> structure that distinguishes two I/O-equivalent designs. So fidelity is judged
> against the source by the model's expertise (named properties like
> "conflict-free" *are* precisely checkable and are surfaced as such), while
> correctness is checked executably by the backend. See the discussion in the
> project history for the full rationale.

Executable checks are deliberately **bounded and layered**, and the layering is
**subject-agnostic** — the same thinking pattern drives the verifier whether the
scene is an NTT accelerator, a sorting network, a compression codec, a balanced
tree, or a handshake protocol. The default verifier must finish quickly, so it:

1. **decomposes** correctness into a handful of small finite obligations — the
   invariants, equivalences, value ranges, and round-trip identities that
   together pin the system down (e.g. `decode(encode(x)) == x`; a sort output is
   a permutation *and* ordered; one reducer/butterfly/ALU op is correct over its
   legal range; one address/bank map is conflict-free; one FSM transition; one
   data-structure invariant);
2. **discharges** each the cheapest *sound* way — SMT over a bounded domain when
   the property is finitely expressible (one element/stage/transition
   generalizes), else exhaustive enumeration of a small space, else end-to-end
   equivalence on reduced instances (e.g. `N ≤ 16/32`);
3. for **production size**, checks structural invariants plus `O(N log N)`
   randomized/edge tests only.

Full-size exhaustive or `O(N^2)` reference checks belong behind an explicit
`DEEP_VERIFY=1` flag, not in the default `refine` path. The circuit terms above
are just one instantiation of the pattern; the backend prompt
(`lib/backends/python-smt.ts`) states it for any subject so a timed-out heroic
check never masquerades as "implementation broken".

### 3.3a Source evidence — lifting the `[source-missing]` ceiling (`lib/evidence.ts`)

A scene carries only a paper URL plus a short summary, so the source's *signature*
structures (an exact memory map, an addressing function, an FSM) are absent.
`reproduce` then finds two engineers each inventing a different valid version, and
`amend` correctly refuses to fabricate, tagging the gap `[source-missing]`. No
number of rounds can climb past this — the information genuinely isn't in the
loop.

`refine` closes that gap autonomously — there is **no separate command**. When a
round stalls below the reproducibility goal on source-dependent gaps
(`hasSourceGaps`), refine calls `ensureEvidence`, which runs a small **cache-first,
accumulating policy**:

1. **Reference the cache.** Evidence already gathered is the default input — it is
   read from `~/.visually-3d/evidence/<id>/` (or the checked-in `examples/<id>/`
   seed) and quoted by amend; nothing is re-fetched while it suffices.
2. **Fetch on miss, gap-targeted.** If the open gaps aren't covered, fetch with
   **web tools** (the one tool-enabled step; `runClaudeStreaming({ tools:
   ['WebFetch','WebSearch'] })`), telling the gatherer the *exact* open gaps to
   hunt (`summarizeGaps`). The transcription is **appended** to `paper.md`, never
   overwritten, so evidence accumulates across rounds and across runs. The curated
   seed `notes.md` is always merged in, never dropped.
3. **Escalate, then stop.** A persistent attempt log (`index.json → attempts[]`)
   drives an escalation ladder: primary source (`paper`) → reference
   implementations (`refs`, GitHub, tagged secondary `[ref-impl]`, never
   authoritative over the paper) → exhausted. A method is never repeated, so a
   second stall (or a re-run of `refine`) advances the ladder instead of
   re-fetching; once exhausted, the remaining gaps are left honestly
   `[source-missing]` rather than fetched forever.

`--no-evidence` opts out entirely; `--evidence-refs` also searches GitHub on the
first pass.

**Invariant: evidence flows into `amend` ONLY.** reproduce's reverse-implementers
never see it, because reproduce measures *"can you rebuild from the SPEC alone"* —
handing them the paper would measure paper-completeness instead. The flow is:

```
evidence(paper.md) → amend QUOTES it ([paper]) → spec gains the real values
                   → next reproduce grades the richer spec → divergence falls
                   → reproducibility & fidelity rise
```

What evidence *cannot* fix: claims that need synthesis (resource/area/ATP/timing,
e.g. "~50% hardware saved", LUT/FF ratios). A functional `python-smt` model
cannot verify those at all; they stay `unverifiable` by construction and must not
be counted as fidelity failures.

### 3.4 Automatic backend selection (`lib/backends/index.ts`)

The verification substrate is chosen from **what the subject is**, so no manual
mode/backend is ever needed:

- **digital / compute** designs (CPU, GPU, FPGA, ASIC, RISC-V core, NTT/crypto
  datapath, an LLM) → **`python-smt`** (bit-precise logic, checked with z3);
- **physical machines** (a drone, a tractor, a turbine, a robot arm — even with
  an embedded controller) → **`sim`** (MuJoCo physics).

The **subject noun decides** (a quadcopter that contains a microcontroller is
still a physical machine); only a genuinely ambiguous subject falls back to a
full-text "digital wins" tie-break. Precedence: `--backend` flag → explicit
`metadata.backend` → `algorithm`→SMT / `architecture`→sim → subject → full text.

`create` runs this at generation time, stamps `metadata.backend`, and records the
`--url` as `metadata.reference`; `reproduce` re-derives it live for any scene that
lacks the stamp.

---

## 4. The loop in `refine` and `create`

Each `refine` round:

1. **improve** — render → VLM critique → rewrite, seeded with the previous
   round's verification gaps so the annotations stay consistent with what must be
   reproducible;
2. **reproduce** — N reverse-implementations + executable self-check + the
   reproducibility & fidelity judge;
3. **amend** — fold the findings back into the spec.

It stops when the visual score, reproducibility, and the self-check all clear
their thresholds. It prints, per round: `visual · repro (▲/▼) · fidelity ·
self-check · spec field count`.

**Feedback-driven visual budget.** The visual pass is the most token-heavy step
— it attaches a render and rewrites the *whole* scene — so it is not run on a
fixed per-round schedule. While the scene is still **below** `visualGoal`, each
round runs one improving visual pass (`--iters`, default 1). Once it **clears**
the goal, the visual pass runs **only reactively**: when the previous round's
`amend` actually changed the spec, one pass folds those new facts into the visual
annotations; if the spec did not move, the visual pass is **skipped entirely** and
the whole budget goes to reproduce/amend. A reactive pass that regresses visual
back below the goal restores the per-round improving pass automatically. So once
both the picture and the spec stabilize, the loop spends nothing on visuals.

`create` now runs this **same** closed loop after generating the draft (≥3 rounds
by default; `--no-refine` to skip, `--refine N` to set rounds), so a freshly
created scene is convincing *and* reproducible out of the box.

---

## 5. Usage

```bash
# Generate → closed loop automatically (backend auto-selected from the subject):
visually create "CFNTT Radix-2/4 NTT accelerator" --url https://tches.iacr.org/...

# Run more closed-loop rounds on an existing scene:
visually refine ntt-fpga --rounds 3

# Just measure (no scene changes): reproducibility + fidelity + self-check
visually reproduce ntt-fpga

# Just fold the latest findings back into the spec:
visually amend ntt-fpga
```

Useful flags: `--backend python-smt|sim` (force a substrate), `--no-verify` (skip
the executable check), `--no-amend` (measure but don't write back), `--model`,
`--driver claude|codex`.

The SMT backend auto-provisions z3 via `uv run --with z3-solver` (or a local
`python3` that already imports `z3`); if neither is present, `reproduce` still
runs the judge and degrades gracefully.

---

## 6. Where things live

| Concern | File |
|---|---|
| Loop driver | `lib/refine.ts` |
| Reverse-implement + dual-axis judge | `lib/reproduce.ts` |
| Return edge (findings → spec) | `lib/amend.ts` |
| Spec substrate types / schema / coverage | `lib/types.ts`, `lib/scene.ts` |
| Backend auto-selection + registry | `lib/backends/index.ts` |
| Verification backends | `lib/backends/python-smt.ts`, `lib/backends/sim-mujoco.ts` |
| Visual self-improvement | `lib/improve.ts`, `prompts/self-improve.md` |
| Generation + create-time wiring | `lib/create.ts` |

See `docs/visioned-self-improvement-changelog.md` for the development history of
this agent loop.
