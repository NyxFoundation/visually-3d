# visually-3d

Interactive 3D machinery visualization, driven by your local Claude CLI.

```bash
npx visually-3d
```

That's it — it opens a browser window at `http://localhost:3131`. Type a machine name or paste a URL; `visually` runs `claude -p` locally and renders the result as an inspectable 3D scene. If you haven't installed or authenticated the Claude CLI, the sample gallery still works.

## Why local?

No API keys handled by this tool. Analysis uses whatever `claude` you already have in `$PATH`, using whatever subscription / OAuth you've already set up for it. The Node process only:

- serves the built React frontend from `dist/`
- spawns `claude -p "<prompt>"` as a subprocess and streams stdout/stderr back to the browser over SSE

No telemetry, no cloud, no accounts.

## Prerequisites

- Node.js 18+
- Claude CLI on your `$PATH` if you want to generate new scenes (gallery works without it)

Verify:

```bash
claude --version
```

## Install + run

### One-shot (recommended)

```bash
npx visually-3d
```

### Persistent install

```bash
npm install -g visually-3d
visually-3d
```

### From source

```bash
git clone https://github.com/NyxFoundation/visually.git
cd visually
npm install
npm run build
npm start
```

Use `--no-open` (or set `VISUALLY_NO_OPEN=1`) to skip auto-opening the browser. Set `PORT=…` to override the default `3131` (the server probes the next 15 ports if something's already bound).

## Architecture

```
visually/
├── bin/visually.js        Node HTTP server: static + /api/health + /api/analyze/stream
├── server/analyst.js      Spawns `claude -p`, streams SSE, extracts JSON
├── src/                   React + Three.js frontend
├── public/
│   └── samples/*.json     Pre-baked showcase scenes
├── dist/                  Built frontend (shipped with the npm package)
└── wrangler.toml          Optional Cloudflare Workers deploy for the gallery-only static demo
```

Request flow when you submit a machine:

```
Browser → POST /api/analyze/stream        (same origin, no CORS)
        → Node server spawns `claude -p <prompt>`
        → SSE events: log / result / error
        → React renders the final MachineSceneDescriptor JSON
```

## Scene schema

Every scene is a [`MachineSceneDescriptor`](./docs/schema.json):

```ts
{
  machine_name: string
  assembly_instructions?: string
  metadata?: object
  parts: Array<{
    id: string
    name: string
    shape: 'box' | 'cylinder' | 'sphere' | 'complex'
    position: [number, number, number]
    rotation?: [number, number, number]   // Euler radians, optional
    size: number[]
    material: string
    role: string
    connections?: string[]
  }>
}
```

Add a showcase: drop a JSON file under `public/samples/`, register it in `public/samples/index.json`, rebuild.

## Deploy the gallery to Cloudflare Workers

The static bundle (gallery only — no server, no Claude CLI) deploys as a Workers Static Assets site:

```bash
npx wrangler login          # one-time
npm run deploy              # builds + publishes dist/ to the "visually-3d" Worker
```

The Worker is created on first deploy using `wrangler.toml`; no dashboard setup is required. It'll be reachable at `https://visually-3d.<your-subdomain>.workers.dev`.

The deployed version detects the absence of `/api/health` and hides the Analyze input automatically.

## Dev loop

```bash
# Terminal 1: CLI server (serves built /api endpoints)
npm run build && npm start

# Terminal 2: Vite dev server — hot-reloads /src, proxies /api → :3131
npm run dev
```

Open `http://localhost:5173` for the Vite dev experience, or `http://localhost:3131` to test the exact production path.

## License

MIT.
