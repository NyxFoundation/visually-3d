// `visually serve` (the default command) — serve the built React GUI and
// bridge the browser to the user's local Claude CLI over SSE. Workspace
// scenes are merged into the gallery at request time, so anything created
// with `visually create`/`improve` shows up without a rebuild.

import http from 'node:http';
import fsp from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { streamAnalyze, claudeAvailable, buildPrompt } from '../server/analyst.js';
import { DIST, BUNDLED_SAMPLES, SCENES_DIR, ensureWorkspace } from './paths.js';
import { readImpl } from './impls.js';
import { getBackend } from './backends/index.js';
import { listRunsForScene, getRunDetail, resolveArtifact } from './runs.js';
import { listTimeline, getFrameDetail } from './revisions.js';
import type { GalleryEntry } from './types.js';

const MAX_PORT_TRIES = 15;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function ensureBuilt(): Promise<boolean> {
  try {
    await fsp.access(path.join(DIST, 'index.html'));
    return true;
  } catch {
    console.error('\n  visually: no built frontend found at dist/index.html.');
    console.error('  If you\'re developing: run `npm run build` first.');
    console.error('  If this is a published package, this is a bug — please report it.\n');
    return false;
  }
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sseWriter(res: http.ServerResponse): (event: string, data: unknown) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

// Merge the bundled gallery index with workspace scenes. Workspace entries are
// listed first (so freshly created scenes surface at the top) and win on id.
async function buildSamplesIndex() {
  type Category = { id: string; label: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let base: { categories: Category[]; samples: any[] } = { categories: [{ id: 'all', label: 'All' }], samples: [] };
  try {
    base = JSON.parse(await fsp.readFile(path.join(BUNDLED_SAMPLES, 'index.json'), 'utf8'));
  } catch { /* no bundled index — fine */ }

  const workspaceEntries: GalleryEntry[] = [];
  try {
    const { deriveIndexEntry } = await import('./scene.js');
    const files = await fsp.readdir(SCENES_DIR);
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const scene = JSON.parse(await fsp.readFile(path.join(SCENES_DIR, f), 'utf8'));
        workspaceEntries.push(deriveIndexEntry(scene, f.replace(/\.json$/, '')));
      } catch { /* skip unreadable scene */ }
    }
  } catch { /* no workspace yet */ }

  const seen = new Set(workspaceEntries.map((e) => e.id));
  const merged = [...workspaceEntries, ...(base.samples || []).filter((s) => !seen.has(s.id))];

  // Surface any workspace-only category so its filter chip appears.
  const cats = base.categories || [{ id: 'all', label: 'All' }];
  const known = new Set(cats.map((c) => c.id));
  for (const e of workspaceEntries) {
    if (e.category && !known.has(e.category)) {
      cats.push({ id: e.category, label: e.category });
      known.add(e.category);
    }
  }
  return { ...base, categories: cats, samples: merged };
}

// Resolve /samples/<file> from the workspace first, then the bundled gallery.
async function serveSample(res: http.ServerResponse, file: string): Promise<boolean> {
  if (file.includes('/') || file.includes('..') || file.includes('\0')) {
    res.statusCode = 400; res.end('bad request'); return true;
  }
  for (const dir of [SCENES_DIR, BUNDLED_SAMPLES]) {
    const p = path.join(dir, file);
    try {
      const data = await fsp.readFile(p);
      res.setHeader('Content-Type', MIME['.json']);
      res.end(data);
      return true;
    } catch { /* try next dir */ }
  }
  return false;
}

async function serveStatic(res: http.ServerResponse, reqPath: string): Promise<void> {
  if (reqPath.includes('\0') || reqPath.includes('..')) {
    res.statusCode = 400; res.end('bad request'); return;
  }
  const clean = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.join(DIST, clean);
  if (!filePath.startsWith(DIST)) { res.statusCode = 400; res.end('bad request'); return; }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    if (clean.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    res.end(data);
  } catch {
    try {
      const data = await fsp.readFile(path.join(DIST, 'index.html'));
      res.setHeader('Content-Type', MIME['.html']);
      res.end(data);
    } catch {
      res.statusCode = 404; res.end('not found');
    }
  }
}

