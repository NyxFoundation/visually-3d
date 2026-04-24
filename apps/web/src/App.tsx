import React, { useState } from 'react';
import { PartInfo } from './components/PartInfo';
import { Viewer } from './components/Viewer';
import { MOCK_SCENE, type Part, type SceneDescriptor } from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000';

type LogEntry = {
  stream: 'system' | 'stdout' | 'stderr' | 'client';
  message: string;
};

function parseSseChunk(buffer: string, onEvent: (event: string, data: string) => void): string {
  const events = buffer.split('\n\n');
  const remainder = events.pop() ?? '';
  for (const rawEvent of events) {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) onEvent(eventName, dataLines.join('\n'));
  }
  return remainder;
}

function App() {
  const [input, setInput] = useState('Electromagnetic interference situation awareness device');
  const [scene, setScene] = useState<SceneDescriptor>(MOCK_SCENE);
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([
    { stream: 'system', message: 'Ready. Backend will call the local authenticated `claude -p` command.' },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appendLog = (entry: LogEntry) => setLogs((prev) => [...prev.slice(-300), entry]);

  const handleAnalyze = async () => {
    const value = input.trim();
    if (!value) return;

    setIsLoading(true);
    setError(null);
    setLogs([{ stream: 'client', message: `Submitting: ${value}` }]);

    try {
      const body = value.startsWith('http://') || value.startsWith('https://') ? { url: value } : { machine_name: value };
      const response = await fetch(`${API_BASE}/analyze/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Backend returned HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const onEvent = (eventName: string, data: string) => {
        const payload = JSON.parse(data);
        if (eventName === 'log') {
          appendLog({ stream: payload.stream ?? 'system', message: payload.message ?? '' });
        } else if (eventName === 'result') {
          const nextScene = payload.data as SceneDescriptor;
          setScene(nextScene);
          setSelectedPart(null);
          appendLog({ stream: 'system', message: `Rendered ${nextScene.parts.length} parts.` });
        } else if (eventName === 'error') {
          const message = payload.message ?? 'Unknown stream error';
          setError(message);
          appendLog({ stream: 'stderr', message });
        }
      };

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        buffer = parseSseChunk(buffer, onEvent);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      appendLog({ stream: 'stderr', message });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="app-shell">
      <Viewer scene={scene} selectedPartId={selectedPart?.id} onPartSelect={setSelectedPart} />

      <section className="topbar">
        <div>
          <h1>{scene.machine_name}</h1>
          <p>Local-first 3D machinery visualization. No API key is stored; the backend runs your local Claude CLI.</p>
        </div>
        <div className="input-row">
          <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && handleAnalyze()} />
          <button onClick={handleAnalyze} disabled={isLoading}>
            {isLoading ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
      </section>

      <section className="log-console">
        <header>
          <strong>Claude CLI stream</strong>
          <span>{isLoading ? 'running' : 'idle'}</span>
        </header>
        <pre>
          {logs.map((entry, index) => `[${entry.stream}] ${entry.message}`).join('')}
        </pre>
      </section>

      {error ? <div className="error-toast">{error}</div> : null}
      <PartInfo part={selectedPart} onClose={() => setSelectedPart(null)} />
    </main>
  );
}

export default App;
