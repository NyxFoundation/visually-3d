import { useEffect, useRef, useState } from 'react';
import { LazyViewer } from './LazyViewer';
import { PartInfo } from './PartInfo';
import type {
  FieldChange, FileRef, Part, PartChange, RevisionDetail, RevisionEntry,
  SceneDescriptor, StructuralDiff, TimelineEntry, VerificationEntry,
} from '../types';

type SceneStudioProps = { id: string; fallbackScene: SceneDescriptor };

function fileUrl(id: string, ref: FileRef): string {
  return `/api/runs/${encodeURIComponent(id)}/${encodeURIComponent(ref.runId)}/file?path=${encodeURIComponent(ref.file)}`;
}

function fmt(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// ── carry-forward helpers: reconstruct each stream's state at a frame ─────────
function latestRevision(frames: TimelineEntry[], i: number): RevisionEntry | null {
  for (let j = i; j >= 0; j--) { const e = frames[j]; if (e.kind === 'revision') return e; }
  return null;
}
function latestRender(frames: TimelineEntry[], i: number): FileRef | null {
  for (let j = i; j >= 0; j--) { const e = frames[j]; if (e.kind === 'revision' && e.render) return e.render; }
  return null;
}
function latestVerification(frames: TimelineEntry[], i: number): VerificationEntry | null {
  for (let j = i; j >= 0; j--) { const e = frames[j]; if (e.kind === 'verification') return e; }
  return null;
}

// ── 3D pane: swap the scene descriptor without remounting the WebGL canvas ────
function SceneViewer({ url, fallback, selectedPartId, onPartSelect }: {
  url: string | null;
  fallback: SceneDescriptor;
  selectedPartId?: string;
  onPartSelect: (p: Part) => void;
}) {
  const [scene, setScene] = useState<SceneDescriptor>(fallback);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then((res) => (res.ok ? (res.json() as Promise<SceneDescriptor>) : Promise.reject(res)))
      .then((s) => { if (!cancelled) setScene(s); })
      .catch(() => { /* keep prior scene */ });
    return () => { cancelled = true; };
  }, [url]);
  return <LazyViewer scene={scene} selectedPartId={selectedPartId} onPartSelect={onPartSelect} />;
}

// Fetch + show a text file (impl code, LLM trace), keyed by url upstream.
function FileText({ url, json }: { url: string; json?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(url).then((r) => r.text()).then((raw) => {
      if (cancelled) return;
      let body = raw;
      if (json) { try { body = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* raw */ } }
      setText(body);
    }).catch(() => { if (!cancelled) setText('(failed to load)'); });
    return () => { cancelled = true; };
  }, [url, json]);
  return <pre className="studio__code">{text ?? 'loading…'}</pre>;
}

function StructuralDiffView({ diff }: { diff: StructuralDiff }) {
  const empty = !diff.added.length && !diff.removed.length && !diff.changed.length && !diff.meta.length;
  if (empty) return <p className="impl-panel__hint">no descriptor change.</p>;
  const field = (f: FieldChange) => (
    <div key={f.field} className="diff__field"><span className="diff__fname">{f.field}</span> <span className="diff__from">{fmt(f.before)}</span> → <span className="diff__to">{fmt(f.after)}</span></div>
  );
  return (
    <div className="diff">
      {diff.meta.map(field)}
      {diff.added.length ? <div className="diff__group"><div className="diff__head diff__head--add">added</div>{diff.added.map((p) => <div key={p.id} className="diff__part--add">+ {p.id}{p.shape ? <span className="diff__muted"> ({p.shape})</span> : null}</div>)}</div> : null}
      {diff.removed.length ? <div className="diff__group"><div className="diff__head diff__head--del">removed</div>{diff.removed.map((p) => <div key={p.id} className="diff__part--del">− {p.id}</div>)}</div> : null}
      {diff.changed.length ? <div className="diff__group"><div className="diff__head diff__head--chg">changed</div>{diff.changed.map((c: PartChange) => <div key={c.id} className="diff__part"><div className="diff__pid">· {c.id}</div>{c.fields.map(field)}</div>)}</div> : null}
    </div>
  );
}

function RawDiffView({ raw }: { raw: string }) {
  return <pre className="diff__raw">{raw.split('\n').map((l, i) => <div key={i} className={l.startsWith('+ ') ? 'diff__raw-add' : l.startsWith('- ') ? 'diff__raw-del' : 'diff__raw-ctx'}>{l || ' '}</div>)}</pre>;
}

