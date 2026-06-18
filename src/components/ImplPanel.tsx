import { useEffect, useRef, useState } from 'react';
import { streamPostSse } from '../sse';
import type { StoredImpl } from '../types';

type ImplPanelProps = {
  id: string;
  backendOnline: boolean;
  open: boolean;
  onClose: () => void;
};

type FetchState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'error'; message: string }
  | { status: 'ready'; impl: StoredImpl };

type VerifyState = {
  running: boolean;
  lines: string[];
  result: { pass: boolean; ran: boolean } | null;
};

const IDLE_VERIFY: VerifyState = { running: false, lines: [], result: null };

export function ImplPanel({ id, backendOnline, open, onClose }: ImplPanelProps) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' });
  const [verify, setVerify] = useState<VerifyState>(IDLE_VERIFY);
  const fetchedFor = useRef<string | null>(null);

  // Load the persisted implementation the first time the panel is opened for
  // this scene (404 → "none", i.e. not reproduced yet).
  useEffect(() => {
    if (!open || fetchedFor.current === id) return;
    fetchedFor.current = id;
    let cancelled = false;
    setFetchState({ status: 'loading' });
    fetch(`/api/impl/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (res.status === 404) return { status: 'none' as const };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { status: 'ready' as const, impl: (await res.json()) as StoredImpl };
      })
      .then((next) => { if (!cancelled) setFetchState(next); })
      .catch((err: unknown) => {
        if (!cancelled) setFetchState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [open, id]);

  const runTests = () => {
    setVerify({ running: true, lines: ['running…'], result: null });
    const append = (line: string) => setVerify((prev) => ({ ...prev, lines: [...prev.lines.slice(-400), line] }));
    streamPostSse(`/api/impl/${encodeURIComponent(id)}/verify`, {}, (event, data) => {
      const payload = JSON.parse(data) as {
        message?: string; stdout?: string; stderr?: string; pass?: boolean; ran?: boolean;
      };
      if (event === 'status') append(payload.message ?? '');
      else if (event === 'output') {
        if (payload.stdout) append(payload.stdout.trimEnd());
        if (payload.stderr) append(payload.stderr.trimEnd());
      } else if (event === 'result') {
        setVerify((prev) => ({ ...prev, result: { pass: !!payload.pass, ran: !!payload.ran } }));
      } else if (event === 'error') {
        append(`error: ${payload.message ?? 'unknown'}`);
      }
    })
      .catch((err: unknown) => append(`error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setVerify((prev) => ({ ...prev, running: false })));
  };

  const meta = fetchState.status === 'ready' ? fetchState.impl.meta : null;

  return (
    <aside className={`impl-panel${open ? ' impl-panel--open' : ''}`} aria-hidden={!open} aria-label="Implementation">
      <header className="impl-panel__head">
        <strong>Implementation</strong>
        {meta ? (
          <span className="impl-panel__tags">
            <span className="impl-panel__tag">{meta.language}</span>
            <span className="impl-panel__tag">{meta.backend}</span>
            {typeof meta.reproducibility === 'number' ? (
              <span className="impl-panel__tag">repro {meta.reproducibility}/100</span>
            ) : null}
            {meta.verified ? (
              <span className={`impl-panel__tag impl-panel__tag--${meta.verified.pass ? 'pass' : 'fail'}`}>
                {meta.verified.pass ? 'verified ✓' : meta.verified.ran ? 'failed' : 'not run'}
              </span>
            ) : null}
          </span>
        ) : null}
        <button className="impl-panel__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="impl-panel__body">
        {fetchState.status === 'loading' ? (
          <p className="impl-panel__hint">loading…</p>
        ) : fetchState.status === 'error' ? (
          <p className="impl-panel__hint">couldn’t load implementation: {fetchState.message}</p>
        ) : fetchState.status === 'none' ? (
          <p className="impl-panel__hint">
            No implementation yet. Run <code>visually reproduce {id}</code> to generate one
            (it reverse-implements this build from the spec and verifies it).
          </p>
        ) : (
          <>
            <pre className="impl-panel__code"><code>{fetchState.impl.code}</code></pre>

            <div className="impl-panel__run">
              <button
                className="analyze-bar__button"
                onClick={runTests}
                disabled={!backendOnline || verify.running}
                title={backendOnline ? 'Re-run the self-check through the backend' : 'Start the local backend (visually serve) to run tests'}
              >
                {verify.running ? 'running…' : 'Run tests'}
              </button>
              {!backendOnline ? <span className="impl-panel__hint">local backend offline</span> : null}
              {verify.result ? (
                <span className={`impl-panel__verdict impl-panel__verdict--${verify.result.pass ? 'pass' : 'fail'}`}>
                  {verify.result.pass ? 'PASS ✓' : verify.result.ran ? 'FAIL' : 'did not run'}
                </span>
              ) : null}
            </div>

            {verify.lines.length ? (
              <pre className="impl-panel__output">{verify.lines.join('\n')}</pre>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
