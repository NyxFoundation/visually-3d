# Annotation Guideline (draft)

Companion to `bench/schemas/annotation.schema.json`. Refine through Phase 2.

## Goal

For each failed run, produce a JSON record at
`bench/data/annotations/<run_id>.json` validating against the annotation schema,
with at minimum:

- `is_repairable` — could a method-level / prompt-level / policy-level repair
  realistically have prevented this failure?
- `root_cause_label` — pick from the taxonomy in design notes section 7.
- `first_failure_event_id` — the **earliest** event where the run had clearly
  diverged from a successful trajectory.
- `propagated_failure_event_ids` — events whose state is corrupted by the
  first-failure event.

## Process

1. Load the run in the **C0 raw-log** view first. Form a hypothesis.
2. Cross-check in the **C1 2D trace** view. Update the hypothesis if needed.
3. Only then label. Do not use the C2 / C3 views for primary annotation —
   those are evaluation conditions and using them leaks ground truth.
4. Two annotators per run, one adjudicator. Compute Cohen's κ on
   `root_cause_label`.

## Tips

- Prefer the earliest unambiguous divergence over the most "obviously wrong"
  later step. `first_failure_event_id` is about cause, not symptom.
- If the agent never had enough information to succeed (e.g. the task is
  ill-specified) mark `is_repairable: false` and skip the rest.
- Use `notes` liberally — adjudication leans on it.
