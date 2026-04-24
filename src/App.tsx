import { useEffect, useMemo, useState } from 'react';
import { PartInfo } from './components/PartInfo';
import { InfoPanel } from './components/InfoPanel';
import { LazyViewer } from './components/LazyViewer';
import { SampleGallery, type SampleEntry } from './components/SampleGallery';
import { MOCK_SCENE, type Part, type SceneDescriptor } from './types';

type LogEntry = {
  stream: 'system' | 'stdout' | 'stderr' | 'client';
  message: string;
};

type BackendStatus = 'probing' | 'available' | 'unavailable';

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
  const [activeSampleId, setActiveSampleId] = useState<string | undefined>();
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [samples, setSamples] = useState<SampleEntry[]>([]);
  const [backend, setBackend] = useState<BackendStatus>('probing');
  const [logs, setLogs] = useState<LogEntry[]>([
    { stream: 'system', message: 'Ready.' },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  const appendLog = (entry: LogEntry) => setLogs((prev) => [...prev.slice(-300), entry]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    fetch('/api/health', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then(() => {
        if (!cancelled) setBackend('available');
      })
      .catch(() => {
        if (!cancelled) setBackend('unavailable');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/samples/index.json')
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: { samples: SampleEntry[] }) => {
        if (cancelled) return;
        setSamples(data.samples ?? []);
      })
      .catch(() => {
        if (!cancelled) setSamples([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (samples.length === 0) return;
    if (scene !== MOCK_SCENE) return;
    const first = samples[0];
    fetch(first.path)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: SceneDescriptor) => {
        setScene(data);
        setActiveSampleId(first.id);
      })
      .catch(() => undefined);
  }, [samples, scene]);

  const handleSampleSelect = (sample: SampleEntry, sampleScene: SceneDescriptor) => {
    setScene(sampleScene);
    setActiveSampleId(sample.id);
    setSelectedPart(null);
    setInfoOpen(false);
    setError(null);
    appendLog({ stream: 'system', message: `Loaded sample: ${sample.title}` });
  };

  const handlePartSelect = (part: Part) => {
    setSelectedPart(part);
    setPanelOpen(true);
  };

  const handleAnalyze = async () => {
    const value = input.trim();
    if (!value) return;

    setIsLoading(true);
    setError(null);
    setLogs([{ stream: 'client', message: `Submitting: ${value}` }]);

    try {
      const body = value.startsWith('http://') || value.startsWith('https://') ? { url: value } : { machine_name: value };
      const response = await fetch('/api/analyze/stream', {
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
          setActiveSampleId(undefined);
          setSelectedPart(null);
          setInfoOpen(false);
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

  const showAnalyzeUI = backend === 'available';
  const logText = useMemo(() => logs.map((entry) => `[${entry.stream}] ${entry.message}`).join('\n'), [logs]);
  const hasInfo = useMemo(() => {
    const info = scene.metadata?.info;
    return Boolean(
      info || scene.assembly_instructions || scene.metadata?.reference,
    );
  }, [scene]);

  return (
    <main className="app-shell">
      <div className="stage">
        <LazyViewer scene={scene} selectedPartId={selectedPart?.id} onPartSelect={handlePartSelect} />

        <header className="hero" aria-label="Current machine">
          <div className="hero__title">
            <span className="hero__eyebrow">Visually</span>
            <h1>{scene.machine_name}</h1>
            {scene.assembly_instructions ? <p>{scene.assembly_instructions}</p> : null}
          </div>
          <div className="hero__badges">
            {hasInfo ? (
              <button
                type="button"
                className="badge badge--info"
                onClick={() => setInfoOpen((prev) => !prev)}
                aria-expanded={infoOpen}
                aria-controls="info-panel"
                title="Show sources and basic info"
              >
                <span className="badge__icon" aria-hidden>i</span>
                <span>info</span>
              </button>
            ) : null}
            <span className={`badge badge--${backend}`}>
              {backend === 'probing' ? 'probing backend…' : backend === 'available' ? 'local backend online' : 'gallery-only mode'}
            </span>
            <span className="badge badge--count">{scene.parts.length} parts</span>
          </div>
        </header>

        {showAnalyzeUI ? (
          <section className="analyze-bar">
            <input
              className="analyze-bar__input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && handleAnalyze()}
              placeholder="Machine name or URL…"
              aria-label="Machine name or URL"
            />
            <button className="analyze-bar__button" onClick={handleAnalyze} disabled={isLoading}>
              {isLoading ? 'Analyzing…' : 'Analyze'}
            </button>
          </section>
        ) : null}

        {showAnalyzeUI ? (
          <button
            className={`log-toggle${showLogs ? ' log-toggle--open' : ''}`}
            onClick={() => setShowLogs((prev) => !prev)}
            aria-expanded={showLogs}
            aria-controls="log-console"
          >
            {showLogs ? 'hide logs' : 'show logs'}
          </button>
        ) : null}

        {showAnalyzeUI && showLogs ? (
          <section id="log-console" className="log-console">
            <header>
              <strong>Claude CLI stream</strong>
              <span>{isLoading ? 'running' : 'idle'}</span>
            </header>
            <pre>{logText}</pre>
          </section>
        ) : null}

        {error ? <div className="error-toast">{error}</div> : null}

        <PartInfo part={selectedPart} open={panelOpen && !!selectedPart} onClose={() => setPanelOpen(false)} />
        <InfoPanel scene={scene} open={infoOpen} onClose={() => setInfoOpen(false)} />
      </div>

      {samples.length > 0 ? (
        <SampleGallery samples={samples} activeId={activeSampleId} onSelect={handleSampleSelect} />
      ) : null}
    </main>
  );
}

export default App;
