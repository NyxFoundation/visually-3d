#!/usr/bin/env sh
# self-improve — recursively self-improve a visually-3d scene, with VLM visual
# feedback. Driven by the Codex CLI.
#
# Invoked through the Makefile:
#     make self-improve <name.json> [max-iterations]
#     make self-improve apollo-csm.json 5
#
# Each iteration:
#   1. renders the current scene to a 2x2 contact-sheet PNG (offscreen, no GPU);
#   2. runs `codex exec` with that PNG attached, so the model critiques the
#      scene *visually* as well as from the JSON, then returns an improved scene;
#   3. validates and writes the improved scene back;
#   4. repeats until the model reports "converged", the rubric score stops
#      rising, or max-iterations is reached (default 4).
#
# Every artifact of every iteration — prompt, attached render, raw model
# output, extracted review, and the scene before/after — is kept under
# .self-improve/<scene>-<timestamp>/ so the whole trial-and-error history is
# auditable. That directory is git-ignored but accumulates locally.
#
# Env: CODEX_BIN overrides the Codex CLI executable (default: codex).

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_FILE="$ROOT/prompts/self-improve.md"
RENDER="$ROOT/scripts/render-scene.mjs"
APPLY="$ROOT/scripts/self-improve-apply.mjs"
SAMPLES_DIR="$ROOT/public/samples"
MAX_ITERS="${2:-4}"
CODEX_BIN="${CODEX_BIN:-codex}"

die() { echo "self-improve: $*" >&2; exit 1; }

[ $# -ge 1 ] || die "usage: make self-improve <name.json> [max-iterations]"
[ -f "$PROMPT_FILE" ] || die "missing prompt file: $PROMPT_FILE"
[ -f "$RENDER" ] || die "missing renderer: $RENDER"
[ -f "$APPLY" ] || die "missing helper: $APPLY"
command -v "$CODEX_BIN" >/dev/null 2>&1 || die "Codex CLI '$CODEX_BIN' not on PATH"
command -v node >/dev/null 2>&1 || die "node not on PATH"

# Accept either a bare sample name or an explicit path.
case "$1" in
  /*|./*|*/*) TARGET="$1" ;;
  *)          TARGET="$SAMPLES_DIR/$1" ;;
esac
[ -f "$TARGET" ] || die "no such scene: $TARGET"

case "$MAX_ITERS" in
  ''|*[!0-9]*) die "max-iterations must be a positive integer, got '$MAX_ITERS'" ;;
esac

STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$ROOT/.self-improve/$(basename "$TARGET" .json)-$STAMP"
mkdir -p "$RUN_DIR"
cp "$TARGET" "$RUN_DIR/iter-00.json"
RUN_LOG="$RUN_DIR/run.log"

# say: echo to console and append to the run log.
say() { echo "$@"; echo "$@" >> "$RUN_LOG"; }

say "self-improve: $TARGET"
say "             history -> $RUN_DIR"
say "             driver   -> $CODEX_BIN (visual feedback enabled)"
say "             up to $MAX_ITERS iteration(s)"

i=1
while [ "$i" -le "$MAX_ITERS" ]; do
  ii="$(printf '%02d' "$i")"
  say ""
  say "──────── iteration $i / $MAX_ITERS ────────"

  # 1. render the current scene for the visual critique.
  RENDER_PNG="$RUN_DIR/iter-$ii-render.png"
  node "$RENDER" "$TARGET" "$RENDER_PNG" >> "$RUN_LOG" 2>&1 \
    || die "renderer failed on iteration $i — see $RUN_LOG"
  say "  rendered -> $(basename "$RENDER_PNG")"

  # 2. build the prompt: instructions, optional carried-over reflection, data last.
  PROMPT_TXT="$RUN_DIR/iter-$ii-prompt.txt"
  {
    cat "$PROMPT_FILE"
    if [ -f "$RUN_DIR/last-review.json" ]; then
      echo
      echo "## Carried-over reflection (from the previous iteration)"
      echo
      echo "Address these gaps first — the previous pass could not yet close them:"
      echo
      echo '```json'
      cat "$RUN_DIR/last-review.json"
      echo '```'
    fi
    echo
    echo "## Current scene to improve"
    echo
    echo '```json'
    cat "$TARGET"
    echo '```'
  } > "$PROMPT_TXT"

  # 3. run Codex with the render attached. --json streams every event — the
  #    model's full reasoning/thinking trace — to a JSONL file; --output-last-
  #    message captures the clean final answer for the validator.
  MESSAGE="$RUN_DIR/iter-$ii-message.txt"
  EVENTS="$RUN_DIR/iter-$ii-events.jsonl"
  CODEX_ERR="$RUN_DIR/iter-$ii-codex.err"
  if ! "$CODEX_BIN" exec \
        --json \
        --sandbox read-only \
        --skip-git-repo-check \
        --image "$RENDER_PNG" \
        --output-last-message "$MESSAGE" \
        "$(cat "$PROMPT_TXT")" > "$EVENTS" 2> "$CODEX_ERR"; then
    die "Codex CLI failed on iteration $i — see $CODEX_ERR and $EVENTS"
  fi
  [ -s "$MESSAGE" ] || die "Codex produced no final message on iteration $i — see $EVENTS"
  say "  codex done (thinking trace: $(basename "$EVENTS"), $(wc -l < "$EVENTS" | tr -d ' ') events)"

  # 4. validate + apply the returned scene; exit code drives the loop.
  APPLY_LOG="$RUN_DIR/iter-$ii-apply.log"
  set +e
  node "$APPLY" "$MESSAGE" "$TARGET" "$RUN_DIR" "$ii" > "$APPLY_LOG" 2>&1
  rc=$?
  set -e
  cat "$APPLY_LOG"
  cat "$APPLY_LOG" >> "$RUN_LOG"

  case "$rc" in
    0)  ;;
    10) say ""; say "self-improve: model reports convergence — stopping."; break ;;
    20) say ""; say "self-improve: no further gain — stopping."; break ;;
    *)  die "could not apply iteration $i (see $MESSAGE and $CODEX_LOG)" ;;
  esac

  i=$((i + 1))
done

say ""
say "self-improve: done. Improved scene written to $TARGET"
say "             full history: $RUN_DIR"
say "             review change: git diff -- $TARGET"
say "             revert:        cp $RUN_DIR/iter-00.json $TARGET"
