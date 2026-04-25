#!/usr/bin/env python3
"""Drive a SWE-bench Lite/Verified task through OpenHands' SWE-bench evaluator.

This is a thin wrapper around OpenHands' upstream
`evaluation/benchmarks/swe_bench/scripts/run_infer.sh`. We delegate the
sandboxed agent loop, Docker runtime, and trajectory format to OpenHands;
this file just (a) generates the LiteLLM config pointing at the requested
provider (Ollama Cloud / OpenAI / Anthropic), (b) restricts the run to a
single SWE-bench instance, (c) parses the trajectory back into our common
schema, and (d) writes the run-meta.

Setup required (one-time):
    bench/scripts/setup_openhands.sh    # clones External/OpenHands
    cd bench/external/OpenHands && make build && docker info  # heavy

Two modes:
    --stub            deterministic synthetic trace, no OpenHands required
                      (offline smoke for CI / pipeline shakedown).
    default           shells out to OpenHands' run_infer.sh.

Notion spec sections 1.1, 2.1, 5.1, 5.3, 13.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from _common import BENCH_ROOT, DATA_DIR, RunPaths, load_json, read_jsonl, write_jsonl
from llm_client import load_model_spec

OPENHANDS_DIR = BENCH_ROOT / "external" / "OpenHands"
OPENHANDS_RUN_INFER = OPENHANDS_DIR / "evaluation/benchmarks/swe_bench/scripts/run_infer.sh"
OPENHANDS_CONFIG_NAME = "bench_runtime"  # `[llm.bench_runtime]` block we generate
OPENHANDS_OUTPUT_ROOT = OPENHANDS_DIR / "evaluation/evaluation_outputs/outputs"

ENV_KEY_BY_PROVIDER = {
    "ollama_cloud": "OLLAMA_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--benchmark", choices=["swebench_lite", "swebench_verified"], required=True)
    p.add_argument("--task-fixture", required=True, help="Path to a SWE-bench task JSON.")
    p.add_argument("--agent", default="openhands", choices=["openhands", "swe_agent"])
    p.add_argument("--model", required=True, help="Model id from configs/models.yaml")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--max-iter", type=int, default=30, help="Per-instance iteration cap passed to OpenHands.")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--stub", action="store_true", help="Skip OpenHands; write a deterministic synthetic trace.")
    p.add_argument("--skip-if-cached", action="store_true")
    return p.parse_args()


def make_run_id(args: argparse.Namespace, task_id: str) -> str:
    safe_model = args.model.replace("/", "_").replace(":", "_")
    return f"{args.benchmark}__{task_id}__{args.agent}__{safe_model}__seed{args.seed}"


def trace_path(run_id: str) -> Path:
    return DATA_DIR / "raw_runs" / f"{run_id}.trace.jsonl"


def stub_trace(task: dict[str, Any]) -> list[dict[str, Any]]:
    """Deterministic 4-row trace for offline smoke / CI. Matches adapter_openhands."""
    now = datetime.now(timezone.utc).isoformat()
    files = task.get("candidate_files", []) or []
    return [
        {"timestamp": now, "action": "read", "args": "open issue body",
         "observation": (task.get("problem_statement") or "")[:200],
         "llm_metrics": {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}},
        {"timestamp": now, "action": "grep", "args": "search likely symbol",
         "observation": "stub: no real grep performed",
         "llm_metrics": {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}},
        {"timestamp": now, "action": "edit", "args": "stub patch",
         "observation": "stub: no real edit performed",
         "files_edited": files,
         "llm_metrics": {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}},
        {"timestamp": now, "action": "test", "args": task.get("test_command", ""),
         "observation": "stub: tests not executed",
         "tests_run": [task.get("test_command", "")], "test_result": "skipped",
         "llm_metrics": {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}},
    ]


def litellm_config_block(spec, api_key: str) -> str:
    """Render a `[llm.<OPENHANDS_CONFIG_NAME>]` section for OpenHands' config.toml.

    Ollama Cloud is OpenAI-compatible, so we use the litellm `openai/<model>`
    convention with a custom `base_url`. Native OpenAI / Anthropic skip the
    base_url and use their native litellm prefix.
    """
    if spec.provider == "ollama_cloud":
        model = f"openai/{spec.wire_model}"
        base_url = "https://ollama.com/v1"
    elif spec.provider == "openai":
        model = spec.wire_model
        base_url = ""
    elif spec.provider == "anthropic":
        model = f"anthropic/{spec.wire_model}"
        base_url = ""
    else:
        raise SystemExit(f"unsupported provider for OpenHands: {spec.provider}")

    lines = [f"[llm.{OPENHANDS_CONFIG_NAME}]", f'model = "{model}"', f'api_key = "{api_key}"']
    if base_url:
        lines.append(f'base_url = "{base_url}"')
    return "\n".join(lines) + "\n"


def write_openhands_config(spec, api_key: str) -> Path:
    """Append our generated llm block to OpenHands' config.toml (preserving existing blocks)."""
    config_path = OPENHANDS_DIR / "config.toml"
    existing = config_path.read_text() if config_path.exists() else ""
    block = litellm_config_block(spec, api_key)
    # Strip any prior block we wrote so re-runs don't duplicate it.
    marker = f"[llm.{OPENHANDS_CONFIG_NAME}]"
    if marker in existing:
        head, _, tail = existing.partition(marker)
        # Drop everything from our block to the next [section] header.
        rest = tail.split("\n[", 1)
        existing = head + ("[" + rest[1] if len(rest) > 1 else "")
    config_path.write_text(existing.rstrip() + "\n\n" + block)
    return config_path