// GET /api/impl/<id> — the canonical implementation persisted by `reproduce`:
// its source, language/backend metadata, and the recorded verification.
function handleImplGet(res: http.ServerResponse, id: string): void {
  const impl = readImpl(id);
  if (!impl) {
    res.statusCode = 404;
    res.setHeader('Content-Type', MIME['.json']);
    res.end(JSON.stringify({ error: 'no implementation for this scene' }));
    return;
  }
  res.setHeader('Content-Type', MIME['.json']);
  res.end(JSON.stringify(impl));
}

// POST /api/impl/<id>/verify — re-run the stored implementation's self-check
// through its backend, live, streaming the result over SSE. This is the
// "demo test execution" the detail page drives.
async function handleImplVerify(res: http.ServerResponse, id: string): Promise<void> {
  const write = sseWriter(res);
  const impl = readImpl(id);
  if (!impl) {
    write('error', { message: `no implementation for "${id}"` });
    res.end();
    return;
  }
  const backend = getBackend(impl.meta.backend);
  const avail = await backend.available();
  if (!avail.ok) {
    write('error', { message: `${backend.label} unavailable: ${avail.reason}` });
    res.end();
    return;
  }
  write('status', { message: `running ${backend.label} (${avail.runner})…` });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visually-verify-'));
  try {
    const result = await backend.verify(impl.code, tmp);
    write('output', { stdout: result.stdout ?? '', stderr: (result.stderr ?? '').slice(0, 8000) });
    write('result', { pass: result.pass, ran: result.ran, backend: backend.id });
  } catch (err) {
    write('error', { message: (err as Error).message });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    res.end();
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', MIME['.json']);
  res.end(JSON.stringify(body));
}

// Run history index (lib/runs): list a scene's runs, a run's normalized detail,
// and serve individual artifacts (renders, scene versions, LLM logs) jailed to
// the run dir.
async function handleRuns(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','runs', ...]
  if (req.method !== 'GET') return false;

  if (parts.length === 2) {
    const scene = url.searchParams.get('scene');
    if (!scene) { sendJson(res, 400, { error: 'scene query param required' }); return true; }
    sendJson(res, 200, { runs: listRunsForScene(scene) });
    return true;
  }

  const id = decodeURIComponent(parts[2] ?? '');
  const runId = decodeURIComponent(parts[3] ?? '');
  if (!id || !runId) return false;

  if (parts.length === 4) {
    const detail = getRunDetail(id, runId);
    if (!detail) { sendJson(res, 404, { error: 'no such run' }); return true; }
    sendJson(res, 200, detail);
    return true;
  }

  if (parts.length === 5 && parts[4] === 'file') {
    const rel = url.searchParams.get('path') ?? '';
    const abs = resolveArtifact(id, runId, rel);
    if (!abs) { sendJson(res, 404, { error: 'no such artifact' }); return true; }
    const ext = path.extname(abs).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'text/plain; charset=utf-8');
    res.end(await fsp.readFile(abs));
    return true;
  }

  return false;
}

