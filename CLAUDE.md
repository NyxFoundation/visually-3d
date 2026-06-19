# CLAUDE.md — working rules for visually-3d

Guidance for any agent (or human) developing this repo. Keep it current: when a
convention changes, update this file in the same commit.

## What this is

An npx-distributed CLI (`visually-3d`) that generates 3D machinery
visualizations via the user's **local** Claude/Codex CLI — the tool holds no API
keys. It ships a built React GUI plus a Node CLI. Focus areas are hardware,
chip/architecture, and algorithm subjects (organic/sculpture modes were
deliberately dropped — do not reintroduce them).

## Golden rules

1. **Compile-time over runtime.** Prefer static types and abstractions that make
   bad states unrepresentable. Don't lean on runtime tests to catch what the
   type-checker could. Everything in `lib/ server/ bin/ src/` is TypeScript
   under `strict`.
2. **Parse, don't validate.** Validate external/untrusted input (model output,
   HTTP bodies, JSON files) once at the boundary with zod, then pass typed data
   inward. `any` is allowed *only* at those boundaries and must carry an
   `// eslint-disable-next-line @typescript-eslint/no-explicit-any` with a
   reason; never let `any` leak past the parse.
3. **No floating promises.** `@typescript-eslint/no-floating-promises` is an
   error. Use `await`, or `void fn()` for deliberate fire-and-forget (e.g. React
   event handlers).
4. **Incremental, verified commits.** Small commits, conventional-commit
   messages, each one passing the full gate (below). End commit messages with
   the `Co-Authored-By` trailer.
5. **Never push or publish without explicit per-version authorization.** Commit
   on `main` is fine; `git push` and `npm publish` require the user to ask, each
   time, for that version.

## The gate (run before every commit)

```
npm run lint     # eslint lib server bin src   (flat config, type-aware)
npm run build    # build:cli (tsc -p tsconfig.cli.json) + tsc -b + vite build
npm test         # build:cli + node --test test/*.test.mjs
npm run smoke    # test/smoke.mjs
```

All four must be green. `npm test` and `npm run build` both run `build:cli`
first, so a type error anywhere fails them.

## CLI: in-place TypeScript compilation

The CLI (`lib/`, `server/`, `bin/`) is authored in `.ts` and compiled **in
place** to sibling `.js` by `tsconfig.cli.json` (no `outDir`/`rootDir` — setting
`outDir:"."` breaks the build with TS18003). The generated `.js` are gitignored
(see `.gitignore`) and shipped via the `files` allowlist in `package.json`.

- Module system is `NodeNext`; relative imports use `.js` extensions even from
  `.ts` source (e.g. `import { x } from './paths.js'`).
- Runtime path resolution relies on compiled `lib/foo.js` sitting where
  `lib/foo.ts` did — `paths.ts` derives `PKG_ROOT` from `__dirname`. Don't add
  an `outDir`.
- The web app (`src/`) is a separate project built by Vite under `tsconfig.json`.

When converting/adding a CLI file: write `.ts`, add its generated `.js` to
`.gitignore`, run `npm run build:cli`, then the gate.

## Architecture map

- `bin/visually.ts` — command dispatcher. Bare `visually` in a TTY launches the
  Ink TUI; otherwise/with args it routes to subcommands (`serve`, `create`,
  `improve`, `reproduce`, `amend`, `refine`, `check`, `upload`). Keeps a
  `#!/usr/bin/env node` shebang (preserved through tsc emit).
- `lib/tui/app.ts` — Ink + htm control panel (JSX without a build step). htm
  template markup is opaque to the type-checker; put real types on component
  props, hooks, and effects.
- `lib/scene.ts` — zod schemas + `parseScene`/`validateScene`/`extractScene`.
- `lib/reproduce.ts` — reverse-implements a scene from its spec with N agents,
  verifies via a backend, and distils the best impl into the impl store.
