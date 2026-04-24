#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { streamAnalyze, claudeAvailable, buildPrompt } from '../server/analyst.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const args = new Set(process.argv.slice(2));
const NO_OPEN = args.has('--no-open') || process.env.VISUALLY_NO_OPEN === '1';
const START_PORT = Number(process.env.PORT ?? 3131);
const MAX_PORT_TRIES = 15;

const MIME = {
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

async function ensureBuilt() {
  try {
    await fs.access(path.join(DIST, 'index.html'));
    return true;
  } catch {
    console.error('\n  visually: no built frontend found at dist/index.html.');
    console.error('  If you\'re developing: run `npm run build` first.');
    console.error('  If this is a published package, this is a bug — please report it.\n');
    return false;
  }
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sseWriter(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

async function serveStatic(req, res, reqPath) {
  if (reqPath.includes('\0') || reqPath.includes('..')) {
    res.statusCode = 400;
    res.end('bad request');
    return;
  }
  const clean = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.join(DIST, clean);
  if (!filePath.startsWith(DIST)) {
    res.statusCode = 400;
    res.end('bad request');
    return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    if (clean.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    res.end(data);
  } catch {
    // SPA fallback: any unknown path → index.html
    try {
      const data = await fs.readFile(path.join(DIST, 'index.html'));
      res.setHeader('Content-Type', MIME['.html']);
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  }
}

async function handleRequest(req, res) {
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
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `invalid request body: ${err.message}` }));
      return;
    }
    const writeEvent = sseWriter(res);
    try {
      const prompt = await buildPrompt({ url: body.url, machineName: body.machine_name });
      await streamAnalyze(prompt, writeEvent);
    } catch (err) {
      writeEvent('error', { message: err.message });
    }
    res.end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  await serveStatic(req, res, pathname);
}

function openBrowser(url) {
  if (NO_OPEN) return;
  let cmd;
  let cmdArgs;
  if (process.platform === 'darwin') {
    cmd = 'open';
    cmdArgs = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    cmdArgs = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    cmdArgs = [url];
  }
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* ignore — user can open manually */
  }
}

async function listenWithFallback(server, startPort, host = '127.0.0.1') {
  for (let offset = 0; offset < MAX_PORT_TRIES; offset++) {
    const port = startPort + offset;
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return port;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  throw new Error(`No free port found between ${startPort} and ${startPort + MAX_PORT_TRIES - 1}`);
}

async function main() {
  const ok = await ensureBuilt();
  if (!ok) process.exit(1);

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

  const port = await listenWithFallback(server, START_PORT);
  const url = `http://localhost:${port}`;
  const hasClaude = await claudeAvailable();

  const banner = [
    '',
    '  visually — interactive 3D machinery visualization',
    `  → ${url}`,
    `  → claude CLI: ${hasClaude ? 'detected' : 'NOT FOUND (gallery-only; install Claude CLI to analyze new machines)'}`,
    '  → Ctrl+C to stop',
    '',
  ].join('\n');
  console.log(banner);

  openBrowser(url);

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
