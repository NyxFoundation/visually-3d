# Visually-3D Benchmark Harness

Minimum experiment environment for the Visually-3D research project — diagnosing
LLM agent failures via 3D causal visualization. This folder is the scaffold for
the Phase 0–6 roadmap in the project's design notes; agent frameworks and
benchmark drivers themselves are intentionally not vendored here.

## Layout

```
bench/
├── configs/                   models / agents / benchmarks / UI conditions
├── schemas/                   JSON Schema for run, event, annotation, repair I/O
├── scripts/
│   ├── _common.py             stdlib-only IO + path helpers
│   ├── run_swebench.py        SWE-bench Lite/Verified driver (scaffold)
│   ├── run_webarena.py        WebArena / BrowserGym driver (scaffold)
│   ├── convert_to_events.py   native logs → common event schema
│   ├── build_graph.py         events → 3D causal graph JSON
│   └── compute_metrics.py     Layer 1/2/3 metrics across runs
├── data/
│   ├── raw_runs/              one JSON per run (run-level metadata)
│   ├── events/                one JSONL per run (event-level)
│   ├── annotations/           ground-truth labels per failed run
│   ├── graphs/                materialized 3D causal graphs
│   ├── screenshots/           web agent screenshots
│   └── patches/               coding agent diffs
├── outputs/
│   ├── ui_logs/               UI study interaction logs
│   ├── diagnosis_results/     participant / AI diagnosis outputs
│   ├── repair_results/        post-repair re-run results
│   └── cost_reports/          aggregated metric reports
├── fixtures/                  tiny synthetic fixtures for smoke tests
└── docs/                      annotation guideline, study protocol, consent form
```

`data/` and `outputs/` track only `.gitkeep` placeholders — generated artifacts
are gitignored (see `bench/.gitignore`).

## Quickstart

The harness only needs Python 3.10+ and the stdlib for everything except the
benchmark drivers. Install once:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r bench/requirements.txt
```

Run the smoke test (uses the synthetic fixture in `bench/fixtures/`):

```bash
cd bench
python scripts/convert_to_events.py \
    --input fixtures/sample_openhands_trace.jsonl \
    --run-id demo_run \
    --adapter openhands

python scripts/build_graph.py --run-id demo_run

python scripts/compute_metrics.py
```

You should see `data/events/demo_run.jsonl`, `data/graphs/demo_run.json`, and a
metric summary on stdout.

## Phase 0 / Week 1–2 checklist

From the design notes (Section 15):

| Check | Pass condition |
| --- | --- |
| SWE-bench drive  | ≥10 runs land in `data/raw_runs/` and `data/events/` |
| Web drive        | ≥10 runs with screenshots in `data/screenshots/` |
| Common schema    | Both coding and web events validate against `schemas/event.schema.json` |
| Failure analysis | ≥10 annotations in `data/annotations/` with provisional root cause |
| 3D graph         | One run replays through `build_graph.py` |
| Cost reporting   | `outputs/cost_reports/metrics.json` populated per run |

## Pipeline shape

```
agent driver (run_*.py)
        │
        ▼
data/raw_runs/<run_id>.json + native trace dump
        │
        ▼  convert_to_events.py
data/events/<run_id>.jsonl    ← canonical, schema-validated
        │
        ▼  build_graph.py    (+ optional data/annotations/<run_id>.json)
data/graphs/<run_id>.json    ← 3D nodes + edges + summary
        │
        ▼  React/Three.js front-end (existing /src in repo root)
        ▼  outputs/diagnosis_results/* + outputs/repair_results/*
        ▼  compute_metrics.py
outputs/cost_reports/metrics.json
```

## What is NOT in here yet

These are the integration points with explicit `TODO(phase-0)` markers:

- OpenHands / SWE-agent invocation in `run_swebench.py`.
- WebArena / BrowserGym container bring-up + agent loop in `run_webarena.py`.
- Real schema validation. The schemas in `schemas/` are authoritative; wire
  `jsonschema` into `_common.py` once `requirements.txt` is installed.
- Annotation tooling (Section 8) — currently just a JSON Schema; build a small
  CLI/UI when we start labeling.

## References (design notes)

Section 1 — benchmarks · Section 2 — agent frameworks · Section 3 — models ·
Section 4 — UI condition matrix · Section 5 — log schemas · Section 6 — 3D
graph spec · Section 7 — failure taxonomy · Section 8 — annotation protocol ·
Section 9 — repair I/O · Section 10 — metrics · Section 11 — user study ·
Section 12 — phase roadmap · Section 13 — cost model · Section 14 — directory
layout · Section 15 — first-two-weeks checklist.
