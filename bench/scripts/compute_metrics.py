#!/usr/bin/env python3
"""Compute Layer 1/2/3 metrics across runs.

Layer 1 (agent execution):  success_rate, total_cost_usd, mean_latency_sec
Layer 2 (diagnosis):        root_cause_accuracy, first_failure_accuracy,
                            within_k_accuracy, mean_diagnosis_time
Layer 3 (repair):           post_repair_success_rate, delta_success,
                            token_cost_change, regression_rate

Notion spec section 10.

Inputs:
  --runs        directory of raw_runs/*.json    (one run-meta JSON per run)
  --annotations directory of annotations/*.json (ground-truth labels)
  --diagnoses   directory of outputs/diagnosis_results/*.json (UI study output, optional)
  --repairs     directory of outputs/repair_results/*.json    (post-repair runs, optional)
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path
from typing import Any

from _common import DATA_DIR, OUT_DIR, load_json


def _glob_json(d: Path) -> list[dict[str, Any]]:
    if not d.exists():
        return []
    return [load_json(p) for p in sorted(d.glob("*.json"))]


def layer1(runs: list[dict[str, Any]]) -> dict[str, Any]:
    if not runs:
        return {}
    successes = [bool(r.get("success")) for r in runs]
    costs = [float(r.get("total_cost_usd") or 0.0) for r in runs]
    latencies = [float(r.get("latency_sec") or 0.0) for r in runs]
    return {
        "n_runs": len(runs),
        "success_rate": sum(successes) / len(successes),
        "total_cost_usd": sum(costs),
        "mean_cost_usd": statistics.fmean(costs),
        "mean_latency_sec": statistics.fmean(latencies),
    }


def layer2(annotations: list[dict[str, Any]], diagnoses: list[dict[str, Any]], k: int = 3) -> dict[str, Any]:
    """Match diagnoses (one per (run_id, condition_id, participant_id)) against annotations."""
    if not annotations or not diagnoses:
        return {}
    truth = {a["run_id"]: a for a in annotations}
    by_condition: dict[str, list[dict[str, Any]]] = {}
    for d in diagnoses:
        by_condition.setdefault(d.get("condition_id", "unknown"), []).append(d)

    out: dict[str, Any] = {"n_annotations": len(annotations), "by_condition": {}}
    for cond, rows in by_condition.items():
        rc_hits = ff_hits = wk_hits = repair_hits = 0
        diag_times: list[float] = []
        for d in rows:
            t = truth.get(d.get("run_id"))
            if not t:
                continue
            if d.get("root_cause_label") == t.get("root_cause_label"):
                rc_hits += 1
            if d.get("first_failure_event_id") == t.get("first_failure_event_id"):
                ff_hits += 1
            if _within_k(d.get("first_failure_event_id"), t.get("first_failure_event_id"), k):
                wk_hits += 1
            if d.get("recommended_repair_type") == t.get("recommended_repair_type"):
                repair_hits += 1
            if (dt := d.get("diagnosis_time_sec")) is not None:
                diag_times.append(float(dt))
        n = len(rows)
        out["by_condition"][cond] = {
            "n": n,
            "root_cause_accuracy": rc_hits / n if n else 0.0,
            "first_failure_accuracy": ff_hits / n if n else 0.0,
            f"within_{k}_accuracy": wk_hits / n if n else 0.0,
            "repair_selection_accuracy": repair_hits / n if n else 0.0,
            "mean_diagnosis_time_sec": statistics.fmean(diag_times) if diag_times else None,
        }
    return out


def _within_k(predicted: str | None, truth: str | None, k: int) -> bool:
    """Cheap fallback when both are 'e_00042'-style; otherwise require exact match."""
    if predicted is None or truth is None:
        return False
    if predicted == truth:
        return True
    try:
        pi = int(predicted.split("_")[-1])
        ti = int(truth.split("_")[-1])
        return abs(pi - ti) <= k
    except ValueError:
        return False


def layer3(runs: list[dict[str, Any]], repairs: list[dict[str, Any]]) -> dict[str, Any]:
    if not repairs:
        return {}
    base = {r["run_id"]: r for r in runs}
    succ_before = succ_after = regressions = 0
    cost_delta: list[float] = []
    for rep in repairs:
        rid = rep.get("base_run_id")
        before = base.get(rid)
        if not before:
            continue
        if before.get("success"):
            succ_before += 1
            if not rep.get("success"):
                regressions += 1
        if rep.get("success"):
            succ_after += 1
        if before.get("total_cost_usd") is not None and rep.get("total_cost_usd") is not None:
            cost_delta.append(float(rep["total_cost_usd"]) - float(before["total_cost_usd"]))
    n = len(repairs)
    return {
        "n_repaired_runs": n,
        "post_repair_success_rate": succ_after / n if n else 0.0,
        "delta_success": (succ_after - succ_before) / n if n else 0.0,
        "regression_rate": regressions / n if n else 0.0,
        "mean_cost_change_usd": statistics.fmean(cost_delta) if cost_delta else None,
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--runs", default=str(DATA_DIR / "raw_runs"))
    p.add_argument("--annotations", default=str(DATA_DIR / "annotations"))
    p.add_argument("--diagnoses", default=str(OUT_DIR / "diagnosis_results"))
    p.add_argument("--repairs", default=str(OUT_DIR / "repair_results"))
    p.add_argument("--output", default=str(OUT_DIR / "cost_reports" / "metrics.json"))
    p.add_argument("--within-k", type=int, default=3)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    runs = _glob_json(Path(args.runs))
    annotations = _glob_json(Path(args.annotations))
    diagnoses = _glob_json(Path(args.diagnoses))
    repairs = _glob_json(Path(args.repairs))

    report = {
        "layer1_execution": layer1(runs),
        "layer2_diagnosis": layer2(annotations, diagnoses, k=args.within_k),
        "layer3_repair": layer3(runs, repairs),
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"\nwrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
