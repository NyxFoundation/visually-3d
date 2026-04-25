#!/usr/bin/env python3
"""Convert agent-native logs to the common event schema.

Reads a raw run dump (JSON or JSONL) and emits one event per agent step into
data/events/<run_id>.jsonl. Adapters live in this file as small functions —
add one per agent framework.

Notion spec section 5.2 + 5.3.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

from _common import RunPaths, read_jsonl, write_jsonl

Adapter = Callable[[Iterable[dict[str, Any]], str], Iterator[dict[str, Any]]]


def adapter_openhands(rows: Iterable[dict[str, Any]], run_id: str) -> Iterator[dict[str, Any]]:
    """Map OpenHands native trace rows to the common event schema.

    OpenHands emits one record per step with at minimum: timestamp, action_type,
    args, observation, llm_metrics. Update field names as upstream evolves.
    """
    prev_id: str | None = None
    for i, row in enumerate(rows):
        event_id = f"e_{i:05d}"
        action_type = row.get("action") or row.get("action_type") or "llm_call"
        event_type = _classify_openhands(action_type)
        evt = {
            "event_id": event_id,
            "run_id": run_id,
            "timestamp": row.get("timestamp"),
            "step_index": i,
            "event_type": event_type,
            "subtype": action_type,
            "input_summary": _truncate(row.get("args") or row.get("input")),
            "output_summary": _truncate(row.get("observation") or row.get("output")),
            "parent_event_ids": [prev_id] if prev_id else [],
            "dependency_type": ["temporal"] if prev_id else [],
            "latency_ms": row.get("latency_ms"),
            "input_tokens": (row.get("llm_metrics") or {}).get("input_tokens"),
            "output_tokens": (row.get("llm_metrics") or {}).get("output_tokens"),
            "estimated_cost_usd": (row.get("llm_metrics") or {}).get("cost_usd"),
            "error_flag": bool(row.get("error")),
            "domain": "coding",
            "coding": {
                "files_read": row.get("files_read") or [],
                "files_edited": row.get("files_edited") or [],
                "tests_run": row.get("tests_run") or [],
                "test_result": row.get("test_result"),
            },
        }
        yield {k: v for k, v in evt.items() if v is not None}
        prev_id = event_id


def adapter_browsergym(rows: Iterable[dict[str, Any]], run_id: str) -> Iterator[dict[str, Any]]:
    """Map BrowserGym/WebArena step records to the common event schema."""
    prev_id: str | None = None
    for i, row in enumerate(rows):
        event_id = f"e_{i:05d}"
        action = row.get("action") or "observation"
        event_type = _classify_browser(action)
        evt = {
            "event_id": event_id,
            "run_id": run_id,
            "timestamp": row.get("timestamp"),
            "step_index": i,
            "event_type": event_type,
            "subtype": action,
            "input_summary": _truncate(row.get("thought") or row.get("plan")),
            "output_summary": _truncate(row.get("observation")),
            "parent_event_ids": [prev_id] if prev_id else [],
            "dependency_type": ["temporal"] if prev_id else [],
            "latency_ms": row.get("latency_ms"),
            "input_tokens": row.get("input_tokens"),
            "output_tokens": row.get("output_tokens"),
            "estimated_cost_usd": row.get("cost_usd"),
            "error_flag": bool(row.get("error")),
            "domain": "web",
            "web": {
                "url": row.get("url"),
                "action": action,
                "target_element": row.get("target"),
                "screenshot_ref": row.get("screenshot"),
                "dom_snapshot_ref": row.get("dom"),
            },
        }
        yield {k: v for k, v in evt.items() if v is not None}
        prev_id = event_id


ADAPTERS: dict[str, Adapter] = {
    "openhands": adapter_openhands,
    "browsergym": adapter_browsergym,
}


def _classify_openhands(action: str) -> str:
    a = (action or "").lower()
    if a in {"run", "edit", "write", "patch"}:
        return "action"
    if a in {"read", "grep", "search", "ls"}:
        return "tool_call"
    if a in {"test", "check"}:
        return "evaluation"
    if a in {"observe", "observation"}:
        return "observation"
    return "llm_call"


def _classify_browser(action: str) -> str:
    a = (action or "").lower()
    if a in {"click", "type", "fill", "submit", "navigate", "scroll"}:
        return "action"
    if a in {"observe", "screenshot", "dom"}:
        return "observation"
    if a in {"plan", "think", "reason"}:
        return "llm_call"
    if a in {"eval", "evaluate", "verify"}:
        return "evaluation"
    return "tool_call"


def _truncate(value: Any, limit: int = 500) -> str | None:
    if value is None:
        return None
    s = value if isinstance(value, str) else repr(value)
    return s if len(s) <= limit else s[:limit] + "…"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", required=True, help="Path to native trace JSON/JSONL.")
    p.add_argument("--run-id", required=True)
    p.add_argument("--adapter", required=True, choices=sorted(ADAPTERS))
    p.add_argument("--output", help="Override output path.")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    src = Path(args.input)
    if not src.exists():
        print(f"input not found: {src}", file=sys.stderr)
        return 1

    if src.suffix == ".jsonl":
        rows = list(read_jsonl(src))
    else:
        import json as _j
        with src.open() as fh:
            data = _j.load(fh)
        rows = data if isinstance(data, list) else data.get("steps") or data.get("events") or []

    out_path = Path(args.output) if args.output else RunPaths(args.run_id).events
    n = write_jsonl(out_path, ADAPTERS[args.adapter](rows, args.run_id))
    print(f"wrote {n} events → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
