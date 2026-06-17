# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/NyxFoundation/visually-3d/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/NyxFoundation/visually-3d/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/NyxFoundation/visually-3d/releases/tag/v0.2.0
