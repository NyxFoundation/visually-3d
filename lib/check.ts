// `visually check <scene>` — quickly inspect a scene locally.
//
//   visually check <id>           start the GUI and open the scene in the gallery
//   visually check <id> --png     render an offscreen 2x2 contact-sheet PNG
//                                  (headless, no GPU) and open the image

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveScene, sceneIdFromPath, SCRIPTS } from './paths.js';
import { serve } from './serve.js';

const exec = promisify(execFile);

function openInOS(target: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', target] : [target];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch { /* user can open manually */ }
}

interface CheckOpts {
  positional: string[];
  png?: boolean;
  out?: string;
  noOpen?: boolean;
}

function parseArgs(argv: string[]): CheckOpts {
  const opts: CheckOpts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--png') opts.png = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--no-open') opts.noOpen = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export async function check(argv: string[]): Promise<string | undefined> {
  const opts = parseArgs(argv);
  const ref = opts.positional[0];
  if (!ref) throw new Error('usage: visually check <scene> [--png] [--out <file.png>]');

  const target = resolveScene(ref);
  if (!target) throw new Error(`no such scene: ${ref}`);
  const id = sceneIdFromPath(target);

  if (opts.png) {
    const out = path.resolve(opts.out || `${id}-preview.png`);
    const renderer = path.join(SCRIPTS, 'render-scene.mjs');
    if (!existsSync(renderer)) throw new Error(`renderer not found at ${renderer}`);
    console.log(`visually check: rendering ${id} → ${out}`);
    await exec('node', [renderer, target, out], { maxBuffer: 64 * 1024 * 1024 });
    console.log(`  ✓ ${out}`);
    if (!opts.noOpen) openInOS(out);
    return out;
  }

  // No --png: launch the GUI. Freshly-created/workspace scenes are listed
  // first in the gallery, so the scene appears at the top.
  console.log(`visually check: opening ${id} in the browser…`);
  await serve(opts.noOpen ? ['--no-open'] : []);
}
