import { useEffect, useRef, useState } from 'react';
import type { RunDetail, RunSummary } from '../types';

type HistoryPanelProps = {
  id: string;
  open: boolean;
  onClose: () => void;
};

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; runs: RunSummary[] };

// A thing the viewer can show: an artifact file rendered as image or text.
type Sel = { file: string; label: string; image: boolean };

const TYPE_GLYPH: Record<string, string> = { create: '✦', improve: '↻', reproduce: '⚙', unknown: '·' };

function fileUrl(id: string, runId: string, file: string): string {
  return `/api/runs/${encodeURIComponent(id)}/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(file)}`;
}

// ── shared viewer: image inline, JSON pretty-printed, everything else mono ────
function ArtifactView({ id, runId, sel }: { id: string; runId: string; sel: Sel | null }) {
  // Keyed by file so we render the loaded text only when it matches the current
  // selection — no synchronous reset-in-effect when `sel` changes.
  const [loaded, setLoaded] = useState<{ file: string; text: string } | null>(null);

  useEffect(() => {
    if (!sel || sel.image) return;
    let cancelled = false;
    fetch(fileUrl(id, runId, sel.file))
      .then((res) => res.text())
      .then((raw) => {
        if (cancelled) return;
        let body = raw;
        if (sel.file.endsWith('.json')) {
          try { body = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* leave raw */ }
        }
        setLoaded({ file: sel.file, text: body });
      })
      .catch(() => { if (!cancelled) setLoaded({ file: sel.file, text: '(failed to load)' }); });
    return () => { cancelled = true; };
  }, [id, runId, sel]);

  const text = sel && loaded && loaded.file === sel.file ? loaded.text : null;

  if (!sel) return <div className="rd__view rd__view--empty">select an artifact to inspect</div>;
  return (
    <div className="rd__view">
      <div className="rd__view-head">{sel.label} <code>{sel.file}</code></div>
      {sel.image
        ? <img className="rd__view-img" src={fileUrl(id, runId, sel.file)} alt={sel.label} />
        : <pre className="rd__view-pre">{text ?? 'loading…'}</pre>}
    </div>
  );
}