// Scene revision timeline. /api/revisions?scene=<id> → the chronological
// timeline; add &rev=<key> for one revision's reasoning + structural/raw diff.
function handleRevisions(res: http.ServerResponse, url: URL): void {
  const scene = url.searchParams.get('scene');
  if (!scene) { sendJson(res, 400, { error: 'scene query param required' }); return; }
  const rev = url.searchParams.get('rev');
  if (rev) {
    const detail = getFrameDetail(scene, rev);
    if (!detail) { sendJson(res, 404, { error: 'no such frame' }); return; }
    sendJson(res, 200, detail);
    return;
  }
  sendJson(res, 200, { entries: listTimeline(scene) });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/health' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'healthy',
      mode: 'cli',
      claude_cli_available: await claudeAvailable(),
    }));
    return;
  }

  if (pathname === '/api/analyze/stream' && req.method === 'POST') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `invalid request body: ${(err as Error).message}` }));
      return;
    }
    const writeEvent = sseWriter(res);
    try {
      const prompt = await buildPrompt({ url: body.url, machineName: body.machine_name });
      await streamAnalyze(prompt, writeEvent);
    } catch (err) {
      writeEvent('error', { message: (err as Error).message });
    }
    res.end();
    return;
  }

  if (pathname === '/samples/index.json') {
    res.setHeader('Content-Type', MIME['.json']);
    res.end(JSON.stringify(await buildSamplesIndex()));
    return;
  }

  if (pathname.startsWith('/samples/') && pathname.endsWith('.json')) {
    const served = await serveSample(res, pathname.slice('/samples/'.length));
    if (served) return;
  }

  if (pathname === '/api/revisions' && req.method === 'GET') {
    handleRevisions(res, url);
    return;
  }

  if (pathname === '/api/runs' || pathname.startsWith('/api/runs/')) {
    if (await handleRuns(req, res, url)) return;
  }

  if (pathname.startsWith('/api/impl/')) {
    const rest = pathname.slice('/api/impl/'.length);
    if (rest.endsWith('/verify') && req.method === 'POST') {
      await handleImplVerify(res, decodeURIComponent(rest.slice(0, -'/verify'.length)));
      return;
    }
    if (req.method === 'GET' && rest && !rest.includes('/')) {
      handleImplGet(res, decodeURIComponent(rest));
      return;
    }
  }

  if (pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  await serveStatic(res, pathname);
}

function openBrowser(url: string): void {
  let cmd: string;
  let cmdArgs: string[];
  if (process.platform === 'darwin') { cmd = 'open'; cmdArgs = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; cmdArgs = ['/c', 'start', '""', url]; }
  else { cmd = 'xdg-open'; cmdArgs = [url]; }
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch { /* user can open manually */ }
}

async function listenWithFallback(server: http.Server, startPort: number, host = '127.0.0.1'): Promise<number> {
  for (let offset = 0; offset < MAX_PORT_TRIES; offset++) {
    const port = startPort + offset;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => { server.removeListener('listening', onListening); reject(err); };
        const onListening = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return port;
    } catch (err) {
      if (err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  throw new Error(`No free port found between ${startPort} and ${startPort + MAX_PORT_TRIES - 1}`);
}

// `openPath` deep-links the auto-opened browser to a specific client route
// (e.g. "/#/s/<id>" for a scene's detail page). Empty = the gallery landing.
export async function serve(argv: string[] = [], openPath = ''): Promise<void> {
  const args = new Set(argv);
  const noOpen = args.has('--no-open') || process.env.VISUALLY_NO_OPEN === '1';
  const startPort = Number(process.env.PORT ?? 3131);

  const ok = await ensureBuilt();
  if (!ok) process.exit(1);
  ensureWorkspace();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('request error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        res.end();
      }
    });
  });

  const port = await listenWithFallback(server, startPort);
  const url = `http://localhost:${port}`;
  const openUrl = `${url}${openPath}`;
  const hasClaude = await claudeAvailable();

  console.log([
    '',
    '  visually-3d — interactive 3D machinery visualization',
    `  → ${openPath ? openUrl : url}`,
    `  → claude CLI: ${hasClaude ? 'detected' : 'NOT FOUND (gallery-only; install Claude CLI to analyze new machines)'}`,
    `  → workspace: ${SCENES_DIR}`,
    '  → Ctrl+C to stop',
    '',
  ].join('\n'));

  if (!noOpen) openBrowser(openUrl);

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
