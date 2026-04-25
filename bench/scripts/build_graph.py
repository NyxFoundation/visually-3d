#!/usr/bin/env python3
"""Build a causal graph + 3D layout from a common-schema events.jsonl.

Output JSON shape:

    {
      "run_id": "...",
      "nodes": [
        {"id": "e_00000", "event_type": "...", "subtype": "...",
         "x": <step_index>, "y": <abstraction>, "z": <causal_depth>,
         "size": <cost_or_latency>, "color_key": "<failure_type|event_type>",
         "alpha": <confidence>, "first_failure": bool}
      ],
      "edges": [
        {"source": "e_00000", "target": "e_00001",
         "kind": "temporal|data|decision|environment|error_propagation|repair",
         "weight": <strength>}
      ]
    }

3D placement follows Notion spec section 6.3:
  X = step_index, Y = abstraction layer, Z = causal depth from first failure.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from _common import RunPaths, read_jsonl

ABSTRACTION_Y = {
    "llm_call": 3,        # plan / reason
    "tool_call": 2,
    "action": 2,          # action lives near tool_call vertically
    "observation": 1,
    "evaluation": 0,
    "repair": 4,
}


def build(events: list[dict[str, Any]], annotation: dict[str, Any] | None) -> dict[str, Any]:
    children: dict[str, list[str]] = defaultdict(list)
    for e in events:
        for p in e.get("parent_event_ids") or []:
            children[p].append(e["event_id"])

    first_failure = (annotation or {}).get("first_failure_event_id")
    propagated = set((annotation or {}).get("propagated_failure_event_ids") or [])
    causal_depth = _bfs_depth(children, first_failure) if first_failure else {}

    nodes = []
    for e in events:
        eid = e["event_id"]
        cost = e.get("estimated_cost_usd") or 0.0
        latency = (e.get("latency_ms") or 0) / 1000.0
        size = max(cost * 1000.0, latency, 1.0)
        color_key = (annotation or {}).get("root_cause_label") if eid in propagated or eid == first_failure else e.get("event_type")
        nodes.append(
            {
                "id": eid,
                "event_type": e.get("event_type"),
                "subtype": e.get("subtype"),
                "x": e.get("step_index", 0),
                "y": ABSTRACTION_Y.get(e.get("event_type", ""), 2),
                "z": causal_depth.get(eid, 0),
                "size": size,
                "color_key": color_key,
                "alpha": e.get("confidence", 1.0),
                "first_failure": eid == first_failure,
                "in_propagation": eid in propagated,
            }
        )

    edges = []
    for e in events:
        for p in e.get("parent_event_ids") or []:
            kinds = e.get("dependency_type") or ["temporal"]
            for k in kinds:
                edges.append(
                    {
                        "source": p,
                        "target": e["event_id"],
                        "kind": "error_propagation" if e["event_id"] in propagated and p in propagated else k,
                        "weight": 1.0,
                    }
                )

    return {
        "run_id": events[0]["run_id"] if events else None,
        "nodes": nodes,
        "edges": edges,
        "summary": {
            "first_failure_node": first_failure,
            "propagation_size": len(propagated),
            "node_count": len(nodes),
            "edge_count": len(edges),
        },
    }


def _bfs_depth(children: dict[str, list[str]], start: str) -> dict[str, int]:
    depth = {start: 0}
    q = deque([start])
    while q:
        cur = q.popleft()
        for nxt in children.get(cur, []):
            if nxt not in depth:
                depth[nxt] = depth[cur] + 1
                q.append(nxt)
    return depth


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run-id", required=True)
    p.add_argument("--events", help="Override events.jsonl path.")
    p.add_argument("--annotation", help="Override annotation.json path.")
    p.add_argument("--output", help="Override output graph.json path.")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    paths = RunPaths(args.run_id)

    events_path = Path(args.events) if args.events else paths.events
    if not events_path.exists():
        print(f"events not found: {events_path}", file=sys.stderr)
        return 1
    events = list(read_jsonl(events_path))

    annotation = None
    ann_path = Path(args.annotation) if args.annotation else paths.annotation
    if ann_path.exists():
        with ann_path.open() as fh:
            annotation = json.load(fh)

    graph = build(events, annotation)

    out_path = Path(args.output) if args.output else paths.graph
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        json.dump(graph, fh, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"wrote graph ({graph['summary']['node_count']} nodes, {graph['summary']['edge_count']} edges) → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