// Readout for a revision frame: the LLM's reasoning + the descriptor diff.
function RevisionReadout({ url }: { url: string }) {
  const [detail, setDetail] = useState<RevisionDetail | 'loading' | 'error'>('loading');
  const [mode, setMode] = useState<'structural' | 'raw'>('structural');
  useEffect(() => {
    let cancelled = false;
    fetch(url).then((r) => (r.ok ? (r.json() as Promise<RevisionDetail>) : Promise.reject(r)))
      .then((d) => { if (!cancelled) setDetail(d); }).catch(() => { if (!cancelled) setDetail('error'); });
    return () => { cancelled = true; };
  }, [url]);
  if (detail === 'loading') return <p className="impl-panel__hint">loading…</p>;
  if (detail === 'error') return <p className="impl-panel__hint">couldn’t load.</p>;
  return (
    <div className="studio__readout-grid">
      <div className="studio__reason">
        <div className="rev__label">reasoning</div>
        {detail.reasoning.critique ? <p className="rev__critique">{detail.reasoning.critique}</p> : <p className="impl-panel__hint">{detail.diff.initial ? 'initial version.' : 'no critique recorded.'}</p>}
        {detail.reasoning.remainingGaps?.length ? <div className="rev__gaps">{detail.reasoning.remainingGaps.map((g, i) => <span key={i} className="rev__gap">{g}</span>)}</div> : null}
      </div>
      <div className="studio__changes">
        <div className="rev__label">changes<span className="rev__toggle">
          <button className={`rd__chip${mode === 'structural' ? ' rd__chip--active' : ''}`} onClick={() => setMode('structural')}>structural</button>
          <button className={`rd__chip${mode === 'raw' ? ' rd__chip--active' : ''}`} onClick={() => setMode('raw')}>raw</button>
        </span></div>
        {mode === 'structural' ? <StructuralDiffView diff={detail.diff} /> : <RawDiffView raw={detail.rawDiff} />}
      </div>
    </div>
  );
}

function VerificationReadout({ entry }: { entry: VerificationEntry }) {
  return (
    <div className="studio__readout-grid">
      <div className="studio__reason">
        <div className="rev__label">verification</div>
        <div className="rd__row">
          {entry.reproducibility != null ? <span className="rd__stat">reproducibility <b>{entry.reproducibility}</b>/100</span> : null}
          {entry.verdict ? <span className="rd__stat">{entry.verdict}</span> : null}
          {entry.verify ? <span className="rd__stat">self-check {entry.verify.passed}/{entry.verify.total}</span> : null}
        </div>
      </div>
      <div className="studio__changes">
        <div className="rev__label">implementations</div>
        <div className="rd__row">{entry.impls.map((im) => <span key={im.n} className={`rd__chip${im.pass === false ? ' rd__chip--verify' : ''}`}>impl {im.n} {im.pass == null ? '' : im.pass ? '✓' : '✗'}</span>)}</div>
      </div>
    </div>
  );
}

