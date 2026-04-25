#!/usr/bin/env python3
"""Drive a WebArena / BrowserGym task through a browser agent.

Status: SCAFFOLD. See run_swebench.py for the same pattern; the WebArena env
needs Docker + the per-domain seed images per the WebArena README.

Notion spec sections 1.2, 2.2, 5.1, 5.3, 13.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone

from _common import RunPaths


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--benchmark", choices=["webarena", "browsergym"], default="webarena")
    p.add_argument("--task-id", required=True, help="WebArena task id, e.g. shopping.42")
    p.add_argument("--agent", default="react_browser", choices=["react_browser", "planner_executor"])
    p.add_argument("--model", required=True)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def make_run_id(args: argparse.Namespace) -> str:
    return f"{args.benchmark}__{args.task_id}__{args.agent}__{args.model}__seed{args.seed}"


def main() -> int:
    args = parse_args()
    run_id = make_run_id(args)
    paths = RunPaths(run_id)

    plan = {
        "run_id": run_id,
        "benchmark": args.benchmark,
        "task_id": args.task_id,
        "agent_framework": args.agent,
        "model": args.model,
        "seed": args.seed,
        "start_time": datetime.now(timezone.utc).isoformat(),
        "raw_run_path": str(paths.run_meta),
        "events_path": str(paths.events),
    }

    if args.dry_run:
        import json as _j
        print(_j.dumps(plan, indent=2))
        return 0

    # TODO(phase-0): launch BrowserGym / WebArena env, attach the chosen agent,
    # capture per-step DOM + screenshot to data/screenshots/<run_id>/.
    print(
        f"[run_webarena] {run_id}: browser driver not yet wired up. "
        "Bring up the WebArena Docker stack, then implement the env+agent loop.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
