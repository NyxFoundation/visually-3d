import { useCallback, useEffect, useMemo, useState } from 'react';
import { GalleryPage, type AnalyzeController } from './pages/GalleryPage';
import { DetailPage } from './pages/DetailPage';
import { LIVE_ID, hrefForDetail, navigate, useRoute } from './router';
import { parseSseChunk } from './sse';
import type { SampleCategory, SampleEntry, SceneDescriptor } from './types';

type LogEntry = {
  stream: 'system' | 'stdout' | 'stderr' | 'client';
  message: string;
};

type BackendStatus = 'probing' | 'available' | 'unavailable';

function App() {
  const route = useRoute();
  const [samples, setSamples] = useState<SampleEntry[]>([]);
  const [categories, setCategories] = useState<SampleCategory[]>([]);
  const [samplesLoaded, setSamplesLoaded] = useState(false);
  const [backend, setBackend] = useState<BackendStatus>('probing');

  const [liveScene, setLiveScene] = useState<SceneDescriptor | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([{ stream: 'system', message: 'Ready.' }]);

  const appendLog = (entry: LogEntry) => setLogs((prev) => [...prev.slice(-300), entry]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    fetch('/api/health', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then(() => { if (!cancelled) setBackend('available'); })
      .catch(() => { if (!cancelled) setBackend('unavailable'); })
      .finally(() => clearTimeout(timeout));
    return () => { cancelled = true; controller.abort(); clearTimeout(timeout); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/samples/index.json')
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: { samples?: SampleEntry[]; categories?: SampleCategory[] }) => {
        if (cancelled) return;
        setSamples(data.samples ?? []);
        setCategories(data.categories ?? []);
      })
      .catch(() => { if (!cancelled) { setSamples([]); setCategories([]); } })
      .finally(() => { if (!cancelled) setSamplesLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const handleAnalyze = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || isLoading) return;
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
      if (!response.ok || !response.body) throw new Error(`Backend returned HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const onEvent = (eventName: string, data: string) => {
        const payload = JSON.parse(data) as { stream?: LogEntry['stream']; message?: string; data?: SceneDescriptor };
        if (eventName === 'log') {
          appendLog({ stream: payload.stream ?? 'system', message: payload.message ?? '' });
        } else if (eventName === 'result' && payload.data) {
          const nextScene = payload.data;
          setLiveScene(nextScene);
          appendLog({ stream: 'system', message: `Rendered ${nextScene.parts.length} parts.` });
          navigate(hrefForDetail(LIVE_ID));
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
  }, [isLoading]);

  const logText = useMemo(() => logs.map((entry) => `[${entry.stream}] ${entry.message}`).join('\n'), [logs]);

  const analyze: AnalyzeController = useMemo(() => ({
    available: backend === 'available',
    isLoading,
    error,
    logText,
    run: (value: string) => { void handleAnalyze(value); },
  }), [backend, isLoading, error, logText, handleAnalyze]);

  if (route.name === 'detail') {
    return <DetailPage key={route.id} id={route.id} samples={samples} liveScene={liveScene} samplesLoaded={samplesLoaded} />;
  }
  return <GalleryPage samples={samples} categories={categories} analyze={analyze} />;
}

export default App;