export function SceneStudio({ id, fallbackScene }: SceneStudioProps) {
  const [frames, setFrames] = useState<TimelineEntry[] | null>(null);
  const [frame, setFrame] = useState(0);
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [partOpen, setPartOpen] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    fetch(`/api/revisions?scene=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ entries: TimelineEntry[] }>) : Promise.reject(r)))
      .then((d) => { if (!cancelled) { setFrames(d.entries); setFrame(Math.max(0, d.entries.length - 1)); } })
      .catch(() => { if (!cancelled) setFrames([]); });
    return () => { cancelled = true; };
  }, [id]);

  const n = frames?.length ?? 0;
  // Keyboard scrubbing (← → home end), like a media player.
  useEffect(() => {
    if (n === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setFrame((f) => Math.max(0, f - 1));
      else if (e.key === 'ArrowRight') setFrame((f) => Math.min(n - 1, f + 1));
      else if (e.key === 'Home') setFrame(0);
      else if (e.key === 'End') setFrame(n - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [n]);

  const onPartSelect = (p: Part) => { setSelectedPart(p); setPartOpen(true); };

  // No history (bundled samples, freshly-analyzed live scenes) → just the 3D.
  if (frames !== null && frames.length === 0) {
    return (
      <div className="studio__single">
        <SceneViewer url={null} fallback={fallbackScene} selectedPartId={selectedPart?.id} onPartSelect={onPartSelect} />
        <PartInfo part={selectedPart} open={partOpen && !!selectedPart} onClose={() => setPartOpen(false)} />
        <p className="studio__nohist">No revision history yet — generate or <code>visually refine</code> this scene to scrub its evolution.</p>
      </div>
    );
  }
  if (frames === null) return <div className="studio__loading"><span className="gallery__spinner" aria-hidden /></div>;

  const cur = Math.min(frame, n - 1);
  const entry = frames[cur];
  const rev = latestRevision(frames, cur);
  const renderRef = latestRender(frames, cur);
  const verif = latestVerification(frames, cur);
  const impl = verif?.impls.find((i) => i.pass === true) ?? verif?.impls[0] ?? null;

  const sceneUrl = rev ? fileUrl(id, rev.scene) : null;
  const renderUrl = renderRef ? fileUrl(id, renderRef) : null;
  const implUrl = verif && impl ? fileUrl(id, { runId: verif.runId, file: impl.codeFile }) : null;
  const detailUrl = entry.kind === 'revision' ? `/api/revisions?scene=${encodeURIComponent(id)}&rev=${encodeURIComponent(entry.key)}` : null;

  const set = (f: number) => setFrame(Math.max(0, Math.min(n - 1, f)));

  return (
    <div className="studio">
      <div className="studio__panes">
        <section className="studio__pane">
          <div className="studio__pane-head">3D model{rev ? <span className="studio__at">v{rev.version}</span> : null}</div>
          <div className="studio__viewer"><SceneViewer url={sceneUrl} fallback={fallbackScene} selectedPartId={selectedPart?.id} onPartSelect={onPartSelect} /></div>
        </section>
        <section className="studio__pane">
          <div className="studio__pane-head">screenshot{rev ? <span className="studio__at">v{rev.version}</span> : null}</div>
          <div className="studio__shot">{renderUrl ? <img src={renderUrl} alt="render" /> : <span className="impl-panel__hint">no render at this version</span>}</div>
        </section>
        <section className="studio__pane">
          <div className="studio__pane-head">implementation{verif ? <span className={`rd__verdict rd__verdict--${impl?.pass ? 'pass' : 'fail'}`}>{impl?.pass == null ? '' : impl.pass ? 'PASS ✓' : 'FAIL'}</span> : null}</div>
          <div className="studio__impl">{implUrl ? <FileText key={implUrl} url={implUrl} /> : <span className="impl-panel__hint">not implemented yet at this point — run <code>visually reproduce</code>.</span>}</div>
        </section>
      </div>

      <div className="studio__readout">
        {detailUrl ? <RevisionReadout key={detailUrl} url={detailUrl} /> : entry.kind === 'verification' ? <VerificationReadout entry={entry} /> : null}
      </div>

      <div className="studio__transport">
        <div className="studio__controls">
          <button className="studio__btn" onClick={() => set(0)} aria-label="first" disabled={cur === 0}>⏮</button>
          <button className="studio__btn" onClick={() => set(cur - 1)} aria-label="back" disabled={cur === 0}>◀</button>
          <input className="studio__slider" type="range" min={0} max={n - 1} step={1} value={cur} onChange={(e) => set(Number(e.target.value))} aria-label="timeline" />
          <button className="studio__btn" onClick={() => set(cur + 1)} aria-label="forward" disabled={cur === n - 1}>▶</button>
          <button className="studio__btn" onClick={() => set(n - 1)} aria-label="latest" disabled={cur === n - 1}>⏭</button>
        </div>
        <div className="studio__ticks">
          {frames.map((e, i) => (
            <button
              key={e.key}
              className={`studio__tick studio__tick--${e.kind}${i === cur ? ' studio__tick--active' : ''}`}
              onClick={() => set(i)}
              title={`${e.kind === 'revision' ? `v${e.version} · ${e.source}` : 'verification'} · ${e.startedAt.replace('T', ' ')}`}
            >
              {e.kind === 'revision' ? `v${e.version}` : '⚙'}
            </button>
          ))}
        </div>
        <div className="studio__frameinfo">
          {entry.kind === 'revision' ? <><span className="studio__v">v{entry.version}</span> {entry.score != null ? <span className="tl__score">{entry.score}</span> : null} {entry.delta != null && entry.delta !== 0 ? <span className={`rd__delta rd__delta--${entry.delta > 0 ? 'up' : 'down'}`}>{entry.delta > 0 ? `+${entry.delta}` : entry.delta}</span> : null} <span className="history__when">{entry.startedAt.replace('T', ' ')}</span></>
            : <><span className="studio__v">⚙ verification</span> <span className="history__when">{entry.startedAt.replace('T', ' ')}</span></>}
        </div>
      </div>

      <PartInfo part={selectedPart} open={partOpen && !!selectedPart} onClose={() => setPartOpen(false)} />
    </div>
  );
}
