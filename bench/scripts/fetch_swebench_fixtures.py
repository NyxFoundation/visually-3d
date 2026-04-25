#!/usr/bin/env python3
"""Materialize SWE-bench Lite task fixtures from the HuggingFace datasets-server.

Stdlib-only. Pulls N rows from `princeton-nlp/SWE-bench_Lite`, transforms each
into our local fixture schema, and writes one JSON file per task into
`bench/fixtures/swebench_lite/<instance_id>.json`. Idempotent: skips fixtures
that already exist unless --force is given.

Why a fetcher and not vendoring the dataset: SWE-bench Lite is small (~300
tasks) but storing the whole thing inflates the repo and gets stale. Pulling
on demand keeps the working set tiny while the run-meta records the upstream
revision so a re-fetch is reproducible.

Notion spec section 1.1.

Usage:
    python scripts/fetch_swebench_fixtures.py            # default: 10 tasks, offset 0
    python scripts/fetch_swebench_fixtures.py -n 50 --offset 100
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from _common import BENCH_ROOT

DATASET = "princeton-nlp/SWE-bench_Lite"
DEFAULT_CONFIG = "default"
DEFAULT_SPLIT = "test"
ROWS_ENDPOINT = "https://datasets-server.huggingface.co/rows"
PAGE_SIZE = 100  # datasets-server rejects length > 100

PATCH_FILE_RE = re.compile(r"^\+\+\+ b/(\S+)", re.MULTILINE)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-n", "--num", type=int, default=10, help="How many tasks to materialize.")
    p.add_argument("--offset", type=int, default=0, help="Starting row offset in the dataset.")
    p.add_argument("--config", default=DEFAULT_CONFIG)
    p.add_argument("--split", default=DEFAULT_SPLIT)
    p.add_argument("--force", action="store_true", help="Overwrite fixtures that already exist.")
    p.add_argument("--out-dir", type=Path,
                   default=BENCH_ROOT / "fixtures" / "swebench_lite",
                   help="Where to write per-task JSON fixtures.")
    return p.parse_args()


def fetch_rows(config: str, split: str, offset: int, length: int) -> list[dict[str, Any]]:
    """Fan out to the datasets-server in PAGE_SIZE chunks. Returns the row dicts."""
    rows: list[dict[str, Any]] = []
    while len(rows) < length:
        chunk = min(PAGE_SIZE, length - len(rows))
        params = urllib.parse.urlencode({
            "dataset": DATASET,
            "config": config,
            "split": split,
            "offset": offset + len(rows),
            "length": chunk,
        })
        url = f"{ROWS_ENDPOINT}?{params}"
        req = urllib.request.Request(url, headers={"User-Agent": "visually-3d-bench/0.1"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        page = payload.get("rows") or []
        if not page:
            break
        rows.extend(r["row"] for r in page)
    return rows[:length]


def candidate_files_from_patch(patch: str | None) -> list[str]:
    if not patch:
        return []
    seen: list[str] = []
    for path in PATCH_FILE_RE.findall(patch):
        if path not in seen and path != "/dev/null":
            seen.append(path)
    return seen


def test_command(row: dict[str, Any]) -> str:
    """Build a minimal pytest command from FAIL_TO_PASS, falling back to repo-level pytest."""
    raw = row.get("FAIL_TO_PASS")
    tests: list[str] = []
    if isinstance(raw, str):
        try:
            tests = json.loads(raw)
        except json.JSONDecodeError:
            tests = []
    elif isinstance(raw, list):
        tests = list(raw)
    if not tests:
        return "pytest -x"
    return "pytest -x " + " ".join(tests[:3])


def to_fixture(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "instance_id": row["instance_id"],
        "repo": row.get("repo"),
        "base_commit": row.get("base_commit"),
        "problem_statement": (row.get("problem_statement") or "").strip(),
        "hints_text": (row.get("hints_text") or "").strip(),
        "candidate_files": candidate_files_from_patch(row.get("patch")),
        "test_command": test_command(row),
        "source": {
            "dataset": DATASET,
            "split": DEFAULT_SPLIT,
            "version": row.get("version"),
        },
    }


def main() -> int:
    args = parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[fetch] {DATASET} split={args.split} offset={args.offset} num={args.num}")
    try:
        rows = fetch_rows(args.config, args.split, args.offset, args.num)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        print(f"[fetch] HTTP {exc.code} from datasets-server: {body}", file=sys.stderr)
        return 2
    except urllib.error.URLError as exc:
        print(f"[fetch] network error: {exc}", file=sys.stderr)
        return 2

    if not rows:
        print("[fetch] no rows returned", file=sys.stderr)
        return 1

    written = skipped = 0
    for row in rows:
        fixture = to_fixture(row)
        path = args.out_dir / f"{fixture['instance_id']}.json"
        if path.exists() and not args.force:
            skipped += 1
            continue
        path.write_text(json.dumps(fixture, indent=2, sort_keys=True) + "\n")
        written += 1

    print(f"[fetch] wrote {written}, skipped {skipped} (cached) → {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
