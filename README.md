# visually - Local Claude CLI 3D Machinery Visualization

`visually` converts a machine name or URL into an interactive Three.js scene. The app is intentionally **local-first**: it does not ask for or store an Anthropic API key. Instead, the FastAPI backend runs the locally installed and already-authenticated `claude -p` command and streams stdout/stderr to the web GUI for debugging.

## Architecture

```text
visually/
├── apps/
│   ├── server/           # FastAPI backend; spawns local `claude -p`
│   └── web/              # Vite + React + Three.js GUI
├── shared/               # JSON schema for generated scenes
└── README.md
```

Runtime flow:

```text
Browser input -> FastAPI /analyze/stream -> local `claude -p` subprocess
             -> SSE log stream + final JSON -> React/Three.js renderer
```

## Prerequisites

1. Node.js 22+ and npm.
2. Python with `uv`.
3. Claude CLI available as `claude` in `PATH`.
4. Authenticate Claude CLI outside this app using the official CLI login flow for your environment. Verify with:

```bash
command -v claude
claude --version
claude -p 'Return {"ok": true} as JSON only.'
```

If `command -v claude` prints nothing, the backend will still start, but analysis requests will return an actionable error saying that the CLI is missing.

## Run locally

From the repository root:

```bash
# Terminal 1: backend
cd apps/server
uv run --with-requirements requirements.txt uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Terminal 2: frontend
cd apps/web
npm install
npm run dev
```

Open `http://localhost:5173`.

## API

- `GET /` returns backend health and whether `claude` is visible in `PATH`.
- `POST /analyze` returns a complete `MachineSceneDescriptor` JSON response.
- `POST /analyze/stream` streams Server-Sent Events:
  - `event: log` for stdout/stderr/system logs.
  - `event: result` for the final parsed scene JSON.
  - `event: error` for runtime errors.

Example:

```bash
curl -N -X POST http://localhost:8000/analyze/stream \
  -H 'Content-Type: application/json' \
  -d '{"machine_name":"electric motor"}'
```

## Notes

- The app uses local CLI auth by design. There is no API-key login page.
- The GUI shows the raw CLI stream so prompt or JSON failures are visible while debugging.
- Claude output is parsed by taking the first JSON object in stdout and validating it with Pydantic before rendering.
