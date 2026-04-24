# visually — interactive 3D machinery visualizations

`visually` renders machines as inspectable 3D scenes. It ships two modes from the same frontend:

- **Public / deployed (Cloudflare Pages)** — a gallery of pre-baked machine scenes. Static-only, mobile-friendly, fast first paint. No backend, no API keys.
- **Local dev** — same UI, plus a FastAPI backend that shells out to the locally-authenticated `claude -p` CLI to generate new scenes from a machine name or URL. The frontend auto-detects the backend and only shows the "Analyze" input when it's reachable.

## Architecture

```text
visually/
├── apps/
│   ├── server/           # FastAPI backend; spawns local `claude -p` (local dev only)
│   └── web/              # Vite + React + Three.js GUI, deployed as static site
│       └── public/samples/  # pre-baked SceneDescriptor JSON for the gallery
├── shared/               # JSON schema for generated scenes
├── wrangler.toml         # Cloudflare Pages config
└── README.md
```

Runtime flow when the backend is reachable:

```text
Browser input -> FastAPI /analyze/stream -> local `claude -p` subprocess
             -> SSE log stream + final JSON -> React/Three.js renderer
```

When deployed, `/analyze/stream` is not reachable and the Analyze UI hides itself; users interact only with the sample gallery.

## Prerequisites

For the frontend only (all you need to build & deploy):

- Node.js 22+ and npm.

For local scene generation (optional):

- Python with `uv`.
- Claude CLI available as `claude` in `PATH`, already authenticated. Verify with `claude -p 'Return {"ok": true} as JSON only.'`.

## Run locally

```bash
# Terminal 1 (optional — only needed to analyze new machines): backend
cd apps/server
uv run --with-requirements requirements.txt uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Terminal 2: frontend
cd apps/web
npm install
npm run dev
```

Open `http://localhost:5173`. If the backend isn't running you'll still get the full gallery and viewer — only the Analyze input is hidden.

## Deploy to Cloudflare Pages

One-time: `npx wrangler login`.

Then from `apps/web`:

```bash
npm run deploy        # builds and pushes apps/web/dist to the "visually" Pages project
```

`wrangler.toml` at the repo root points `pages_build_output_dir` at `apps/web/dist`, so you can also connect the Cloudflare Pages dashboard to this GitHub repo and set:

- **Build command:** `cd apps/web && npm ci && npm run build`
- **Build output directory:** `apps/web/dist`

## API (local backend only)

- `GET /` — backend health and whether `claude` is visible in `PATH`.
- `POST /analyze` — returns a complete `MachineSceneDescriptor` JSON response.
- `POST /analyze/stream` — streams SSE:
  - `event: log` for stdout/stderr/system logs
  - `event: result` for the final parsed scene JSON
  - `event: error` for runtime errors

```bash
curl -N -X POST http://localhost:8000/analyze/stream \
  -H 'Content-Type: application/json' \
  -d '{"machine_name":"electric motor"}'
```

## Sample scenes

`apps/web/public/samples/index.json` lists the gallery entries. Each entry points at a JSON file conforming to `shared/schema.json` (`MachineSceneDescriptor`). To add a new showcase:

1. Author `apps/web/public/samples/my-machine.json` following an existing sample.
2. Add an entry to `apps/web/public/samples/index.json`.
3. Rebuild.

## Notes

- No API key is stored anywhere in the app. Analysis uses the user's pre-authenticated Claude CLI.
- Frontend rendering: React Three Fiber + drei. The Viewer chunk is lazy-loaded so first paint is ~65 kB gzipped.
- Scene descriptor parts support an optional `rotation: [x, y, z]` (radians) for arbitrary orientation.
