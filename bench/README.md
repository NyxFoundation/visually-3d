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

**Artifact policy.** All text artifacts under `data/` and `outputs/` (JSON,
JSONL, patches, metric reports) **are committed to git** so runs are cacheable
and the experiment can be parallelized across machines and contributors —
person A drives 50 SWE-bench tasks, pushes; person B pulls and drives 50 more
without overlap; CI rolls up metrics on the union. Only large binaries
(`data/screenshots/`) are gitignored — store a `manifest.json` next to them
recording hash + remote URL until we wire up LFS.

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

### Drive a real SWE-bench run (via OpenHands)

`scripts/run_swebench.py` is a thin wrapper around OpenHands' upstream
SWE-bench evaluator (`evaluation/benchmarks/swe_bench/scripts/run_infer.sh`).
It generates a LiteLLM config block pointing at your provider, restricts the
run to a single instance (via `INSTANCE_IDS`), parses the resulting trajectory
back into our common schema, and writes the run-meta.

One-time setup (heavy — needs Docker, ~1 GB+ disk per repo):

```bash
bench/scripts/setup_openhands.sh        # clones External/OpenHands at HEAD
cd bench/external/OpenHands && make build
docker info                              # confirm daemon is reachable
```

Set the API key for the provider you're targeting:

```bash
export OLLAMA_API_KEY=...    # OSS models (qwen-coder-32b, gpt-oss-120b, deepseek-coder-7b)
export OPENAI_API_KEY=...    # gpt-5*, gemini-2.5-pro
export ANTHROPIC_API_KEY=...
```

Then drive a single task:

```bash
# Offline smoke (no OpenHands, no Docker) — deterministic synthetic trace.
python scripts/run_swebench.py \
    --benchmark swebench_lite \
    --task-fixture fixtures/swebench_lite/django__django-10914.json \
    --agent openhands --model qwen-coder-32b --seed 1 --stub

# Real run against Ollama Cloud (requires OpenHands + Docker).
python scripts/run_swebench.py \
    --benchmark swebench_lite \
    --task-fixture fixtures/swebench_lite/django__django-10914.json \
    --agent openhands --model qwen-coder-32b --seed 1
```

> **Note on verification.** The wrapper itself was developed without a live
> OpenHands install; the subprocess invocation, the trajectory-parsing field
> names, and the output-discovery glob are best-effort against OpenHands'
> current docs. Expect to tighten `trajectory_to_trace()` and
> `find_openhands_output()` in `run_swebench.py` once you've driven the first
> real instance end-to-end.

### Materialize task fixtures

`scripts/fetch_swebench_fixtures.py` pulls SWE-bench Lite tasks from the
HuggingFace datasets-server (no `datasets` package required) and writes one
JSON per task into `fixtures/swebench_lite/`:

```bash
python scripts/fetch_swebench_fixtures.py            # default: 10 tasks, offset 0
python scripts/fetch_swebench_fixtures.py -n 50      # next 50 tasks
```

The fetcher derives `candidate_files` from each task's gold patch and a
`test_command` from `FAIL_TO_PASS`. Re-running is idempotent (skips existing
fixtures unless `--force`).

### Drive the OSS baseline matrix (Phase-0)

`scripts/run_baseline_oss.sh` sweeps (model × fixture × seed) for the OSS
models on Ollama Cloud, dispatches to the right driver based on `--benchmark`,
skips cached runs, and clears the Phase-0 ≥10-run threshold out of the box
(30 runs per benchmark):

```bash
# Coding baseline (SWE-bench Lite, openhands agent shape, 4-step loop).
OLLAMA_API_KEY=... bench/scripts/run_baseline_oss.sh --jobs 4

# Web baseline (WebArena, react_browser shape, 5-step loop).
OLLAMA_API_KEY=... bench/scripts/run_baseline_oss.sh --benchmark webarena --jobs 4

# Inspect / smoke without any API key.
bench/scripts/run_baseline_oss.sh --dry-run
bench/scripts/run_baseline_oss.sh --stub
```

The driver, default agent, and default fixture dir all flow from
`--benchmark`. Override any axis via flag (`--models`, `--seeds`, `--fixtures`,
`--agent`) or env var. Use `--force` to recompute cached runs.

Web fixtures live in `fixtures/webarena/` (10 hand-crafted tasks across
shopping / shopping_admin / gitlab / reddit / maps / wikipedia / classifieds).
The minimal web driver does **not** drive a real browser yet — it produces a
plan→navigate→observe→act→eval LLM trace with `domain: "web"` events; wiring
real BrowserGym + Playwright comes after the visualizer iteration.

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

- End-to-end verification of the OpenHands subprocess path in
  `run_swebench.py`. The wrapper code is in place but was written without a
  live OpenHands install; `trajectory_to_trace()` field names and the
  `find_openhands_output()` glob need a real run to confirm. Until then,
  `--stub` is the only path that's been smoke-tested in this repo.
- Real browser execution in `run_webarena.py`. The minimal loop produces an
  LLM-only trace with `domain: "web"` events; wiring BrowserGym + Playwright
  + the WebArena Docker stack adds DOM/screenshot capture and real success
  evaluation.
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