def find_openhands_output() -> Path | None:
    """OpenHands writes one output.jsonl per (agent, model, run) under evaluation_outputs/.
    We mtime-sort and pick the newest, which is the run we just kicked off.
    """
    if not OPENHANDS_OUTPUT_ROOT.exists():
        return None
    candidates = sorted(OPENHANDS_OUTPUT_ROOT.rglob("output.jsonl"), key=lambda p: p.stat().st_mtime)
    return candidates[-1] if candidates else None


def trajectory_to_trace(record: dict[str, Any]) -> list[dict[str, Any]]:
    """Map one OpenHands SWE-bench output row → adapter_openhands-shaped trace rows.

    OpenHands' record carries `history` (list of action/observation events) plus
    aggregate `metrics`. Field names track upstream — adjust here if they drift.
    """
    rows: list[dict[str, Any]] = []
    history = record.get("history") or []
    for ev in history:
        if not isinstance(ev, dict):
            continue
        action = ev.get("action") or ev.get("event_type") or "observation"
        rows.append({
            "timestamp": ev.get("timestamp"),
            "action": action,
            "args": ev.get("args") or ev.get("thought") or "",
            "observation": ev.get("observation") or ev.get("content") or "",
            "files_read": ev.get("files_read") or [],
            "files_edited": ev.get("files_edited") or [],
            "tests_run": ev.get("tests_run") or [],
            "test_result": ev.get("test_result"),
            "latency_ms": ev.get("latency_ms"),
            "llm_metrics": ev.get("llm_metrics") or {},
            "error": ev.get("error"),
        })
    return rows


