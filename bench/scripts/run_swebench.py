#!/usr/bin/env python3
"""Drive an SWE-bench Lite/Verified task through a minimal coding-agent loop.

This is the Phase-0 minimum: a 4-step ReAct-shaped loop (plan → inspect →
patch → evaluate) that produces a real LLM trace, writes the run meta, and
shells out to convert_to_events.py. It does **not** run patches against the
SWE-bench Docker images — that comes in Phase 1 once we vendor OpenHands or
SWE-agent. The harness is deliberately small enough to drive 10+ runs in
minutes for the Phase-0 acceptance check (README §"Phase 0 / Week 1–2").

Notion spec sections 1.1, 2.1, 5.1, 5.3, 13.

Usage:
    python scripts/run_swebench.py \\
        --benchmark swebench_lite \\
        --task-fixture fixtures/sample_swebench_task.json \\
        --agent openhands \\
        --model qwen-coder-32b \\
        --seed 1
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import textwrap
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from _common import DATA_DIR, RunPaths, load_json, write_jsonl
from llm_client import LLMClientError, LLMResponse, complete, load_model_spec

STEP_PLAN = "plan"
STEP_INSPECT = "read"
STEP_PATCH = "edit"
STEP_TEST = "test"

SYSTEM_PROMPT = textwrap.dedent(
    """
    You are a senior software engineer working on a SWE-bench task. You will
    receive the bug report and a list of likely files. Respond concisely — no
    preamble, no markdown headings — and stay under 200 words per turn unless
    asked for a diff.
    """
).strip()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--benchmark", choices=["swebench_lite", "swebench_verified"], required=True)
    p.add_argument("--task-fixture", required=True, help="Path to a SWE-bench task JSON.")
    p.add_argument("--agent", default="openhands", choices=["openhands", "swe_agent"])
    p.add_argument("--model", required=True, help="Model id from configs/models.yaml")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--max-tokens", type=int, default=1024)
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument("--dry-run", action="store_true", help="Print the plan and exit without calling any model.")
    p.add_argument("--stub", action="store_true", help="Skip LLM calls, write a deterministic synthetic trace (offline smoke).")
    p.add_argument("--skip-if-cached", action="store_true", help="Exit 0 without doing work if data/raw_runs/<run_id>.json already exists.")
    return p.parse_args()


def make_run_id(args: argparse.Namespace, task_id: str) -> str:
    safe_model = args.model.replace("/", "_").replace(":", "_")
    return f"{args.benchmark}__{task_id}__{args.agent}__{safe_model}__seed{args.seed}"


def trace_path(run_id: str) -> Path:
    # Sits beside RunPaths.run_meta (which is <run_id>.json).
    return DATA_DIR / "raw_runs" / f"{run_id}.trace.jsonl"


def build_messages(task: dict[str, Any], step: str, prior: list[dict[str, Any]]) -> list[dict[str, str]]:
    user = [
        f"Instance: {task.get('instance_id')}",
        f"Repo: {task.get('repo')}",
        f"Base commit: {task.get('base_commit')}",
        "",
        "Problem statement:",
        task.get("problem_statement", "").strip(),
    ]
    hints = task.get("hints_text")
    if hints:
        user += ["", "Hints:", hints.strip()]
    candidates = task.get("candidate_files") or []
    if candidates:
        user += ["", "Likely files: " + ", ".join(candidates)]

    if prior:
        user += ["", "Prior steps (most recent last):"]
        for row in prior:
            user.append(f"- [{row['action']}] {row.get('observation', '')[:200]}")

    if step == STEP_PLAN:
        user += [
            "",
            "Task: produce a 3-bullet plan for fixing this bug. Name the most",
            "likely root-cause function and the file it lives in.",
        ]
    elif step == STEP_INSPECT:
        user += [
            "",
            "Task: based on the plan, list up to 3 file paths you would open",
            "first and one specific symbol you would look up in each. Format",
            "as 'path :: symbol' on each line.",
        ]
    elif step == STEP_PATCH:
        user += [
            "",
            "Task: produce a unified diff (git format) that fixes the bug.",
            "Include only the changed hunks. No commentary, no prose.",
        ]
    elif step == STEP_TEST:
        user += [
            "",
            "Task: state in one sentence whether you expect the test command",
            f"`{task.get('test_command', '')}` to pass against your patch, and why.",
        ]

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(user)},
    ]


def stub_response(step: str) -> LLMResponse:
    canned = {
        STEP_PLAN: "1. Trace order_by() chain merging in QuerySet.\n2. Inspect query.py:order_by.\n3. Replace prior ordering instead of appending.",
        STEP_INSPECT: "django/db/models/query.py :: QuerySet.order_by\ndjango/db/models/sql/query.py :: Query.add_ordering",
        STEP_PATCH: "--- a/django/db/models/query.py\n+++ b/django/db/models/query.py\n@@\n-        obj.query.add_ordering(*field_names)\n+        obj.query.clear_ordering(force=True)\n+        obj.query.add_ordering(*field_names)\n",
        STEP_TEST: "Likely passes: clearing prior ordering before re-adding restores documented behavior.",
    }
    text = canned[step]
    return LLMResponse(text=text, input_tokens=0, output_tokens=0, cost_usd=0.0, latency_ms=0, raw={"stub": True})


def step_to_action(step: str) -> str:
    # Action names map cleanly to convert_to_events.adapter_openhands classification.
    return step


def run_steps(
    args: argparse.Namespace,
    task: dict[str, Any],
) -> tuple[list[dict[str, Any]], int, int, float]:
    spec = None if args.stub else load_model_spec(args.model)
    rows: list[dict[str, Any]] = []
    total_in = total_out = 0
    total_cost = 0.0

    for step in (STEP_PLAN, STEP_INSPECT, STEP_PATCH, STEP_TEST):
        ts = datetime.now(timezone.utc).isoformat()
        messages = build_messages(task, step, rows)
        if args.stub:
            resp = stub_response(step)
        else:
            assert spec is not None
            resp = complete(
                spec,
                messages,
                max_tokens=args.max_tokens,
                temperature=args.temperature,
            )

        files_field: dict[str, Any] = {}
        if step == STEP_INSPECT:
            files_field["files_read"] = task.get("candidate_files", [])
        elif step == STEP_PATCH:
            files_field["files_edited"] = task.get("candidate_files", [])
        elif step == STEP_TEST:
            files_field["tests_run"] = [task.get("test_command", "")]
            files_field["test_result"] = "skipped"

        row = {
            "timestamp": ts,
            "action": step_to_action(step),
            "args": messages[-1]["content"][:500],
            "observation": resp.text,
            "latency_ms": resp.latency_ms,
            "llm_metrics": {
                "input_tokens": resp.input_tokens,
                "output_tokens": resp.output_tokens,
                "cost_usd": resp.cost_usd,
            },
            **files_field,
        }
        rows.append(row)
        total_in += resp.input_tokens
        total_out += resp.output_tokens
        total_cost += resp.cost_usd

    return rows, total_in, total_out, total_cost


def write_run_meta(args: argparse.Namespace, task: dict[str, Any], paths: RunPaths,
                    rows: list[dict[str, Any]], total_in: int, total_out: int, total_cost: float,
                    start: str) -> None:
    meta = {
        "run_id": paths.run_id,
        "benchmark": args.benchmark,
        "task_id": task.get("instance_id"),
        "agent_framework": args.agent,
        "model": args.model,
        "seed": args.seed,
        "start_time": start,
        "end_time": datetime.now(timezone.utc).isoformat(),
        "success": False,  # Phase-0 driver does not actually run tests.
        "total_input_tokens": total_in,
        "total_output_tokens": total_out,
        "total_cost_usd": round(total_cost, 6),
        "trace_path": str(trace_path(paths.run_id)),
        "events_path": str(paths.events),
        "n_steps": len(rows),
    }
    paths.run_meta.parent.mkdir(parents=True, exist_ok=True)
    paths.run_meta.write_text(json.dumps(meta, indent=2, sort_keys=True))


def maybe_convert_events(run_id: str) -> int:
    script = Path(__file__).with_name("convert_to_events.py")
    cmd = [
        sys.executable,
        str(script),
        "--input",
        str(trace_path(run_id)),
        "--run-id",
        run_id,
        "--adapter",
        "openhands",
    ]
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
        print(f"[run_swebench] {run_id}: cached, skipping (use --force-style flag to recompute)")
        return 0

    if args.dry_run:
        print(json.dumps({
            "run_id": run_id,
            "benchmark": args.benchmark,
            "task_id": task_id,
            "agent_framework": args.agent,
            "model": args.model,
            "seed": args.seed,
            "start_time": start,
            "trace_path": str(trace_path(run_id)),
            "events_path": str(paths.events),
            "stub": args.stub,
        }, indent=2))
        return 0

    try:
        rows, total_in, total_out, total_cost = run_steps(args, task)
    except LLMClientError as exc:
        print(f"[run_swebench] LLM call failed: {exc}", file=sys.stderr)
        return 3

    write_jsonl(trace_path(run_id), rows)
    write_run_meta(args, task, paths, rows, total_in, total_out, total_cost, start)
    print(f"[run_swebench] {run_id}: {len(rows)} steps, "
          f"{total_in}/{total_out} tok, ${total_cost:.4f}")
    print(f"  trace → {trace_path(run_id)}")
    print(f"  meta  → {paths.run_meta}")

    rc = maybe_convert_events(run_id)
    return 0 if rc == 0 else 4


if __name__ == "__main__":
    raise SystemExit(main())
