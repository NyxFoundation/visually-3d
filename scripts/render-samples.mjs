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
  const scene = path.join(samplesDir, f);
  // <id>.png        — single ISO, the gallery thumbnail
  // <id>.sheet.png  — 2x2 ISO/front/side/top contact sheet, the detail screenshot
  const targets = [
    { out: path.join(samplesDir, `${id}.png`), env: { VISUALLY_VIEW: 'iso' }, args: [SIZE] },
    { out: path.join(samplesDir, `${id}.sheet.png`), env: {}, args: ['420'] },
  ];
  for (const { out, env, args } of targets) {
    if (!force && existsSync(out)) continue;
    try {
      execFileSync('node', [renderer, scene, out, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
      made++;
      console.log(`  ✓ ${path.basename(out)}`);
    } catch (err) {
      console.error(`  ✗ ${path.basename(out)}: ${err.message}`);
    }
  }
}
console.log(`render-samples: ${made} image(s) generated / ${files.length} sample(s).`);
