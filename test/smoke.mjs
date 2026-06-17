#!/usr/bin/env node
// Dependency-free smoke test for CI and pre-publish. Exercises everything that
// does NOT need a Claude/Codex login or network: CLI help, scene-schema
// validation of every bundled sample, the offscreen renderer, and the local
// server's health + gallery endpoints. Exits non-zero on the first failure.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScene } from '../lib/scene.js';

const exec = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'visually.js');
const SAMPLES = path.join(ROOT, 'public', 'samples');

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failures++; };
async function step(name, fn) {
  process.stdout.write(`• ${name}\n`);
  try { await fn(); } catch (e) { bad(`${name}: ${e.message}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await step('CLI help', async () => {
  const { stdout } = await exec('node', [BIN, '--help']);
  if (!/Usage:/.test(stdout)) throw new Error('help output missing "Usage:"');
  for (const cmd of ['create', 'improve', 'check', 'upload', 'serve']) {
    if (!stdout.includes(cmd)) throw new Error(`help missing command "${cmd}"`);
  }
  ok('help lists all subcommands');
});

await step('Unknown command exits non-zero', async () => {
  let code = 0;
  try { await exec('node', [BIN, 'definitely-not-a-command']); }
  catch (e) { code = e.code; }
  if (code === 0) throw new Error('expected non-zero exit for unknown command');
  ok('unknown command rejected');
});

await step('Every bundled sample validates against the schema', async () => {
  const files = readdirSync(SAMPLES).filter((f) => f.endsWith('.json') && f !== 'index.json');
  if (files.length === 0) throw new Error('no sample scenes found');
  for (const f of files) {
    const scene = JSON.parse(readFileSync(path.join(SAMPLES, f), 'utf8'));
    const errors = validateScene(scene);
    if (errors.length) throw new Error(`${f}: ${errors[0]}`);
  }
  // index.json must reference real files.
  const index = JSON.parse(readFileSync(path.join(SAMPLES, 'index.json'), 'utf8'));
  for (const s of index.samples || []) {
    const p = path.join(SAMPLES, path.basename(s.path));
    if (!existsSync(p)) throw new Error(`index.json references missing file: ${s.path}`);
  }
  ok(`${files.length} samples valid + index.json consistent`);
});

await step('Offscreen renderer produces a PNG', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visually-smoke-'));
  try {
    const out = path.join(tmp, 'q.png');
    await exec('node', [path.join(ROOT, 'scripts', 'render-scene.mjs'),
      path.join(SAMPLES, 'quadcopter.json'), out, '200'],
      { env: { ...process.env, VISUALLY_VIEW: 'iso' } });
    const buf = readFileSync(out);
    const isPng = buf.length > 1000 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isPng) throw new Error('output is not a valid non-trivial PNG');
    ok(`rendered ${buf.length} byte PNG`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

await step('Server serves health + merged gallery', async () => {
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/ not built — run `npm run build` first');
  }
  const port = 3877;
  const home = mkdtempSync(path.join(os.tmpdir(), 'visually-home-'));
  const srv = spawn('node', [BIN, 'serve', '--no-open'],
    { env: { ...process.env, PORT: String(port), VISUALLY_HOME: home, VISUALLY_NO_OPEN: '1' },
      stdio: 'ignore' });
  try {
    let health;
    for (let i = 0; i < 30; i++) {
      try { health = await fetch(`http://127.0.0.1:${port}/api/health`); break; }
      catch { await sleep(200); }
    }
    if (!health || !health.ok) throw new Error('health endpoint not reachable');
    const h = await health.json();
    if (h.status !== 'healthy') throw new Error(`unexpected health: ${JSON.stringify(h)}`);

    const idx = await (await fetch(`http://127.0.0.1:${port}/samples/index.json`)).json();
    if (!Array.isArray(idx.samples) || idx.samples.length === 0) {
      throw new Error('gallery index empty');
    }
    ok(`health OK, gallery has ${idx.samples.length} scenes`);
  } finally {
    srv.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
});

console.log('');
if (failures) { console.error(`smoke: ${failures} failure(s)`); process.exit(1); }
console.log('smoke: all checks passed ✓');
