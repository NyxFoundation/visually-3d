#!/usr/bin/env bash
# Phase-0 minimal baseline bench for OSS models on Ollama Cloud.
#
# Sweeps (model × task fixture × seed) for the OSS models in configs/models.yaml,
# dispatches to the right driver based on --benchmark, skips runs whose
# data/raw_runs/<run_id>.json already exists (cacheable across machines /
# contributors via git), and writes results to bench/data/.
#
# Usage:
#   OLLAMA_API_KEY=... bench/scripts/run_baseline_oss.sh                          # SWE-bench Lite
#   OLLAMA_API_KEY=... bench/scripts/run_baseline_oss.sh --benchmark webarena    # web baseline
#   OLLAMA_API_KEY=... bench/scripts/run_baseline_oss.sh --jobs 4 --dry-run
#
# Flags / env (flag wins):
#   --models     MODELS     comma-separated model ids       (default: qwen-coder-32b,gpt-oss-120b,deepseek-coder-7b)
#   --seeds      SEEDS      comma-separated seeds            (default: 1)
#   --fixtures   FIXTURES   comma-separated fixture paths    (default: every fixtures/<benchmark>/*.json)
#   --benchmark  BENCHMARK  swebench_lite|swebench_verified|webarena|browsergym  (default: swebench_lite)
#   --agent      AGENT      framework id                     (default per benchmark: openhands / react_browser)
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
BENCHMARK="${BENCHMARK:-swebench_lite}"
FIXTURES="${FIXTURES:-}"
AGENT="${AGENT:-}"
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
            sed -n '2,24p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

# Per-benchmark dispatch: driver script, default agent, default fixture dir.
case "$BENCHMARK" in
    swebench_lite|swebench_verified)
        DRIVER="scripts/run_swebench.py"
        : "${AGENT:=openhands}"
        fixture_dir="fixtures/swebench_lite"
        ;;
    webarena|browsergym)
        DRIVER="scripts/run_webarena.py"
        : "${AGENT:=react_browser}"
        fixture_dir="fixtures/webarena"
        ;;
    *)
        echo "error: unknown benchmark '$BENCHMARK'" >&2
        exit 2 ;;
esac

if [[ -z "$FIXTURES" ]]; then
    FIXTURES="$(find "$fixture_dir" -maxdepth 1 -name '*.json' 2>/dev/null | sort | paste -sd ',' -)"
fi
if [[ -z "$FIXTURES" ]]; then
    echo "error: no fixtures found under $fixture_dir/" >&2
    [[ "$BENCHMARK" == "swebench_lite" ]] && \
        echo "       run: python bench/scripts/fetch_swebench_fixtures.py" >&2
    exit 1
fi

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
echo "  benchmark : $BENCHMARK"
echo "  driver    : $DRIVER"
echo "  agent     : $AGENT"
echo "  models    : $MODELS"
echo "  seeds     : $SEEDS"
echo "  fixtures  : $(echo "$FIXTURES" | tr ',' '\n' | wc -l | tr -d ' ') file(s) from $fixture_dir/"
echo "  jobs      : $JOBS"
[[ -n "$FORCE" ]] && echo "  force     : on (ignore cache)"
[[ -n "$STUB"  ]] && echo "  stub      : on (no LLM calls)"

if [[ -n "$DRY_RUN" ]]; then
    echo "--- combos ---"
    cat "$combos_tsv"
    exit 0
fi

mkdir -p data/raw_runs data/events

extra_flags=()
[[ -z "$FORCE" ]] && extra_flags+=(--skip-if-cached)
[[ -n "$STUB"  ]] && extra_flags+=(--stub)

run_one() {
    local model="$1" seed="$2" fixture="$3"
    python3 "$DRIVER" \
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
    export BENCHMARK AGENT DRIVER
    extra_str="${extra_flags[*]:-}"
    export EXTRA_FLAGS="$extra_str"
    awk -F'\t' '{printf "%s\0%s\0%s\0", $1,$2,$3}' "$combos_tsv" \
        | xargs -0 -n3 -P "$JOBS" bash -c '
            python3 "$DRIVER" \
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
