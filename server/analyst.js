import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const execFile = promisify(execFileCb);

export const SYSTEM_PROMPT = `You are a PhD Mechanical Engineer and 3D Scene Architect.
Analyze the provided URL or machine name and describe the machine's components.
Output ONLY a JSON object that strictly follows this TypeScript shape:
{
  "machine_name": string,
  "assembly_instructions"?: string,
  "metadata"?: object,
  "parts": [
    {
      "id": string,
      "name": string,
      "shape": "box" | "cylinder" | "sphere" | "complex",
      "position": [number, number, number],
      "rotation"?: [number, number, number],
      "size": number[],
      "material": string,
      "role": string,
      "connections"?: string[]
    }
  ]
}

Use these visualization heuristics:
1. Place antennas/sensors higher in the scene. Put heavy control units and power supplies lower/central.
2. Use boxes for chassis/control units/displays, cylinders for antennas/shafts, spheres for knobs/joints.
3. Encode signal flow in connections: sensor/antenna -> processor/control unit -> interface/display.
4. If mounted on a vehicle/truck, include a chassis or mounting plate base.
5. Keep dimensions plausible and non-zero. Use y as vertical height for Three.js.
6. Cylinder geometry defaults to the Y axis. To lay a cylinder along Z (e.g., wheels), set rotation: [1.5707963, 0, 0]. To lay along X (e.g., side-mounted spools), set rotation: [0, 0, 1.5707963].
`;

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
    const text = await res.text();
    return text.slice(0, 12000);
  } catch (err) {
    return `Could not fetch URL content for ${url}: ${err.message}`;
  }
}

export async function buildPrompt({ url, machineName }) {
  let context;
  if (url) {
    const content = await fetchUrlContent(url);
    context = `URL: ${url}\nFetched content excerpt:\n${content}\n`;
  } else if (machineName) {
    context = `Machine name: ${machineName}\n`;
  } else {
    throw new Error('Either url or machineName must be provided');
  }
  return `${SYSTEM_PROMPT}\n\n${context}\nGenerate the MachineSceneDescriptor JSON now. Return JSON only.`;
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
