import { useEffect, useRef, useState } from 'react';
import type { RunArtifact, RunDetail, RunSummary } from '../types';

type HistoryPanelProps = {
  id: string;
  open: boolean;
  onClose: () => void;
};

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; runs: RunSummary[] };

type Preview = { runId: string; art: RunArtifact; image: boolean; text: string | null };

function fileUrl(id: string, runId: string, file: string): string {
  return `/api/runs/${encodeURIComponent(id)}/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(file)}`;
}

const TYPE_GLYPH: Record<string, string> = { create: '✦', improve: '↻', reproduce: '⚙', unknown: '·' };

export function HistoryPanel({ id, open, onClose }: HistoryPanelProps) {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, RunDetail | 'loading' | 'error'>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const fetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open || fetchedFor.current === id) return;
    fetchedFor.current = id;
    let cancelled = false;
    setList({ status: 'loading' });
    fetch(`/api/runs?scene=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ runs: RunSummary[] }>) : Promise.reject(res)))
      .then((data) => { if (!cancelled) setList({ status: 'ready', runs: data.runs }); })
      .catch((err: unknown) => {
        if (!cancelled) setList({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [open, id]);

  const toggleRun = (runId: string) => {
    setPreview(null);
    if (openRun === runId) { setOpenRun(null); return; }
    setOpenRun(runId);
    if (details[runId]) return;
    setDetails((prev) => ({ ...prev, [runId]: 'loading' }));
    fetch(`/api/runs/${encodeURIComponent(id)}/${encodeURIComponent(runId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<RunDetail>) : Promise.reject(res)))
      .then((detail) => setDetails((prev) => ({ ...prev, [runId]: detail })))
      .catch(() => setDetails((prev) => ({ ...prev, [runId]: 'error' })));
  };

  const openArtifact = (runId: string, art: RunArtifact) => {
    const image = art.kind === 'screenshot';
    setPreview({ runId, art, image, text: null });
    if (image) return;
    fetch(fileUrl(id, runId, art.file))
      .then((res) => res.text())
      .then((text) => setPreview((prev) => (prev && prev.art.file === art.file ? { ...prev, text } : prev)))
      .catch(() => setPreview((prev) => (prev && prev.art.file === art.file ? { ...prev, text: '(failed to load)' } : prev)));
  };

  const renderArtifacts = (runId: string, detail: RunDetail) => (
    <div className="history__arts">
      {detail.artifacts.map((art) => (
        art.kind === 'screenshot' ? (
          <button key={art.file} className="history__shot" onClick={() => openArtifact(runId, art)} title={art.label}>
            <img src={fileUrl(id, runId, art.file)} alt={art.label} loading="lazy" />
            <span>{art.label}</span>
          </button>
        ) : (
          <button key={art.file} className={`history__chip history__chip--${art.kind}`} onClick={() => openArtifact(runId, art)}>
            {art.label}
          </button>
        )
      ))}
    </div>
  );

  return (
    <aside className={`impl-panel history-panel${open ? ' impl-panel--open' : ''}`} aria-hidden={!open} aria-label="Run history">
      <header className="impl-panel__head">
        <strong>History</strong>
        <span className="impl-panel__tags">
          {list.status === 'ready' ? <span className="impl-panel__tag">{list.runs.length} run(s)</span> : null}
        </span>
        <button className="impl-panel__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="impl-panel__body">
        {list.status === 'loading' ? (
          <p className="impl-panel__hint">loading…</p>
        ) : list.status === 'error' ? (
          <p className="impl-panel__hint">couldn’t load history: {list.message}</p>
        ) : list.runs.length === 0 ? (
          <p className="impl-panel__hint">
            No runs yet for this scene. Generate or refine it (<code>visually refine {id}</code>) and the
            create / improve / reproduce history — renders, code versions, LLM logs — shows up here.
          </p>
        ) : (
          list.runs.map((run) => {
            const detail = details[run.runId];
            const expanded = openRun === run.runId;
            return (
              <div key={run.runId} className={`history__run${expanded ? ' history__run--open' : ''}`}>
                <button className="history__row" onClick={() => toggleRun(run.runId)} aria-expanded={expanded}>
                  <span className="history__glyph" aria-hidden>{TYPE_GLYPH[run.type] ?? '·'}</span>
                  <span className="history__type">{run.type}</span>
                  <span className="history__when">{run.startedAt.replace('T', ' ')}</span>
                  <span className="history__meta">
                    {run.score != null ? <span className="history__score">{run.score}</span> : null}
                    {run.iterations ? <span className="history__iters">{run.iterations}×</span> : null}
                    <span className={`history__status history__status--${run.status}`}>{run.status}</span>
                  </span>
                </button>

                {expanded ? (
                  <div className="history__detail">
                    {detail === 'loading' || detail === undefined ? (
                      <p className="impl-panel__hint">loading…</p>
                    ) : detail === 'error' ? (
                      <p className="impl-panel__hint">couldn’t load this run.</p>
                    ) : (
                      <>
                        {renderArtifacts(run.runId, detail)}
                        {preview && preview.runId === run.runId ? (
                          <div className="history__preview">
                            <div className="history__preview-head">{preview.art.label}</div>
                            {preview.image ? (
                              <img className="history__preview-img" src={fileUrl(id, run.runId, preview.art.file)} alt={preview.art.label} />
                            ) : (
                              <pre className="impl-panel__output">{preview.text ?? 'loading…'}</pre>
                            )}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
