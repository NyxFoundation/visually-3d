#!/usr/bin/env bash
# One-time setup for the OpenHands SWE-bench evaluator.
#
# Clones All-Hands-AI/OpenHands at a pinned tag into bench/external/OpenHands.
# Does NOT install dependencies or build their Docker images — those are
# heavy / interactive / sometimes need sudo. After this script finishes,
# follow the printed next steps manually.
#
# Usage:  bench/scripts/setup_openhands.sh [--ref <git-ref>]
set -euo pipefail

REF="${REF:-main}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ref) REF="$2"; shift 2 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

bench_dir="$(cd "$(dirname "$0")/.." && pwd)"
target="$bench_dir/external/OpenHands"

if [[ -d "$target/.git" ]]; then
    echo "[setup-openhands] already cloned at $target — fetching $REF"
    git -C "$target" fetch --depth 1 origin "$REF"
    git -C "$target" checkout FETCH_HEAD
else
    echo "[setup-openhands] cloning All-Hands-AI/OpenHands @ $REF → $target"
    mkdir -p "$bench_dir/external"
    git clone --depth 1 --branch "$REF" \
        https://github.com/All-Hands-AI/OpenHands.git "$target"
fi

cat <<EOF

[setup-openhands] clone ready at: $target

Next steps (run manually — heavy + interactive):
  1. Install OpenHands deps:
       cd $target
       make build         # poetry install + frontend deps
  2. Make sure Docker is running (the SWE-bench runtime pulls images per repo).
  3. Verify:
       cd $target
       ./evaluation/benchmarks/swe_bench/scripts/run_infer.sh --help

When that all works, drive a single task from this repo with:
  OLLAMA_API_KEY=... python bench/scripts/run_swebench.py \\
      --benchmark swebench_lite \\
      --task-fixture bench/fixtures/swebench_lite/django__django-10914.json \\
      --agent openhands --model qwen-coder-32b --seed 1
EOF
