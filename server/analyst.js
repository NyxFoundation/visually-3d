import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { buildSystemPrompt, detectMode } from './modes.js';

const execFile = promisify(execFileCb);

// Back-compat default: the hardware-mode system prompt. Mode-aware callers
// should use buildSystemPrompt(mode) / buildPrompt({ mode }) instead.
export const SYSTEM_PROMPT = buildSystemPrompt('hardware');

export { detectMode, buildSystemPrompt };

export async function claudeAvailable() {
  try {
    await execFile('claude', ['--version'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function fetchUrlContent(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    if (!res.ok) return `Could not fetch URL content for ${url}: HTTP ${res.status}`;
    // Only extract text from textual responses. Reading a binary body (e.g. an
    // image) as text yields garbage with NUL bytes, which later crashes the
    // subprocess call (args may not contain null bytes).
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!/^text\/|application\/(json|xml|xhtml|ld\+json|rss\+xml|atom\+xml)/.test(type)) {
      return `The URL is non-text content (${type || 'unknown type'}) — most likely an image. ` +
        `No text could be extracted; rely on the machine name and your own knowledge.`;
    }
    const text = await res.text();
    return sanitizeText(text).slice(0, 12000);
  } catch (err) {
    return `Could not fetch URL content for ${url}: ${err.message}`;
  }
}

// Strip NUL and other C0 control characters (keeping tab/newline/CR) so the
// prompt is always a clean string safe to pass as a subprocess argument.
function sanitizeText(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// Build the full generation prompt. `mode` selects the persona/quality-bar/
// materials/strategy (hardware | algorithm | architecture); when omitted it is
// auto-detected from the subject.
export async function buildPrompt({ url, machineName, mode }) {
  const sections = [];
  if (machineName) sections.push(`Machine name: ${machineName}`);
  if (url) {
    const content = await fetchUrlContent(url);
    sections.push(`Reference URL: ${url}\nFetched content excerpt:\n${content}`);
  }
  if (sections.length === 0) {
    throw new Error('Either url or machineName must be provided');
  }
  const resolvedMode = mode || detectMode(`${machineName || ''} ${url || ''}`);
  const system = buildSystemPrompt(resolvedMode);
  const prompt = `${system}\n\n${sections.join('\n\n')}\n\nGenerate the MachineSceneDescriptor JSON now. Return JSON only.`;
  return sanitizeText(prompt);
}

function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) {
    throw new Error('No JSON object found in Claude output');
  }
  try {
    return JSON.parse(text.slice(start, end));
  } catch (err) {
    throw new Error(`Claude returned invalid JSON: ${err.message}`);
  }
}

/**
 * Stream an analysis job. `writeEvent(event, data)` is called for each SSE-worthy event.
 * Resolves when the process finishes (successfully or with an error already emitted).
 */
export function streamAnalyze(prompt, writeEvent) {
  return new Promise((resolve) => {
    writeEvent('log', { stream: 'system', message: 'Starting local command: claude -p <prompt>' });

    let proc;
    try {
      proc = spawn('claude', ['-p', prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      writeEvent('error', { message: `Failed to spawn claude: ${err.message}. Ensure the Claude CLI is installed and in PATH.` });
      resolve();
      return;
    }

    let stdoutBuf = '';
    let errored = false;

    proc.on('error', (err) => {
      errored = true;
      const msg = err.code === 'ENOENT'
        ? 'claude command not found. Install the Claude CLI and run its login flow first.'
        : `Failed to spawn claude: ${err.message}`;
      writeEvent('error', { message: msg });
      resolve();
    });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      writeEvent('log', { stream: 'stdout', message: text });
    });

    proc.stderr.on('data', (chunk) => {
      writeEvent('log', { stream: 'stderr', message: chunk.toString() });
    });

    proc.on('close', (code) => {
      if (errored) return;
      writeEvent('log', { stream: 'system', message: `claude exited with code ${code}` });
      if (code !== 0) {
        writeEvent('error', { message: `claude exited with code ${code}` });
        resolve();
        return;
      }
      try {
        const data = extractJSON(stdoutBuf);
        writeEvent('result', { data });
      } catch (err) {
        writeEvent('error', { message: err.message });
      }
      resolve();
    });
  });
}