- `lib/backends/` — composable verification backends behind the `Backend`
  interface (`available`/`implementInstructions`/`verify`). `python-smt`
  (Python+Z3 via `uv run --with z3-solver`) and `sim` (MuJoCo). Add backends by
  implementing the interface and registering in `backends/index.ts`;
  `defaultBackendFor(mode)` picks one (algorithm→python-smt, else→sim).
- `lib/impls.ts` — canonical per-scene impl store under
  `~/.visually-3d/impls/<id>/` (`impl.<ext>` + `verify.txt` + `meta.json`).
- `lib/evidence.ts` — accumulating, cache-first source-evidence substrate (no
  standalone command). `refine` calls `ensureEvidence()` AUTONOMOUSLY when it
  stalls below the reproducibility goal on source-dependent gaps. Policy:
  reference the cache first (`~/.visually-3d/evidence/<id>/`, falling back to the
  checked-in `examples/<id>/` seed); on a miss, fetch via the runner's web tools
  **gap-targeted** (`summarizeGaps`), **appending** to `paper.md` (never
  overwrite; seed `notes.md` always merged); escalate via a persistent
  `index.json → attempts[]` log (`planEvidence`: `paper` → `refs` → exhausted),
  never repeating a method. It captures the reference implementation's key source
  files VERBATIM (ground truth, not just prose). Evidence feeds **`amend`** (quotes
  it to ground the spec) and the **visual improve pass** (`refine`'s
  `buildImproveSeed` injects `sourceGrounding` so the 3D model depicts the REAL
  architecture) — but NOT reproduce's reverse-implementers, which must keep grading
  the SPEC, not the paper. Only tool-enabled step (`runClaudeStreaming({ tools:
  [...] })`); the rest is tool-less. (Direction: reproduce is being repointed from
  reverse-implementation toward verifying the fetched source; zero-from-scratch
  implementation/RTL generation is not a goal.)
- `lib/serve.ts` — static GUI server + SSE bridge to the local CLI. Endpoints:
  `/api/health`, `/api/analyze/stream`, `/samples/...`, `/api/impl/<id>`,
  `POST /api/impl/<id>/verify` (streams a live backend run).
- `lib/paths.ts` — package vs workspace paths. Workspace is `$VISUALLY_HOME`
  (default `~/.visually-3d`): `scenes/`, `runs/`, `impls/`, `evidence/`. Curated
  seed evidence ships checked-in under the package's `examples/<id>/`.

## Web app (`src/`)

- **Hash router** (`src/router.ts`): `#/` gallery, `#/s/<id>` detail. Hash
  routing is deliberate — zero SPA-fallback config, works the same under local
  `serve` and the static Cloudflare deploy. The synthetic id `__live__` holds an
  Analyze-generated scene in app state.
- `src/App.tsx` is the shell: owns shared data (samples, categories, backend
  status, live scene, analyze stream) and renders `GalleryPage` or `DetailPage`.
  Detail pages are remounted per id via `key` so transient UI resets — don't
  reset state in an effect (`react-hooks/set-state-in-effect` is an error).
- `src/sse.ts` — shared SSE parsing + `streamPostSse` for fetch-based streams.
- **WebGL context budget:** browsers cap live `<Canvas>` contexts. The global
  thumbnail-slot pool in `SceneCard.tsx` keeps the gallery from exhausting them
  and whiting out the main viewer. Preserve it when touching gallery rendering.

## Conventions

- Validation: zod 4. Use `.loose()` (not the deprecated `.passthrough()`).
- Tests: `node:test` (zero-dep), files in `test/*.test.mjs`, importing the
  compiled `.js`. Modules that read `$VISUALLY_HOME` at load time must have it
  set before a dynamic `import()` in the test.
- ESLint: flat config in `eslint.config.js`. Syntactic `recommended` over all
  TS; type-aware promise rules over anything in a tsconfig; `react-hooks` for
  `src/`. We intentionally skip `recommendedTypeChecked` — the boundary-`any`
  would drown in `no-unsafe-*`.
- CI (`.github/workflows/ci.yml`) gates on lint → build → test → smoke across
  Node 20/22, plus a Node-18 runtime smoke (the package targets `node>=18`; the
  Vite build needs 20+).
