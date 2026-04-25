"""Shared helpers for Visually-3D bench scripts.

Kept dependency-light on purpose: stdlib only so the harness runs before any
heavy framework (OpenHands, BrowserGym, SWE-bench) is installed.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator

REPO_ROOT = Path(__file__).resolve().parents[2]
BENCH_ROOT = REPO_ROOT / "bench"
DATA_DIR = BENCH_ROOT / "data"
OUT_DIR = BENCH_ROOT / "outputs"
SCHEMA_DIR = BENCH_ROOT / "schemas"


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False, sort_keys=True))
            fh.write("\n")
            n += 1
    return n


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


@dataclass
class RunPaths:
    """Canonical on-disk locations for a single run."""

    run_id: str

    @property
    def run_meta(self) -> Path:
        return DATA_DIR / "raw_runs" / f"{self.run_id}.json"

    @property
    def events(self) -> Path:
        return DATA_DIR / "events" / f"{self.run_id}.jsonl"

    @property
    def annotation(self) -> Path:
        return DATA_DIR / "annotations" / f"{self.run_id}.json"

    @property
    def graph(self) -> Path:
        return DATA_DIR / "graphs" / f"{self.run_id}.json"
