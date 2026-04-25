# User Study Protocol (draft)

Phase 5 of the design notes. To be expanded once the C0–C4 UIs ship.

## Participants

- Target n = 16–24.
- Inclusion: working knowledge of Python/Git OR web automation.
- Exclusion: prior involvement in Visually-3D development.

## Design

- **Within-subject**, condition order counter-balanced via Latin square.
- 4 UI conditions (C0–C3) per participant, ~2–3 failure runs each.
- Optional follow-up block in C4 (Visually-3D + AI repair) for repair-validity.

## Per-trial measures

For each (participant, condition, run):

- `root_cause_label` (from taxonomy)
- `first_failure_event_id`
- `recommended_repair_type`
- `confidence` (1–5)
- `diagnosis_time_sec`
- NASA-TLX subscales
- Brief free-text notes

Logged to `bench/outputs/diagnosis_results/<participant>_<condition>_<run>.json`.

## Subjective batteries

- **NASA-TLX** at end of each condition block.
- **SUS** (or 5-item Likert) once per condition.
- **Trust scale** — trust in diagnosis, trust in repair suggestion.

## Ethics

Consent form lives at `bench/docs/consent_form.md`. Participants can withdraw
at any time; data is keyed by an opaque participant ID, not name/email.
