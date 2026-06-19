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
  visually                                interactive TUI control panel (in a terminal)
  visually serve [--no-open]              start the local web GUI
  visually create "<machine name>"        generate a new scene
       [--hint <text>] [--url <url>] [--mode hardware|algorithm|architecture]
       [--refine N | --no-refine] [--driver claude|codex] [--id <id>] [--force]
  visually improve <scene> [iters]        recursively self-improve a scene
       [--driver codex|claude] [--model <m>]
  visually reproduce <scene>              measure if the scene is a reproducible
       [--n 2] [--model <m>]              spec: AI reverse-implements it (Verilog/
       [--backend <id>] [--no-verify]     Python) from the descriptor alone and
                                          scores what's missing to rebuild it
  visually amend <scene>                  fold reproduce's findings back into the
       [--n 2] [--model <m>]              scene's functional spec (parts[].spec /
       [--backend <id>] [--no-verify]     metadata.spec) so it becomes reproducible
  visually refine <scene>                 closed 3D ⇄ implementation loop: each
       [--rounds 3] [--visual 90]         round runs improve → reproduce → amend.
       [--repro 80] [--iters 1]           When it stalls below the reproducibility
       [--backend <id>] [--no-amend]      goal on source-dependent gaps, it auto-
       [--no-evidence] [--evidence-refs]  gathers the source (paper) via web tools
                                          so amend can quote it (--no-evidence off)
  visually check <scene> [--png]          inspect a scene (browser, or PNG contact sheet)
       [--out <file.png>] [--no-open]
  visually upload <scene>                 open a PR adding the scene to the gallery
       [--repo owner/name] [--title <t>] [--dry-run]

Mode is auto-detected from the subject (override with --mode), and the
verification backend is auto-selected from what the subject IS (digital/compute
→ SMT, physical machine → sim). After generating, create runs ≥3 closed-loop
rounds (improve → reproduce → amend; --no-refine to skip). Every run streams the
model's reasoning live and is logged under ~/.visually-3d/runs/.

Scenes created locally live under ~/.visually-3d/scenes (override with $VISUALLY_HOME).
`;

async function main() {
  const [, , maybeCmd, ...rest] = process.argv;

  // Bare `visually` in a terminal → interactive TUI control panel. Piped / no
  // TTY (or a leading flag like `--no-open`) → serve, for back-compat.
  if (!maybeCmd || maybeCmd.startsWith('-')) {
    if (maybeCmd === '--help' || maybeCmd === '-h') { console.log(HELP); return; }
    if (!maybeCmd && process.stdout.isTTY) {
      return (await import('../lib/tui/app.js')).runTui();
    }
    return serve(process.argv.slice(2));
  }

  switch (maybeCmd) {
    case 'help': case '--help': case '-h':
      console.log(HELP); return;
    case 'tui':
      return (await import('../lib/tui/app.js')).runTui();
    case 'serve':
      return serve(rest);
    case 'create':
      return (await import('../lib/create.js')).create(rest);
    case 'improve':
      return (await import('../lib/improve.js')).improve(rest);
    case 'reproduce':
      return (await import('../lib/reproduce.js')).reproduce(rest);
    case 'amend':
      return (await import('../lib/amend.js')).amend(rest);
    case 'refine':
      return (await import('../lib/refine.js')).refine(rest);
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

main().catch((err: unknown) => {
  console.error(`\nvisually: ${(err as Error).message}\n`);
  process.exit(1);
});
