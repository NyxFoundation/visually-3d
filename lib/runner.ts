// Streaming Claude runner for `create` (and friends): drives `claude -p` with
// --output-format stream-json so the model's *reasoning* streams live to the
// console and every byte is captured to a run directory for later inspection.
//
// The Claude CLI emits newline-delimited JSON events. We care about:
//   - content_block_delta / thinking_delta  → the model thinking out loud
//   - content_block_delta / text_delta      → the answer being written
//   - type:"result"                         → the authoritative final text
// Everything is also appended verbatim to stream.jsonl, and a human-readable
// thinking+answer transcript to reasoning.log.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;

export interface RunResult {
  text: string;
  hadResult: boolean;
}

export interface RunOptions {
  prompt: string;
  model?: string;
  runDir?: string;
  quiet?: boolean;
  // Tools to enable for THIS run. The core loop (reproduce/judge/amend) runs
  // tool-less (deterministic, sandboxed) — leave unset. The evidence-gathering
  // step opts into web access by passing e.g. ['WebFetch', 'WebSearch'].
  tools?: string[];
  // Permission mode when tools are enabled (default 'bypassPermissions', the
  // same non-interactive mode the visual pass uses to Read its render).
  permissionMode?: string;
}

// Run claude in streaming mode. Returns { text, hadResult }.
export function runClaudeStreaming({ prompt, model, runDir, quiet = false, tools, permissionMode }: RunOptions): Promise<RunResult> {
  const bin = process.env.CLAUDE_BIN || 'claude';
  // The prompt is fed via STDIN (written below), NOT as an argv: a large scene +
  // evidence/grounding can exceed the OS single-arg limit (MAX_ARG_STRLEN, ~128KB)
  // and spawn fails with E2BIG "Argument list too long". `-p` + piped stdin is
  // print mode (the prompt is read from stdin).
  const args = [
    '-p',
    '--model', model || process.env.CLAUDE_MODEL || 'opus',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (tools && tools.length) {
    // Web access (or any tool) requires a non-interactive permission mode, or
    // the CLI blocks waiting for approval and the run hangs.
    args.push('--tools', ...tools, '--permission-mode', permissionMode || 'bypassPermissions');
  } else {
    args.push('--tools', '');
  }

  const streamLog = runDir ? createWriteStream(`${runDir}/stream.jsonl`, { flags: 'a' }) : null;
  const reasonLog = runDir ? createWriteStream(`${runDir}/reasoning.log`, { flags: 'a' }) : null;

  return new Promise<RunResult>((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      // Hand the (possibly large) prompt over stdin, then close it.
      proc.stdin?.on('error', () => { /* ignore EPIPE if the child exits early */ });
      proc.stdin?.end(prompt);
    } catch (err) {
      reject(new Error(`failed to spawn ${bin}: ${(err as Error).message}`));
      return;
    }

    let lineBuf = '';
    let textAcc = '';
    let resultText: string | null = null;
    let section: 'thinking' | 'text' | null = null;
    let stderr = '';

    const enterSection = (s: 'thinking' | 'text'): void => {
      if (section === s) return;
      section = s;
      if (!quiet) process.stdout.write(`\n${cyan(s === 'thinking' ? '⟲ thinking' : '✎ writing scene')}\n`);
      if (reasonLog) reasonLog.write(`\n\n### ${s}\n`);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleEvent = (evt: any): void => {
      // Stream deltas (partial messages).
      if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta') {
        const d = evt.event.delta || {};
        if (d.type === 'thinking_delta' && d.thinking) {
          enterSection('thinking');
          if (!quiet) process.stdout.write(dim(d.thinking));
          reasonLog?.write(d.thinking);
        } else if (d.type === 'text_delta' && d.text) {
          enterSection('text');
          textAcc += d.text;
          if (!quiet) process.stdout.write(d.text);
          reasonLog?.write(d.text);
        }
        return;
      }
      // Authoritative final result.
      if (evt.type === 'result' && typeof evt.result === 'string') {
        resultText = evt.result;
      }
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      streamLog?.write(text);
      lineBuf += text;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try { handleEvent(JSON.parse(t)); } catch { /* non-JSON line, ignore */ }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      streamLog?.write(chunk.toString());
    });

    proc.on('error', (err: Error & { code?: string }) => {
      const msg = err.code === 'ENOENT'
        ? `${bin} not found. Install the Claude CLI and run its login flow first.`
        : `failed to spawn ${bin}: ${err.message}`;
      reject(new Error(msg));
    });

    proc.on('close', (code: number | null) => {
      streamLog?.end();
      reasonLog?.end();
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}${stderr ? `:\n${stderr.slice(0, 800)}` : ''}`));
        return;
      }
      const text = resultText ?? textAcc;
      if (!text.trim()) {
        reject(new Error('claude produced no output text'));
        return;
      }
      if (!quiet) process.stdout.write('\n');
      resolve({ text, hadResult: resultText != null });
    });
  });
}
