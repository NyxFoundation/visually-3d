#!/usr/bin/env node
// Applies one self-improvement iteration.
//
// Parses Claude's output, validates the returned scene against the
// MachineSceneDescriptor schema, writes it back to the target file, logs the
// review, and signals the loop through the exit code:
//   0  applied — keep iterating
//   10 applied — model reports convergence, stop
//   20 stop — score regressed (scene discarded) or plateaued (scene kept)
//   1  error — output unusable, target left untouched
//
// Usage: node scripts/self-improve-apply.mjs <raw> <target> <runDir> <ii>

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const [rawPath, targetPath, runDir, ii] = process.argv.slice(2);
if (!rawPath || !targetPath || !runDir || !ii) {
  console.error('usage: self-improve-apply.mjs <raw> <target> <runDir> <ii>');
  process.exit(1);
}

const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
};

// --- locate the JSON object in the model output --------------------------
// Balanced-brace scan from the first "{", string-aware so braces inside
// strings do not confuse the depth counter.
const extractJson = (text) => {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

const jsonText = extractJson(readFileSync(rawPath, 'utf8'));
if (!jsonText) fail('no JSON object found in Claude output');

let payload;
try {
  payload = JSON.parse(jsonText);
} catch (e) {
  fail(`returned JSON did not parse: ${e.message}`);
}

const review = payload.review ?? {};
const scene = payload.scene;
if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
  fail('payload has no "scene" object');
}

// --- validate the scene --------------------------------------------------
const SHAPES = new Set(['box', 'cylinder', 'sphere', 'cone', 'torus', 'capsule', 'complex']);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

if (typeof scene.machine_name !== 'string' || !scene.machine_name.trim()) {
  fail('scene.machine_name is missing');
}
if (!Array.isArray(scene.parts) || scene.parts.length === 0) {
  fail('scene.parts is missing or empty');
}

const ids = new Set();
scene.parts.forEach((p, idx) => {
  const at = `parts[${idx}]${p && p.id ? ` (${p.id})` : ''}`;
  if (!p || typeof p !== 'object') fail(`${at}: not an object`);
  for (const k of ['id', 'name', 'shape', 'material', 'role']) {
    if (typeof p[k] !== 'string' || !p[k].trim()) fail(`${at}: missing "${k}"`);
  }
  if (!SHAPES.has(p.shape)) fail(`${at}: invalid shape "${p.shape}"`);
  if (!Array.isArray(p.position) || p.position.length !== 3 || !p.position.every(finite)) {
    fail(`${at}: position must be 3 finite numbers`);
  }
  if (
    p.rotation !== undefined &&
    (!Array.isArray(p.rotation) || p.rotation.length !== 3 || !p.rotation.every(finite))
  ) {
    fail(`${at}: rotation must be 3 finite numbers`);
  }
  if (
    !Array.isArray(p.size) ||
    p.size.length < 1 ||
    !p.size.every(finite) ||
    p.size.some((n) => n <= 0)
  ) {
    fail(`${at}: size must be a list of positive finite numbers`);
  }
  if (ids.has(p.id)) fail(`${at}: duplicate part id "${p.id}"`);
  ids.add(p.id);
});

let dangling = 0;
scene.parts.forEach((p) => {
  (p.connections || []).forEach((c) => {
    if (!ids.has(c)) dangling++;
  });
});
if (dangling) console.error(`  ! ${dangling} connection(s) reference unknown part ids`);

// --- compare against the previous iteration ------------------------------
const total = Number(review.total);
const prevReviewPath = join(runDir, 'last-review.json');
let prevTotal = null;
try {
  prevTotal = Number(JSON.parse(readFileSync(prevReviewPath, 'utf8')).total);
} catch {
  /* first iteration — no previous review */
}

// --- report --------------------------------------------------------------
writeFileSync(join(runDir, `iter-${ii}-review.json`), JSON.stringify(review, null, 2));
console.log(
  `  parts: ${scene.parts.length}   score: ${Number.isFinite(total) ? total : '?'}/100` +
    (Number.isFinite(prevTotal) ? `  (prev ${prevTotal})` : ''),
);
if (review.critique) console.log(`  critique: ${review.critique}`);
for (const c of review.changelog || []) console.log(`  + ${c}`);
for (const g of review.remaining_gaps || []) console.log(`  · gap: ${g}`);

// --- regression guard: discard a pass that scored itself lower -----------
if (Number.isFinite(total) && Number.isFinite(prevTotal) && total < prevTotal) {
  console.error(`  ✗ score regressed (${prevTotal} → ${total}) — discarding this iteration`);
  process.exit(20);
}

// --- commit the improved scene -------------------------------------------
copyFileSync(targetPath, join(runDir, `iter-${ii}-prev.json`));
const serialized = JSON.stringify(scene, null, 2) + '\n';
writeFileSync(targetPath, serialized);
writeFileSync(join(runDir, `iter-${ii}.json`), serialized);
writeFileSync(prevReviewPath, JSON.stringify(review, null, 2));

if (review.verdict === 'converged') process.exit(10);
if (Number.isFinite(total) && Number.isFinite(prevTotal) && total - prevTotal < 2) {
  console.log('  (gain < 2 points — plateau)');
  process.exit(20);
}
process.exit(0);
