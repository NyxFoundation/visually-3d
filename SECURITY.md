# Security Policy

## Supported versions

visually-3d is pre-1.0; security fixes land on the latest published version.
Please make sure you're on the newest release before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report privately via GitHub's
[private vulnerability reporting](https://github.com/NyxFoundation/visually-3d/security/advisories/new),
or email **kingmasatojames@gmail.com**.

Include:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- affected version(s).

We aim to acknowledge reports within a few days and to ship a fix or mitigation
as quickly as is practical. We'll credit you in the release notes unless you'd
prefer to stay anonymous.

## Scope & threat model

By design, visually-3d:

- handles **no** API keys or credentials — model calls go through your local
  `claude` / `codex` CLI and its own auth;
- runs a **local-only** HTTP server (bound to `127.0.0.1`) and spawns the CLI
  as a subprocess;
- has **no** backend, telemetry, or remote storage.

Areas we especially care about:

- path traversal or arbitrary file read/write through the local server or the
  workspace (`~/.visually-3d`),
- command injection via prompts, scene fields, or filenames passed to a
  subprocess,
- the `upload` flow mishandling `gh` auth or pushing unintended files.
