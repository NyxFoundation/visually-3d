#!/usr/bin/env python3
"""Drive an SWE-bench Lite/Verified run through a coding agent.

Status: SCAFFOLD. The OpenHands / SWE-agent invocation is stubbed — fill in the
TODOs once the upstream framework is installed. Until then this script exits
non-zero so CI can flag missing wiring.

Notion spec sections 1.1, 2.1, 5.1, 5.3, 13.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone

from _common import RunPaths


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--benchmark", choices=["swebench_lite", "swebench_verified"], required=True)
    p.add_argument("--task-id", required=True, help="e.g. django__django-12345")
    p.add_argument("--agent", default="openhands", choices=["openhands", "swe_agent"])
    p.add_argument("--model", required=True, help="Model id from configs/models.yaml")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--dry-run", action="store_true", help="Print plan and exit.")
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
        "success": None,
        "raw_run_path": str(paths.run_meta),
        "events_path": str(paths.events),
    }

    if args.dry_run:
        import json as _j
        print(_j.dumps(plan, indent=2))
        return 0

    # TODO(phase-0): invoke OpenHands or SWE-agent here.
    #   - Spawn the agent CLI in a sandbox with the SWE-bench task fixture.
    #   - Stream native logs into data/raw_runs/<run_id>/.
    #   - On completion, call convert_to_events.py to produce data/events/<run_id>.jsonl.
    print(
        f"[run_swebench] {run_id}: agent driver not yet wired up. "
        "Install OpenHands (or SWE-agent), then implement the spawn/stream block.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