def run_via_openhands(args: argparse.Namespace, task: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Returns (trace_rows, openhands_record). Raises SystemExit on misconfig."""
    if not OPENHANDS_RUN_INFER.exists():
        raise SystemExit(
            f"OpenHands not found at {OPENHANDS_DIR}.\n"
            "Run: bench/scripts/setup_openhands.sh\n"
            "Then follow the printed setup steps (poetry install + Docker).")

    spec = load_model_spec(args.model)
    env_key = ENV_KEY_BY_PROVIDER.get(spec.provider)
    api_key = os.environ.get(env_key or "")
    if not api_key:
        raise SystemExit(f"{env_key} not set; required for provider {spec.provider}")

    write_openhands_config(spec, api_key)

    dataset = "princeton-nlp/SWE-bench_Lite" if args.benchmark == "swebench_lite" else "princeton-nlp/SWE-bench_Verified"
    cmd = [
        "bash", str(OPENHANDS_RUN_INFER),
        f"llm.{OPENHANDS_CONFIG_NAME}",
        "HEAD",
        "CodeActAgent",
        "1",                  # eval_limit
        str(args.max_iter),
        "1",                  # num_workers
        dataset,
        "test",
    ]
    # OpenHands honors INSTANCE_IDS to filter the dataset to a single task.
    env = {**os.environ, "INSTANCE_IDS": task["instance_id"]}
    print(f"[run_swebench] invoking OpenHands: {' '.join(cmd)}")
    rc = subprocess.call(cmd, cwd=str(OPENHANDS_DIR), env=env)
    if rc != 0:
        raise SystemExit(f"OpenHands run_infer.sh exited with code {rc}")

    out = find_openhands_output()
    if not out:
        raise SystemExit(
            f"OpenHands ran but no output.jsonl found under {OPENHANDS_OUTPUT_ROOT}.\n"
            "Check OpenHands logs and adjust find_openhands_output() if the layout changed.")

    record = next(
        (r for r in read_jsonl(out) if r.get("instance_id") == task["instance_id"]),
        None,
    )
    if record is None:
        raise SystemExit(f"output.jsonl at {out} contained no row for {task['instance_id']}")
    return trajectory_to_trace(record), record


def write_run_meta(args: argparse.Namespace, task: dict[str, Any], paths: RunPaths,
                   rows: list[dict[str, Any]], record: dict[str, Any] | None,
                   start: str) -> None:
    metrics = (record or {}).get("metrics") or {}
    test_result = (record or {}).get("test_result") or {}
    # OpenHands SWE-bench eval reports resolved=True/False after eval_infer.sh runs;
    # before eval, success is unknown. Surface what we have.
    success = test_result.get("resolved") if record else False

    meta = {
        "run_id": paths.run_id,
        "benchmark": args.benchmark,
        "task_id": task.get("instance_id"),
        "agent_framework": args.agent,
        "model": args.model,
        "seed": args.seed,
        "start_time": start,
        "end_time": datetime.now(timezone.utc).isoformat(),
        "success": success,
        "total_input_tokens": int(metrics.get("input_tokens", 0)),
        "total_output_tokens": int(metrics.get("output_tokens", 0)),
        "total_cost_usd": float(metrics.get("cost_usd", 0.0)),
        "trace_path": str(trace_path(paths.run_id)),
        "events_path": str(paths.events),
        "n_steps": len(rows),
        "openhands_output": str(record.get("_source_path")) if record and "_source_path" in record else None,
    }
    paths.run_meta.parent.mkdir(parents=True, exist_ok=True)
    paths.run_meta.write_text(json.dumps(meta, indent=2, sort_keys=True))


def maybe_convert_events(run_id: str) -> int:
    script = Path(__file__).with_name("convert_to_events.py")
    cmd = [sys.executable, str(script),
           "--input", str(trace_path(run_id)),
           "--run-id", run_id,
           "--adapter", "openhands"]
    return subprocess.call(cmd)


def main() -> int:
    args = parse_args()
    fixture = Path(args.task_fixture)
    if not fixture.exists():
        print(f"task fixture not found: {fixture}", file=sys.stderr)
        return 1
    task = load_json(fixture)
    task_id = task.get("instance_id")
    if not task_id:
        print(f"fixture missing instance_id: {fixture}", file=sys.stderr)
        return 1

    run_id = make_run_id(args, task_id)
    paths = RunPaths(run_id)
    start = datetime.now(timezone.utc).isoformat()

    if args.skip_if_cached and paths.run_meta.exists():
        print(f"[run_swebench] {run_id}: cached, skipping")
        return 0

    if args.dry_run:
        print(json.dumps({
            "run_id": run_id, "benchmark": args.benchmark, "task_id": task_id,
            "agent_framework": args.agent, "model": args.model, "seed": args.seed,
            "start_time": start,
            "trace_path": str(trace_path(run_id)), "events_path": str(paths.events),
            "stub": args.stub,
            "openhands_dir_present": OPENHANDS_RUN_INFER.exists(),
        }, indent=2))
        return 0

    if args.stub:
        rows = stub_trace(task)
        record = None
    else:
        rows, record = run_via_openhands(args, task)

    write_jsonl(trace_path(run_id), rows)
    write_run_meta(args, task, paths, rows, record, start)
    print(f"[run_swebench] {run_id}: {len(rows)} steps")
    print(f"  trace → {trace_path(run_id)}")
    print(f"  meta  → {paths.run_meta}")

    rc = maybe_convert_events(run_id)
    return 0 if rc == 0 else 4


if __name__ == "__main__":
    raise SystemExit(main())
