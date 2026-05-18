#!/usr/bin/env node
// Generate a new MachineSceneDescriptor from scratch with the Claude CLI,
// reusing the analyst system prompt, and write it to public/samples/<id>.json.
//
// Usage: node scripts/generate-scene.mjs <id> <name> <hint> [logDir]
//
// Env: CLAUDE_BIN (default: claude), CLAUDE_MODEL (default: opus)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT } from '../server/analyst.js';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const [id, name, hint, logDir] = process.argv.slice(2);
if (!id || !name || !hint) {
  console.error('usage: node scripts/generate-scene.mjs <id> <name> <hint> [logDir]');
  process.exit(1);
}

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'opus';
const SHAPES = new Set(['box', 'cylinder', 'sphere', 'cone', 'torus', 'capsule', 'complex']);

const prompt = `${SYSTEM_PROMPT}

Machine: ${name}
Context: ${hint}

Generate the MachineSceneDescriptor JSON now. Return JSON only.`;

const fail = (msg) => {
  console.error(`generate-scene: ${id}: ${msg}`);
  process.exit(1);
};

const run = async () => {
  let stdout;
  try {
    // `--tools ""` disables all tools: a pure single-shot generation.
    ({ stdout } = await exec(
      CLAUDE_BIN,
      ['-p', prompt, '--model', CLAUDE_MODEL, '--tools', ''],
      { maxBuffer: 64 * 1024 * 1024, timeout: 600000 },
    ));
  } catch (e) {
    fail(`claude failed: ${e.message}`);
  }

  if (logDir) writeFileSync(join(logDir, `${id}-raw.txt`), stdout);

  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) fail('no JSON object in claude output');

  let scene;
  try {
    scene = JSON.parse(stdout.slice(start, end));
  } catch (e) {
    fail(`invalid JSON: ${e.message}`);
  }

  if (typeof scene.machine_name !== 'string' || !scene.machine_name.trim()) {
    fail('scene has no machine_name');
  }
  if (!Array.isArray(scene.parts) || scene.parts.length === 0) {
    fail('scene has no parts');
  }
  for (const p of scene.parts) {
    if (!p || !SHAPES.has(p.shape)) fail(`part "${p && p.id}" has invalid shape "${p && p.shape}"`);
  }

  const out = join(ROOT, 'public/samples', `${id}.json`);
  writeFileSync(out, JSON.stringify(scene, null, 2) + '\n');
  console.log(`generate-scene: ${id} -> ${out} (${scene.parts.length} parts)`);
};

run();
