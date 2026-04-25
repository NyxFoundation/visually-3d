#!/usr/bin/env python3
"""Drive a WebArena / BrowserGym task through a minimal browser-agent loop.

Phase-0 minimum, mirrors run_swebench.py: a 5-step ReAct-shaped loop
(plan → navigate → observe → act → evaluate) that produces a real LLM trace
in the browsergym-shaped action format, writes the run-meta, and shells out
to convert_to_events.py with the browsergym adapter. It does **not** drive
a real browser or the WebArena Docker stack — that arrives once we vendor
BrowserGym + Playwright.

Notion spec sections 1.2, 2.2, 5.1, 5.3, 13.

Usage:
    python scripts/run_webarena.py \\
        --benchmark webarena \\
        --task-fixture fixtures/webarena/shopping_search_red_dress.json \\
        --agent react_browser --model qwen-coder-32b --seed 1
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
STEP_NAVIGATE = "navigate"
STEP_OBSERVE = "observe"
STEP_ACT = "click"
STEP_EVAL = "eval"

SYSTEM_PROMPT = textwrap.dedent(
    """
    You are a browser agent navigating a web application to satisfy a user
    intent. Respond concisely — no preamble, no markdown headings — and stay
    under 150 words per turn.
    """
).strip()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--benchmark", choices=["webarena", "browsergym"], default="webarena")
    p.add_argument("--task-fixture", required=True, help="Path to a WebArena task JSON.")
    p.add_argument("--agent", default="react_browser", choices=["react_browser", "planner_executor"])
    p.add_argument("--model", required=True, help="Model id from configs/models.yaml")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--max-tokens", type=int, default=1024)
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--stub", action="store_true", help="Skip LLM calls, write a deterministic synthetic trace.")
    p.add_argument("--skip-if-cached", action="store_true", help="Exit 0 without doing work if data/raw_runs/<run_id>.json already exists.")
    return p.parse_args()


def make_run_id(args: argparse.Namespace, task_id: str) -> str:
    safe_model = args.model.replace("/", "_").replace(":", "_")
    safe_task = task_id.replace("/", "_")
    return f"{args.benchmark}__{safe_task}__{args.agent}__{safe_model}__seed{args.seed}"


def trace_path(run_id: str) -> Path:
    return DATA_DIR / "raw_runs" / f"{run_id}.trace.jsonl"


def build_messages(task: dict[str, Any], step: str, prior: list[dict[str, Any]]) -> list[dict[str, str]]:
    user = [
        f"Task: {task.get('task_id')}",
        f"Site: {task.get('site')}",
        f"Start URL: {task.get('start_url')}",
        "",
        f"Intent: {task.get('intent', '').strip()}",
    ]
    eval_block = task.get("evaluation") or {}
    if eval_block:
        user += ["", f"Success criterion: {eval_block.get('type')} = {eval_block.get('value')}"]

    if prior:
        user += ["", "Prior steps (most recent last):"]
        for row in prior:
            user.append(f"- [{row['action']}] {row.get('observation', '')[:160]}")

    if step == STEP_PLAN:
        user += [
            "",
            "Task: produce a 3-bullet plan for satisfying the intent. Name the",
            "first URL you would navigate to and the DOM landmark you'd look for.",
        ]
    elif step == STEP_NAVIGATE:
        user += [
            "",
            "Task: state the next URL to navigate to (one line, just the URL),",
            "and one sentence on why.",
        ]
    elif step == STEP_OBSERVE:
        user += [
            "",
            "Task: describe what you would expect to see on the page (key DOM",
            "elements / form fields / list items) in 2-3 short bullets.",
        ]
    elif step == STEP_ACT:
        user += [
            "",
            "Task: name the next concrete UI action (click / type / submit) and",
            "the target element selector. One line.",
        ]
    elif step == STEP_EVAL:
        user += [
            "",
            "Task: state in one sentence whether you expect the success",
            f"criterion ({eval_block.get('type')} = {eval_block.get('value')!r}) to hold,",
            "and why.",
        ]

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(user)},
    ]


def stub_response(step: str, task: dict[str, Any]) -> LLMResponse:
    canned = {
        STEP_PLAN: f"1. Open {task.get('start_url')}.\n2. Use search/filter to narrow to the target.\n3. Take the action implied by the intent and verify success.",
        STEP_NAVIGATE: task.get("start_url", "https://example.com"),
        STEP_OBSERVE: "- top nav with search bar\n- result list / form\n- primary CTA in upper right",
        STEP_ACT: "click button[data-test='primary-cta']",
        STEP_EVAL: "Likely passes: the action sequence ends on the success URL.",
    }
    return LLMResponse(text=canned[step], input_tokens=0, output_tokens=0, cost_usd=0.0, latency_ms=0, raw={"stub": True})


def run_steps(
    args: argparse.Namespace,
    task: dict[str, Any],
) -> tuple[list[dict[str, Any]], int, int, float]:
    spec = None if args.stub else load_model_spec(args.model)
    rows: list[dict[str, Any]] = []
    total_in = total_out = 0
    total_cost = 0.0
    current_url = task.get("start_url")

    for step in (STEP_PLAN, STEP_NAVIGATE, STEP_OBSERVE, STEP_ACT, STEP_EVAL):
        ts = datetime.now(timezone.utc).isoformat()
        messages = build_messages(task, step, rows)
        if args.stub:
            resp = stub_response(step, task)
        else:
            assert spec is not None
            resp = complete(
                spec,
                messages,
                max_tokens=args.max_tokens,
                temperature=args.temperature,
            )

        if step == STEP_NAVIGATE:
            # The model's reply is (ideally) a URL on its first line.
            current_url = resp.text.strip().splitlines()[0] if resp.text.strip() else current_url

        target = None
        if step == STEP_ACT:
            target = resp.text.strip().splitlines()[0] if resp.text.strip() else None

        row = {
            "timestamp": ts,
            "action": step,
            "thought": messages[-1]["content"][:400],
            "observation": resp.text,
            "url": current_url,
            "target": target,
            "latency_ms": resp.latency_ms,
            "input_tokens": resp.input_tokens,
            "output_tokens": resp.output_tokens,
            "cost_usd": resp.cost_usd,
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
        "task_id": task.get("task_id"),
        "agent_framework": args.agent,
        "model": args.model,
        "seed": args.seed,
        "start_time": start,
        "end_time": datetime.now(timezone.utc).isoformat(),
        "success": False,  # Phase-0 driver does not actually drive a browser.
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
        "browsergym",
    ]
    return subprocess.call(cmd)


def main() -> int:
    args = parse_args()
    fixture = Path(args.task_fixture)
    if not fixture.exists():
        print(f"task fixture not found: {fixture}", file=sys.stderr)
        return 1
    task = load_json(fixture)
    task_id = task.get("task_id")
    if not task_id:
        print(f"fixture missing task_id: {fixture}", file=sys.stderr)
        return 1

    run_id = make_run_id(args, task_id)
    paths = RunPaths(run_id)
    start = datetime.now(timezone.utc).isoformat()

    if args.skip_if_cached and paths.run_meta.exists():
        print(f"[run_webarena] {run_id}: cached, skipping")
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
        print(f"[run_webarena] LLM call failed: {exc}", file=sys.stderr)
        return 3

    write_jsonl(trace_path(run_id), rows)
    write_run_meta(args, task, paths, rows, total_in, total_out, total_cost, start)
    print(f"[run_webarena] {run_id}: {len(rows)} steps, "
          f"{total_in}/{total_out} tok, ${total_cost:.4f}")
    print(f"  trace → {trace_path(run_id)}")
    print(f"  meta  → {paths.run_meta}")

    rc = maybe_convert_events(run_id)
    return 0 if rc == 0 else 4


if __name__ == "__main__":
    raise SystemExit(main())
