# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.0] - 2026-06-18

### Added

- **Time-scrubbed scene studio**: the detail page is now one synchronized,
  scrubbable view of a scene's evolution — 3D model, screenshot and
  implementation side by side, driven by a transport bar (⏮ ◀ slider ▶ ⏭ and
  ←/→ keys). Every frame pairs the LLM's REASONING with the CHANGES (a per-part
  structural diff for scene revisions, a code diff for verifications), with
  syntax highlighting and per-pane hide/show.
- **Unified run history**: all of a scene's create / improve / reproduce runs
  are consolidated under `runs/<id>/` and exposed as one chronological revision
  timeline (`/api/revisions`, `/api/runs`). `upload` contributes a curated
  history with the sample; a clone/install browses it via a bundled fallback.
- **`reproduce` + composable verification backends**: reverse-implements a scene
  from its spec and verifies it (`python-smt` via Z3, `sim` via MuJoCo).
- **`refine`**: a unified loop that runs visual self-improvement and
  implementation verification until both thresholds clear.
- **Gallery**: category-grouped showcase with per-id pages (hash router) and
  static pre-rendered screenshot thumbnails (no live WebGL). Contact-sheet
  screenshots ship per sample; workspace scenes render thumbnails/sheets on the
  fly and cache them.
- **TUI**: view (browser) / refine / push (PR) paths per scene.

### Changed

- Internals migrated to **TypeScript-strict** with **type-aware ESLint**
  (headline `no-floating-promises`), gated in CI.
- The live 3D viewer now matches the screenshot look (device-resolution
  rendering, flat tonemapping, no grid, no translucent connectors).
- Gallery landing title is **VISUALLY**.

### Removed

- The gallery Analyze bar / realtime-LLM path, and the auto-generated
  `metadata.info.japanese_name`.

### Fixed

- Pin `react`/`react-dom` to the same version (a mismatch blank-screened the
  app). Detail page no longer spins forever when the `/api` proxy target is down
  under `vite dev`.

## [0.10.1] - 2026-06-17

### Fixed

- **Mobile gallery white-out**: each sample thumbnail mounted its own live
  WebGL `<Canvas>`, so scrolling the gallery exceeded the browser's concurrent
  context cap (mobile Safari ≈ 8) and the oldest context — the main viewer —
  got evicted and rendered blank-white. Concurrent thumbnail canvases are now
  hard-capped by a small global pool (3 on phones, 6 on desktop), keeping the
  total well under the cap; cards beyond the cap show a static accent poster
  instead of a blank canvas, and slots are released as cards scroll off-screen.

## [0.10.0] - 2026-06-17

### Added

- **Auto-detected generation modes** (`server/modes.js`): `create` now picks a
  mode — `hardware`, `algorithm`, or `architecture` — from the subject and
  swaps the persona, quality bar, material vocabulary and modelling strategy
  accordingly. Override with `--mode`.
- **Live reasoning + full run logs**: `create` streams the model's thinking as
  it works (stream-json) and writes every run — prompt, raw stream, reasoning
  transcript, scene, and metadata — to `~/.visually-3d/runs/create-<id>-<stamp>/`.
- **Built-in refinement**: after generating a draft, `create` runs the visual
  self-improvement loop ≥3× by default (`--refine N` / `--no-refine`).
- **Cross-run memory** (`lib/history.js`): `improve` seeds its first iteration
  with the unfinished gaps from prior `create`/`improve` runs of the same scene,
  so it continues the trial-and-error instead of restarting cold.
- New CPU / GPU gallery sample: **CFNTT NTT FPGA accelerator** (TCHES) —
  conflict-free radix-2/4 Number Theoretic Transform engine.

### Fixed

- `improve`'s visual critique was effectively blind: it ran with
  `--permission-mode acceptEdits`, which would not let Claude read the
  contact-sheet render under `~/.visually-3d/runs` (outside the cwd). It now
  uses `bypassPermissions` (still restricted to `--tools Read`) so the critique
  is grounded in what the scene actually looks like.
- `slugify` now falls back to a content hash for names with no ASCII (e.g.
  Japanese), so subjects no longer all collapse to the id `scene`.

## [0.9.1] - 2026-06-17

### Fixed

- `create`/`analyze` with an image (or other binary) `--url` crashed with
  "args[1] must be a string without null bytes": the binary body was read as
  text and its NUL bytes poisoned the subprocess argument. Non-text URLs are
  now detected by content-type and skipped with a note, and all prompt text is
  sanitized of control characters.
- When both a machine name and a `--url` were given, the machine name was
  dropped. `buildPrompt` now includes both — important when the URL is an image
  the model can't read and the name is the only usable signal.

## [0.9.0] - 2026-06-17

First public release on npm — a `1.0.0` release candidate. Carries all of the
0.3.0 CLI work below, plus release tooling.

### Added

- **Automated CI** (`.github/workflows/ci.yml`): build + smoke test on Node 18,
  20, and 22, and a job that packs the tarball and asserts its contents.
- **Automated publish** (`.github/workflows/publish.yml`): pushing a `vX.Y.Z`
  tag builds, smoke-tests, verifies the tag matches `package.json`, and runs
  `npm publish` with [provenance](https://docs.npmjs.com/generating-provenance-statements).
- **Smoke test** (`npm run smoke`): login-free checks — CLI help, schema
  validation of every bundled sample, the offscreen renderer, and the server's
  health + gallery endpoints.
- `publishConfig` (`access: public`, `provenance: true`).

## [0.3.0] - 2026-06-17

### Added

- **Subcommand CLI**: `visually create`, `improve`, `check`, `upload`, and
  `serve` (the default). Bare `visually-3d` still launches the GUI.
- **`create`** — generate a scene from a text prompt via your local Claude
  (`claude -p`) or Codex (`codex exec`, `--driver codex`) CLI.
- **`check`** — inspect a scene in the browser, or render a headless PNG
  (`--png`; no GPU required).
- **`upload`** — fork the repo and open a pull request adding your scene to the
  gallery, using your own `gh` auth. No API keys handled.
- **Workspace** at `~/.visually-3d/` (override with `$VISUALLY_HOME`):
  user-created scenes and self-improve run histories live here, outside the
  package. The server merges workspace scenes into the gallery at request time,
  so generated scenes appear without a rebuild.
- Single-view renderer mode (`VISUALLY_VIEW=iso|front|side|top`) for
  hero/gallery imagery.
- Community health files: `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, issue templates, and a pull request template.

### Changed

- `bin/visually.js` is now a thin dispatcher; the HTTP server moved to
  `lib/serve.js`.
- The npm package now ships `lib/`, `scripts/`, `prompts/`, and
  `docs/schema.json` so the CLI commands work when installed globally.
- `scripts/self-improve.sh` honors `$VISUALLY_RUNS_DIR` so run histories can be
  written outside a read-only global install directory.
- README rebuilt for an OSS release, with a gallery of real generated renders.

## [0.2.0] - 2026-04-24

### Added

- Initial public release: local GUI (`npx visually-3d`) that drives the Claude
  CLI to generate inspectable 3D machine scenes, a sample gallery, the
  offscreen renderer, and the recursive self-improvement loop.

[Unreleased]: https://github.com/NyxFoundation/visually-3d/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/NyxFoundation/visually-3d/compare/v0.10.1...v0.11.0
[0.9.1]: https://github.com/NyxFoundation/visually-3d/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/NyxFoundation/visually-3d/compare/v0.3.0...v0.9.0
[0.3.0]: https://github.com/NyxFoundation/visually-3d/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/NyxFoundation/visually-3d/releases/tag/v0.2.0
