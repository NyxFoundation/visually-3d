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

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

// Run claude in streaming mode. Returns { text, hadResult }.
//   prompt   the full prompt string
//   model    model alias (opus/sonnet/…)
//   runDir   directory to write stream.jsonl + reasoning.log into (optional)
//   quiet    suppress live console echo (logs still written)
export function runClaudeStreaming({ prompt, model, runDir, quiet = false }) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const args = [
    '-p', prompt,
    '--model', model || process.env.CLAUDE_MODEL || 'opus',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', '',
  ];

  const streamLog = runDir ? createWriteStream(`${runDir}/stream.jsonl`, { flags: 'a' }) : null;
  const reasonLog = runDir ? createWriteStream(`${runDir}/reasoning.log`, { flags: 'a' }) : null;

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`failed to spawn ${bin}: ${err.message}`));
      return;
    }

    let lineBuf = '';
    let textAcc = '';
    let resultText = null;
    let section = null; // 'thinking' | 'text' | null — for console section headers
    let stderr = '';

    const enterSection = (s) => {
      if (section === s) return;
      section = s;
      if (!quiet) process.stdout.write(`\n${cyan(s === 'thinking' ? '⟲ thinking' : '✎ writing scene')}\n`);
      if (reasonLog) reasonLog.write(`\n\n### ${s}\n`);
    };

    const handleEvent = (evt) => {
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

    proc.stdout.on('data', (chunk) => {
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

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      streamLog?.write(chunk.toString());
    });

    proc.on('error', (err) => {
      const msg = err.code === 'ENOENT'
        ? `${bin} not found. Install the Claude CLI and run its login flow first.`
        : `failed to spawn ${bin}: ${err.message}`;
      reject(new Error(msg));
    });

    proc.on('close', (code) => {
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