function Chip({ active, kind, onClick, children }: { active: boolean; kind?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`rd__chip${kind ? ` rd__chip--${kind}` : ''}${active ? ' rd__chip--active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

// ── improve: per-iteration timeline (render thumb + score delta + critique) ───
function ImproveBody({ id, runId, detail, sel, select }: { id: string; runId: string; detail: RunDetail; sel: Sel | null; select: (s: Sel) => void }) {
  if (!detail.iters.length) return <p className="impl-panel__hint">no iterations recorded.</p>;
  return (
    <div className="rd__iters">
      {detail.iters.map((it, idx) => {
        const prev = detail.iters[idx - 1]?.score;
        const delta = it.score != null && prev != null ? it.score - prev : null;
        return (
          <div key={it.n} className="rd__iter">
            <div className="rd__iter-head">
              <span className="rd__iter-n">iter {it.n}</span>
              {it.score != null ? <span className="rd__iter-score">{it.score}</span> : null}
              {delta != null && delta !== 0 ? (
                <span className={`rd__delta rd__delta--${delta > 0 ? 'up' : 'down'}`}>{delta > 0 ? `▲ +${delta}` : `▼ ${delta}`}</span>
              ) : null}
            </div>
            {it.render ? (
              <button
                className={`rd__thumb${sel?.file === it.render ? ' rd__thumb--active' : ''}`}
                onClick={() => select({ file: it.render!, label: `iter ${it.n} render`, image: true })}
              >
                <img src={fileUrl(id, runId, it.render)} alt={`iter ${it.n} render`} loading="lazy" />
              </button>
            ) : null}
            {it.critique ? <p className="rd__critique">{it.critique}</p> : null}
            <div className="rd__row">
              {it.scene ? <Chip kind="scene" active={sel?.file === it.scene} onClick={() => select({ file: it.scene!, label: `iter ${it.n} scene`, image: false })}>scene</Chip> : null}
              {it.log ? <Chip kind="log" active={sel?.file === it.log} onClick={() => select({ file: it.log!, label: `iter ${it.n} LLM log`, image: false })}>LLM log</Chip> : null}
              {it.review ? <Chip kind="review" active={sel?.file === it.review} onClick={() => select({ file: it.review!, label: `iter ${it.n} review`, image: false })}>review</Chip> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── reproduce: report summary + one card per independent implementation ───────
function ReproduceBody({ detail, sel, select }: { detail: RunDetail; sel: Sel | null; select: (s: Sel) => void }) {
  const h = detail.highlights;
  return (
    <div className="rd__repro">
      <div className="rd__summary">
        {h.reproducibility != null ? <span className="rd__stat">reproducibility <b>{h.reproducibility}</b>/100</span> : null}
        {h.verdict ? <span className="rd__stat">{h.verdict}</span> : null}
        {h.verify ? <span className="rd__stat">self-check {h.verify.passed}/{h.verify.total}</span> : null}
        <span className="rd__row">
          {detail.artifacts.some((a) => a.file === 'spec.json') ? <Chip active={sel?.file === 'spec.json'} onClick={() => select({ file: 'spec.json', label: 'spec', image: false })}>spec</Chip> : null}
          {detail.artifacts.some((a) => a.file === 'report.json') ? <Chip kind="report" active={sel?.file === 'report.json'} onClick={() => select({ file: 'report.json', label: 'full report', image: false })}>report</Chip> : null}
        </span>
      </div>
      {(h.impls ?? []).map((im) => (
        <div key={im.n} className="rd__impl">
          <div className="rd__impl-head">
            <span className="rd__iter-n">impl {im.n}</span>
            <span className="rd__lang">{im.lang}</span>
            {im.pass != null ? <span className={`rd__verdict rd__verdict--${im.pass ? 'pass' : 'fail'}`}>{im.pass ? 'PASS ✓' : 'FAIL'}</span> : null}
          </div>
          <div className="rd__row">
            <Chip kind="impl" active={sel?.file === im.codeFile} onClick={() => select({ file: im.codeFile, label: `impl ${im.n} code`, image: false })}>code</Chip>
            {im.verifyFile ? <Chip kind="verify" active={sel?.file === im.verifyFile} onClick={() => select({ file: im.verifyFile!, label: `impl ${im.n} verify`, image: false })}>verify</Chip> : null}
            {im.logFile ? <Chip kind="log" active={sel?.file === im.logFile} onClick={() => select({ file: im.logFile!, label: `impl ${im.n} reasoning`, image: false })}>reasoning</Chip> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── create: prompt → reasoning → scene, with the meta summary ─────────────────
function CreateBody({ detail, sel, select }: { detail: RunDetail; sel: Sel | null; select: (s: Sel) => void }) {
  const h = detail.highlights;
  const steps: { file: string; label: string; kind: string }[] = [];
  const has = (f: string) => detail.artifacts.some((a) => a.file === f);
  if (has('prompt.txt')) steps.push({ file: 'prompt.txt', label: 'prompt', kind: 'prompt' });
  if (has('raw.txt')) steps.push({ file: 'raw.txt', label: 'reasoning', kind: 'log' });
  else if (has('reasoning.log')) steps.push({ file: 'reasoning.log', label: 'reasoning', kind: 'log' });
  if (has('scene.json')) steps.push({ file: 'scene.json', label: 'scene', kind: 'scene' });
  else if (has('scene.invalid.json')) steps.push({ file: 'scene.invalid.json', label: 'scene (invalid)', kind: 'scene' });
  if (has('meta.json')) steps.push({ file: 'meta.json', label: 'meta', kind: 'report' });
  return (
    <div className="rd__create">
      <div className="rd__summary">
        {h.mode ? <span className="rd__stat">{h.mode}</span> : null}
        {h.parts != null ? <span className="rd__stat">{h.parts} parts</span> : null}
        {h.valid != null ? <span className={`rd__verdict rd__verdict--${h.valid ? 'pass' : 'fail'}`}>{h.valid ? 'valid ✓' : 'invalid'}</span> : null}
      </div>
      <div className="rd__row">
        {steps.map((s) => (
          <Chip key={s.file} kind={s.kind} active={sel?.file === s.file} onClick={() => select({ file: s.file, label: s.label, image: false })}>{s.label}</Chip>
        ))}
      </div>
    </div>
  );
}

function defaultSel(detail: RunDetail): Sel | null {
  if (detail.type === 'improve') {
    const last = [...detail.iters].reverse().find((it) => it.render);
    if (last?.render) return { file: last.render, label: `iter ${last.n} render`, image: true };
  }
  if (detail.type === 'reproduce') {
    if (detail.artifacts.some((a) => a.file === 'report.json')) return { file: 'report.json', label: 'full report', image: false };
  }
  if (detail.type === 'create') {
    const scene = detail.artifacts.find((a) => a.file === 'scene.json' || a.file === 'scene.invalid.json');
    if (scene) return { file: scene.file, label: 'scene', image: false };
  }
  const first = detail.artifacts[0];
  return first ? { file: first.file, label: first.label, image: first.kind === 'screenshot' } : null;
}

function RunDetailView({ id, runId }: { id: string; runId: string }) {
  const [detail, setDetail] = useState<RunDetail | 'loading' | 'error'>('loading');
  const [sel, setSel] = useState<Sel | null>(null);

  // This component is remounted per run (key={runId}), so id/runId are stable
  // for its lifetime and the initial 'loading' state needs no synchronous reset.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${encodeURIComponent(id)}/${encodeURIComponent(runId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<RunDetail>) : Promise.reject(res)))
      .then((d) => { if (!cancelled) { setDetail(d); setSel(defaultSel(d)); } })
      .catch(() => { if (!cancelled) setDetail('error'); });
    return () => { cancelled = true; };
  }, [id, runId]);

  if (detail === 'loading') return <p className="impl-panel__hint">loading…</p>;
  if (detail === 'error') return <p className="impl-panel__hint">couldn’t load this run.</p>;

  return (
    <div className="rd">
      {detail.type === 'improve' ? <ImproveBody id={id} runId={runId} detail={detail} sel={sel} select={setSel} />
        : detail.type === 'reproduce' ? <ReproduceBody detail={detail} sel={sel} select={setSel} />
          : detail.type === 'create' ? <CreateBody detail={detail} sel={sel} select={setSel} />
            : <div className="rd__row">{detail.artifacts.map((a) => (
              <Chip key={a.file} active={sel?.file === a.file} onClick={() => setSel({ file: a.file, label: a.label, image: a.kind === 'screenshot' })}>{a.label}</Chip>
            ))}</div>}
      <ArtifactView id={id} runId={runId} sel={sel} />
    </div>
  );
}

export function HistoryPanel({ id, open, onClose }: HistoryPanelProps) {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [openRun, setOpenRun] = useState<string | null>(null);
  const fetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open || fetchedFor.current === id) return;
    fetchedFor.current = id;
    let cancelled = false;
    setList({ status: 'loading' });
    fetch(`/api/runs?scene=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ runs: RunSummary[] }>) : Promise.reject(res)))
      .then((data) => { if (!cancelled) setList({ status: 'ready', runs: data.runs }); })
      .catch((err: unknown) => { if (!cancelled) setList({ status: 'error', message: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [open, id]);

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
            const expanded = openRun === run.runId;
            return (
              <div key={run.runId} className={`history__run${expanded ? ' history__run--open' : ''}`}>
                <button className="history__row" onClick={() => setOpenRun(expanded ? null : run.runId)} aria-expanded={expanded}>
                  <span className="history__glyph" aria-hidden>{TYPE_GLYPH[run.type] ?? '·'}</span>
                  <span className="history__type">{run.type}</span>
                  <span className="history__when">{run.startedAt.replace('T', ' ')}</span>
                  <span className="history__meta">
                    {run.score != null ? <span className="history__score">{run.score}</span> : null}
                    {run.iterations ? <span className="history__iters">{run.iterations}×</span> : null}
                    <span className={`history__status history__status--${run.status}`}>{run.status}</span>
                  </span>
                </button>
                {expanded ? <RunDetailView key={run.runId} id={id} runId={run.runId} /> : null}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
