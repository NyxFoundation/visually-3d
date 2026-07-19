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

The loop is three commands: visualize → verify → refine.

Usage:
  visually                                interactive TUI control panel (in a terminal)
  visually serve [--no-open]              start the local web GUI
  visually visualize <scene | "name">     fetch ground-truth evidence (reference
       [--url <paper-url>] [--iters N]     paper + real SOURCE CODE) and build/
       [--driver claude|codex] [--model m] improve the 3D model GROUNDED in it.
       [--no-evidence] [--no-refs]         Births a draft first if it doesn't exist.
  visually verify <scene>                 formally verify the REAL source with the
       [--model <m>] [--backend <id>]     backend (z3/SMT for circuits & algorithms,
                                          sim for machines). Needs gathered source
                                          (run visualize first); else errors.
  visually refine <scene>                 the closed loop: each round runs
       [--rounds 3] [--visual 90]         visualize → verify, ratcheting on the best
       [--iters 1] [--backend <id>]       scene, until the visual goal is met AND the
       [--no-evidence] [--no-refs]        source verifies (or max rounds).
  visually invent <scene>                 the INVENTION loop: each round ideates
       [--rounds 3] [--contradiction "…"] concept candidates from the evidence
       [--concept <slug>] [--attempts N]  (five delta operators; every 3rd round
       [--backend <id>] [--no-visual]     lifts the conventionality constraint),
                                          implements the chosen concept, verifies
                                          its falsifiable prediction with the
                                          backend (falsified = recorded honest
                                          kill), and renders verified inventions.
  visually check <scene> [--png]          inspect a scene (browser, or PNG contact sheet)
       [--out <file.png>] [--no-open]
  visually upload <scene>                 publish the scene + history to the WEB
       [--repo owner/name] [--title <t>]  GALLERY (public/samples). Repo checkout:
       [--scrub] [--no-push] [--dry-run]  commit + push to origin. Installed (npx):
                                          fork + open a PR. Auto-detected.

Mode is auto-detected from the subject (override at creation), and the
verification backend is auto-selected from what the subject IS (digital/compute
→ SMT, physical machine → sim). Every run streams the model's reasoning live and
is logged under ~/.visually-3d/runs/.

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
    case 'visualize':
      return (await import('../lib/visualize.js')).visualize(rest);
    case 'verify':
      return (await import('../lib/verify.js')).verify(rest);
    case 'refine':
      return (await import('../lib/refine.js')).refine(rest);
    case 'invent':
      return (await import('../lib/invent.js')).invent(rest);
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
