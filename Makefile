# visually-3d — developer tasks.
#
# Recursively self-improve a sample scene (Codex-driven, with VLM visual
# feedback from an offscreen render):
#
#     make self-improve <name.json> [max-iterations]
#     make self-improve apollo-csm.json 5
#
# Every iteration's prompt, attached render, JSONL thinking trace, model
# output and before/after scene is kept under .self-improve/ (git-ignored).

SHELL := /bin/sh

.PHONY: self-improve render build dev help

help:
	@echo "make self-improve <name.json> [iters]  recursively self-improve a sample scene"
	@echo "make render <name.json>                render a scene to .self-improve/<name>-preview.png"
	@echo "make build                             build the frontend (tsc + vite)"
	@echo "make dev                               start the Vite dev server"

# `make self-improve <name.json> [iters]` — the goals after the target are
# passed straight through to the script as positional arguments.
self-improve:
	@scripts/self-improve.sh $(filter-out $@,$(MAKECMDGOALS))

# `make render <name.json>` — one-shot offscreen render, no model calls.
render:
	@mkdir -p .self-improve
	@node scripts/render-scene.mjs \
		public/samples/$(filter-out $@,$(MAKECMDGOALS)) \
		.self-improve/$(basename $(filter-out $@,$(MAKECMDGOALS)))-preview.png

build:
	@npm run build

dev:
	@npm run dev

# Catch-all so the file-name arguments after `self-improve`/`render` do not
# make `make` fail with "no rule to make target". They are consumed above.
%:
	@:
