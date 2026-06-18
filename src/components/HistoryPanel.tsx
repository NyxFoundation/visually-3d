import { useEffect, useRef, useState } from 'react';
import type { FileRef, RevisionDetail, RevisionEntry, StructuralDiff, TimelineEntry, VerificationEntry } from '../types';

type HistoryPanelProps = { id: string; open: boolean; onClose: () => void };

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: TimelineEntry[] };

function fileUrl(id: string, ref: FileRef): string {
  return `/api/runs/${encodeURIComponent(id)}/${encodeURIComponent(ref.runId)}/file?path=${encodeURIComponent(ref.file)}`;
}

function fmt(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// Fetch + show a text artifact (LLM trace, impl code, verify log). Keyed by file
// so the parent remounts it on change — no synchronous reset in the effect.
function FileText({ id, refTo }: { id: string; refTo: FileRef }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(fileUrl(id, refTo))
      .then((res) => res.text())
      .then((raw) => {
        if (cancelled) return;
        let body = raw;
        if (refTo.file.endsWith('.json')) { try { body = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* raw */ } }
        setText(body);
      })
      .catch(() => { if (!cancelled) setText('(failed to load)'); });
    return () => { cancelled = true; };
  }, [id, refTo]);
  return <pre className="rd__view-pre">{text ?? 'loading…'}</pre>;
}

function StructuralDiffView({ diff }: { diff: StructuralDiff }) {
  const empty = !diff.added.length && !diff.removed.length && !diff.changed.length && !diff.meta.length;
  if (empty) return <p className="impl-panel__hint">no descriptor changes in this revision.</p>;
  return (
    <div className="diff">
      {diff.meta.length ? (
        <div className="diff__group">
          <div className="diff__head">scene</div>
          {diff.meta.map((m) => (
            <div key={m.field} className="diff__field"><span className="diff__fname">{m.field}</span> <span className="diff__from">{fmt(m.before)}</span> → <span className="diff__to">{fmt(m.after)}</span></div>
          ))}
        </div>
      ) : null}
      {diff.added.length ? (
        <div className="diff__group">
          <div className="diff__head diff__head--add">added {diff.added.length}</div>
          {diff.added.map((p) => <div key={p.id} className="diff__part diff__part--add">+ {p.id}{p.shape ? <span className="diff__muted"> ({p.shape})</span> : null}</div>)}
        </div>
      ) : null}
      {diff.removed.length ? (
        <div className="diff__group">
          <div className="diff__head diff__head--del">removed {diff.removed.length}</div>
          {diff.removed.map((p) => <div key={p.id} className="diff__part diff__part--del">− {p.id}</div>)}
        </div>
      ) : null}
      {diff.changed.length ? (
        <div className="diff__group">
          <div className="diff__head diff__head--chg">changed {diff.changed.length}</div>
          {diff.changed.map((c) => (
            <div key={c.id} className="diff__part">
              <div className="diff__pid">· {c.id}</div>
              {c.fields.map((f) => (
                <div key={f.field} className="diff__field"><span className="diff__fname">{f.field}</span> <span className="diff__from">{fmt(f.before)}</span> → <span className="diff__to">{fmt(f.after)}</span></div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RawDiffView({ raw }: { raw: string }) {
  return (
    <pre className="diff__raw">
      {raw.split('\n').map((line, i) => {
        const cls = line.startsWith('+ ') ? 'diff__raw-add' : line.startsWith('- ') ? 'diff__raw-del' : 'diff__raw-ctx';
        return <div key={i} className={cls}>{line || ' '}</div>;
      })}
    </pre>
  );
}

function RevisionView({ id, entry }: { id: string; entry: RevisionEntry }) {
  const [detail, setDetail] = useState<RevisionDetail | 'loading' | 'error'>('loading');
  const [mode, setMode] = useState<'structural' | 'raw'>('structural');
  const [trace, setTrace] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/revisions?scene=${encodeURIComponent(id)}&rev=${encodeURIComponent(entry.key)}`)
      .then((res) => (res.ok ? (res.json() as Promise<RevisionDetail>) : Promise.reject(res)))
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setDetail('error'); });
    return () => { cancelled = true; };
  }, [id, entry.key]);

  if (detail === 'loading') return <p className="impl-panel__hint">loading…</p>;
  if (detail === 'error') return <p className="impl-panel__hint">couldn’t load this revision.</p>;

  return (
    <div className="rev">
      <div className="rev__title">
        <span className="rev__v">v{detail.version}</span>
        <span className="rev__src">{detail.source}</span>
        {detail.score != null ? <span className="history__score">{detail.score}</span> : null}
        {detail.delta != null && detail.delta !== 0 ? (
          <span className={`rd__delta rd__delta--${detail.delta > 0 ? 'up' : 'down'}`}>{detail.delta > 0 ? `▲ +${detail.delta}` : `▼ ${detail.delta}`}</span>
        ) : null}
        <span className="history__when">{detail.startedAt.replace('T', ' ')}</span>
      </div>

      {/* WHY — the LLM's judgement that drove this change */}
      {detail.reasoning.critique || detail.trace ? (
        <section className="rev__why">
          <div className="rev__label">reasoning</div>
          {detail.reasoning.critique ? <p className="rev__critique">{detail.reasoning.critique}</p> : null}
          {detail.reasoning.remainingGaps?.length ? (
            <div className="rev__gaps">{detail.reasoning.remainingGaps.map((g, i) => <span key={i} className="rev__gap">{g}</span>)}</div>
          ) : null}
          {detail.trace ? (
            <>
              <button className="rd__chip" onClick={() => setTrace((p) => !p)}>{trace ? 'hide LLM trace' : 'full LLM trace'}</button>
              {trace ? <FileText key={detail.trace.file} id={id} refTo={detail.trace} /> : null}
            </>
          ) : null}
        </section>
      ) : null}

      {/* WHAT — the diff of the descriptor */}
      <section className="rev__what">
        <div className="rev__label">
          changes
          <span className="rev__toggle">
            <button className={`rd__chip${mode === 'structural' ? ' rd__chip--active' : ''}`} onClick={() => setMode('structural')}>structural</button>
            <button className={`rd__chip${mode === 'raw' ? ' rd__chip--active' : ''}`} onClick={() => setMode('raw')}>raw JSON</button>
          </span>
        </div>
        {detail.diff.initial ? <p className="impl-panel__hint">initial scene (v0) — {detail.diff.added.length} part(s).</p> : null}
        {mode === 'structural' ? <StructuralDiffView diff={detail.diff} /> : <RawDiffView raw={detail.rawDiff} />}
      </section>

      {detail.render ? <img className="rd__view-img" src={fileUrl(id, detail.render)} alt={`v${detail.version} render`} /> : null}
    </div>
  );
}

function VerificationView({ id, entry }: { id: string; entry: VerificationEntry }) {
  const [sel, setSel] = useState<FileRef | null>(null);
  return (
    <div className="rev">
      <div className="rev__title">
        <span className="rev__src">verification</span>
        {entry.reproducibility != null ? <span className="rd__stat">reproducibility <b>{entry.reproducibility}</b>/100</span> : null}
        {entry.verdict ? <span className="rd__stat">{entry.verdict}</span> : null}
        {entry.verify ? <span className="rd__stat">self-check {entry.verify.passed}/{entry.verify.total}</span> : null}
      </div>
      {entry.impls.map((im) => (
        <div key={im.n} className="rd__impl">
          <div className="rd__impl-head">
            <span className="rd__iter-n">impl {im.n}</span>
            <span className="rd__lang">{im.lang}</span>
            {im.pass != null ? <span className={`rd__verdict rd__verdict--${im.pass ? 'pass' : 'fail'}`}>{im.pass ? 'PASS ✓' : 'FAIL'}</span> : null}
          </div>
          <div className="rd__row">
            <button className="rd__chip rd__chip--impl" onClick={() => setSel({ runId: entry.runId, file: im.codeFile })}>code</button>
            {im.verifyFile ? <button className="rd__chip rd__chip--verify" onClick={() => setSel({ runId: entry.runId, file: im.verifyFile! })}>verify</button> : null}
            {im.logFile ? <button className="rd__chip rd__chip--log" onClick={() => setSel({ runId: entry.runId, file: im.logFile! })}>reasoning</button> : null}
          </div>
        </div>
      ))}
      {sel ? <FileText key={sel.file} id={id} refTo={sel} /> : null}
    </div>
  );
}

export function HistoryPanel({ id, open, onClose }: HistoryPanelProps) {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const fetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open || fetchedFor.current === id) return;
    fetchedFor.current = id;
    let cancelled = false;
    fetch(`/api/revisions?scene=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ entries: TimelineEntry[] }>) : Promise.reject(res)))
      .then((data) => {
        if (cancelled) return;
        setList({ status: 'ready', entries: data.entries });
        const lastRev = [...data.entries].reverse().find((e) => e.kind === 'revision');
        setSelected((lastRev ?? data.entries[data.entries.length - 1])?.key ?? null);
      })
      .catch((err: unknown) => { if (!cancelled) setList({ status: 'error', message: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [open, id]);

  const entries = list.status === 'ready' ? list.entries : [];
  const active = entries.find((e) => e.key === selected) ?? null;

  return (
    <aside className={`impl-panel history-panel${open ? ' impl-panel--open' : ''}`} aria-hidden={!open} aria-label="Revision timeline">
      <header className="impl-panel__head">
        <strong>History</strong>
        <span className="impl-panel__tags">
          {list.status === 'ready' ? <span className="impl-panel__tag">{entries.filter((e) => e.kind === 'revision').length} version(s)</span> : null}
        </span>
        <button className="impl-panel__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="impl-panel__body">
        {list.status === 'loading' ? (
          <p className="impl-panel__hint">loading…</p>
        ) : list.status === 'error' ? (
          <p className="impl-panel__hint">couldn’t load history: {list.message}</p>
        ) : entries.length === 0 ? (
          <p className="impl-panel__hint">
            No history yet. Generate or refine this scene (<code>visually refine {id}</code>) and its
            version timeline — diffs and the LLM reasoning behind each change — appears here.
          </p>
        ) : (
          <div className="tl">
            <div className="tl__rail">
              {entries.map((e) => (
                <button
                  key={e.key}
                  className={`tl__node tl__node--${e.kind}${selected === e.key ? ' tl__node--active' : ''}`}
                  onClick={() => setSelected(e.key)}
                >
                  {e.kind === 'revision' ? (
                    <>
                      <span className="tl__v">v{e.version}</span>
                      {e.render ? <img className="tl__thumb" src={fileUrl(id, e.render)} alt="" loading="lazy" /> : <span className="tl__thumb tl__thumb--none" aria-hidden />}
                      <span className="tl__col">
                        <span className="tl__meta">
                          {e.score != null ? <span className="tl__score">{e.score}</span> : null}
                          {e.delta != null && e.delta !== 0 ? <span className={`rd__delta rd__delta--${e.delta > 0 ? 'up' : 'down'}`}>{e.delta > 0 ? `+${e.delta}` : e.delta}</span> : null}
                        </span>
                        <span className="tl__src">{e.source}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="tl__v tl__v--verify" aria-hidden>⚙</span>
                      <span className="tl__col">
                        <span className="tl__meta">{e.reproducibility != null ? <span className="tl__score">{e.reproducibility}</span> : null}{e.verify ? <span className="rd__lang">{e.verify.passed}/{e.verify.total}</span> : null}</span>
                        <span className="tl__src">verified</span>
                      </span>
                    </>
                  )}
                </button>
              ))}
            </div>
            <div className="tl__detail">
              {active?.kind === 'revision' ? <RevisionView key={active.key} id={id} entry={active} />
                : active?.kind === 'verification' ? <VerificationView key={active.key} id={id} entry={active} />
                  : <p className="impl-panel__hint">select a version.</p>}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
