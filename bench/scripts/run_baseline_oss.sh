#!/usr/bin/env bash
# Phase-0 minimal baseline bench for OSS models on Ollama Cloud.
#
# Sweeps (model × task fixture × seed) for the OSS models in configs/models.yaml,
# skips runs whose data/raw_runs/<run_id>.json already exists (cacheable across
# machines / contributors via git), and writes results to bench/data/.
#
# Usage:
#   OLLAMA_API_KEY=... bench/scripts/run_baseline_oss.sh
#   OLLAMA_API_KEY=... bench/scripts/run_baseline_oss.sh --jobs 4 --seeds 1,2,3,4
#   OLLAMA_API_KEY=... bench/scripts/run_baseline_oss.sh --dry-run
#
# Flags / env (flag wins):
#   --models     MODELS     comma-separated model ids       (default: qwen-coder-32b,gpt-oss-120b,deepseek-coder-7b)
#   --seeds      SEEDS      comma-separated seeds            (default: 1)
#   --fixtures   FIXTURES   comma-separated fixture paths    (default: every fixtures/swebench_lite/*.json)
#   --benchmark  BENCHMARK  swebench_lite|swebench_verified  (default: swebench_lite)
#   --agent      AGENT      openhands|swe_agent              (default: openhands)
#   --jobs       JOBS       parallel workers                 (default: 1)
#   --dry-run                print what would run, then exit
#   --force                  ignore cached run_meta and recompute
#   --stub                   skip live LLM calls; write deterministic synthetic
#                            traces (offline smoke; no OLLAMA_API_KEY required)
set -euo pipefail

bench_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$bench_dir"

MODELS="${MODELS:-qwen-coder-32b,gpt-oss-120b,deepseek-coder-7b}"
SEEDS="${SEEDS:-1}"

# Default fixture set: every JSON in fixtures/swebench_lite/ (populated by
# scripts/fetch_swebench_fixtures.py). Falls back to the single hand-written
# sample if the dir is empty so the script still runs in a fresh checkout.
default_fixtures="$(find fixtures/swebench_lite -maxdepth 1 -name '*.json' 2>/dev/null | sort | paste -sd ',' -)"
[[ -z "$default_fixtures" ]] && default_fixtures="fixtures/sample_swebench_task.json"
FIXTURES="${FIXTURES:-$default_fixtures}"
BENCHMARK="${BENCHMARK:-swebench_lite}"
AGENT="${AGENT:-openhands}"
JOBS="${JOBS:-1}"
DRY_RUN=""
FORCE=""
STUB=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --models)    MODELS="$2"; shift 2 ;;
        --seeds)     SEEDS="$2"; shift 2 ;;
        --fixtures)  FIXTURES="$2"; shift 2 ;;
        --benchmark) BENCHMARK="$2"; shift 2 ;;
        --agent)     AGENT="$2"; shift 2 ;;
        --jobs)      JOBS="$2"; shift 2 ;;
        --dry-run)   DRY_RUN=1; shift ;;
        --force)     FORCE=1; shift ;;
        --stub)      STUB=1; shift ;;
        -h|--help)
            sed -n '2,22p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

if [[ -z "${OLLAMA_API_KEY:-}" && -z "$DRY_RUN" && -z "$STUB" ]]; then
    echo "error: OLLAMA_API_KEY not set (Ollama Cloud — https://ollama.com)" >&2
    echo "       use --stub for an offline smoke run, or --dry-run to inspect the plan" >&2
    exit 1
fi

split() { tr ',' '\n' <<<"$1" | sed '/^$/d'; }

# Cartesian product → TSV: model<TAB>seed<TAB>fixture
combos_tsv="$(mktemp)"
trap 'rm -f "$combos_tsv"' EXIT
for model in $(split "$MODELS"); do
    for seed in $(split "$SEEDS"); do
        for fixture in $(split "$FIXTURES"); do
            printf '%s\t%s\t%s\n' "$model" "$seed" "$fixture"
        done
    done
done >"$combos_tsv"

n_total=$(wc -l <"$combos_tsv" | tr -d ' ')
echo "[baseline-oss] queued $n_total runs"
echo "  models    : $MODELS"
echo "  seeds     : $SEEDS"
echo "  fixtures  : $FIXTURES"
echo "  benchmark : $BENCHMARK"
echo "  agent     : $AGENT"
echo "  jobs      : $JOBS"
[[ -n "$FORCE" ]] && echo "  force     : on (ignore cache)"

if [[ -n "$DRY_RUN" ]]; then
    echo "--- combos ---"
    cat "$combos_tsv"
    exit 0
fi

mkdir -p data/raw_runs data/events

# Build the per-combo command list, then dispatch sequentially or via xargs -P.
extra_flags=()
[[ -z "$FORCE" ]] && extra_flags+=(--skip-if-cached)
[[ -n "$STUB"  ]] && extra_flags+=(--stub)

run_one() {
    local model="$1" seed="$2" fixture="$3"
    python3 scripts/run_swebench.py \
        --benchmark "$BENCHMARK" \
        --task-fixture "$fixture" \
        --agent "$AGENT" \
        --model "$model" \
        --seed "$seed" \
        "${extra_flags[@]}"
}

if [[ "$JOBS" -le 1 ]]; then
    while IFS=$'\t' read -r model seed fixture; do
        run_one "$model" "$seed" "$fixture" \
            || echo "  [warn] failed: model=$model seed=$seed fixture=$fixture" >&2
    done <"$combos_tsv"
else
    # xargs -P for portable parallelism. Each line of the TSV becomes one call.
    export BENCHMARK AGENT
    extra_str="${extra_flags[*]:-}"
    export EXTRA_FLAGS="$extra_str"
    awk -F'\t' '{printf "%s\0%s\0%s\0", $1,$2,$3}' "$combos_tsv" \
        | xargs -0 -n3 -P "$JOBS" bash -c '
            python3 scripts/run_swebench.py \
                --benchmark "$BENCHMARK" \
                --task-fixture "$2" \
                --agent "$AGENT" \
                --model "$0" \
                --seed "$1" \
                $EXTRA_FLAGS \
                || echo "  [warn] failed: model=$0 seed=$1 fixture=$2" >&2
        '
fi

echo "[baseline-oss] done."
echo "  raw_runs : $(find data/raw_runs -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')"
echo "  events   : $(find data/events   -maxdepth 1 -name '*.jsonl' | wc -l | tr -d ' ')"
