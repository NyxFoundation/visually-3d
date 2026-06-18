#!/usr/bin/env node
// Render a clean single-ISO thumbnail for every gallery sample (pure Node, no
// GPU/browser — uses render-scene.mjs). The gallery shows these static
// screenshots instead of a live WebGL <Canvas> per card, which avoids the
// browser's concurrent-context cap (the white-out bug) entirely.
//
//   node scripts/render-samples.mjs [--force]   # skip existing unless --force

import { readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(here, '..', 'public', 'samples');
const renderer = path.join(here, 'render-scene.mjs');
const force = process.argv.includes('--force');
const SIZE = '512';

const files = readdirSync(samplesDir).filter((f) => f.endsWith('.json') && f !== 'index.json');
let made = 0;
for (const f of files) {
  const id = f.replace(/\.json$/, '');
  const out = path.join(samplesDir, `${id}.png`);
  if (!force && existsSync(out)) continue;
  try {
    execFileSync('node', [renderer, path.join(samplesDir, f), out, SIZE], {
      env: { ...process.env, VISUALLY_VIEW: 'iso' },
      stdio: 'pipe',
    });
    made++;
    console.log(`  ✓ ${id}.png`);
  } catch (err) {
    console.error(`  ✗ ${id}: ${err.message}`);
  }
}
console.log(`render-samples: ${made} thumbnail(s) generated / ${files.length} sample(s).`);
