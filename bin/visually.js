#!/usr/bin/env node
// visually-3d CLI dispatcher.
//
//   visually                       start the GUI (default; same as `serve`)
//   visually serve [--no-open]     start the GUI + local Claude bridge
//   visually create "<machine>"    generate a new scene from scratch
//   visually improve <scene>       recursively self-improve a scene (VLM feedback)
//   visually check <scene>         inspect a scene (browser, or --png contact sheet)
//   visually upload <scene>        open a PR adding the scene to the gallery

import { serve } from '../lib/serve.js';

const HELP = `visually-3d — interactive 3D machinery visualization, driven by your local Claude/Codex CLI

Usage:
  visually [serve] [--no-open]            start the local GUI (default)
  visually create "<machine name>"        generate a new scene
       [--hint <text>] [--url <url>] [--driver claude|codex] [--id <id>] [--force]
  visually improve <scene> [iters]        recursively self-improve a scene
       [--driver codex|claude] [--model <m>]
  visually check <scene> [--png]          inspect a scene (browser, or PNG contact sheet)
       [--out <file.png>] [--no-open]
  visually upload <scene>                 open a PR adding the scene to the gallery
       [--repo owner/name] [--title <t>] [--dry-run]

Scenes created locally live under ~/.visually-3d/scenes (override with $VISUALLY_HOME).
`;

async function main() {
  const [, , maybeCmd, ...rest] = process.argv;

  // No subcommand, or a leading flag → serve (back-compat: `visually --no-open`).
  if (!maybeCmd || maybeCmd.startsWith('-')) {
    if (maybeCmd === '--help' || maybeCmd === '-h') { console.log(HELP); return; }
    return serve(process.argv.slice(2));
  }

  switch (maybeCmd) {
    case 'help': case '--help': case '-h':
      console.log(HELP); return;
    case 'serve':
      return serve(rest);
    case 'create':
      return (await import('../lib/create.js')).create(rest);
    case 'improve':
      return (await import('../lib/improve.js')).improve(rest);
    case 'check':
      return (await import('../lib/check.js')).check(rest);
    case 'upload':
      return (await import('../lib/upload.js')).upload(rest);
    default:
      console.error(`visually: unknown command "${maybeCmd}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nvisually: ${err.message}\n`);
  process.exit(1);
});
