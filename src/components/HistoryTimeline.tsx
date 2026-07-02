import { useEffect, useMemo, useState } from 'react';

// The self-improvement history of a published scene, read from the static
// gallery (`/samples/runs/<id>/manifest.json`, written by `visually upload`).
// Renders nothing when a scene ships no history, so every other detail page
// is unaffected. Improve runs show their iteration renders + review verdicts;
// verify runs show the formal-verification outcome with the run log.

type HistoryRun = { dir: string; kind: string; at: string; files: string[] };
type HistoryManifest = { id: string; runs: HistoryRun[] };

type Review = {
  total?: number | null;
  verdict?: string | null;
  critique?: string | null;
  changelog?: string[];
  remaining_gaps?: string[];
};

type Iteration = { n: string; render: string | null; review: Review | null };

const RENDER_RE = /^iter-(\d+)-render\.png$/;
const VERIFY_TXT_RE = /^verify-(\d+)\.txt$/;

function runBase(id: string, dir: string) {
  return `/samples/runs/${encodeURIComponent(id)}/${encodeURIComponent(dir)}`;
}

function fmtDate(at: string) {
  return at ? at.slice(0, 10) : '';
}

// ---- improve run: iteration render + review cards --------------------------

function ImproveRun({ id, run }: { id: string; run: HistoryRun }) {
  const [reviews, setReviews] = useState<Record<string, Review>>({});

  const iterations = useMemo<Iteration[]>(() => {
    const ns = new Set<string>();
    for (const f of run.files) {
      const m = RENDER_RE.exec(f);
      if (m) ns.add(m[1]);
    }
    return [...ns].sort().map((n) => ({
      n,
      render: run.files.includes(`iter-${n}-render.png`) ? `${runBase(id, run.dir)}/iter-${n}-render.png` : null,
      review: reviews[n] ?? null,
    }));
  }, [id, run, reviews]);

  useEffect(() => {
    let cancelled = false;
    const wanted = run.files.filter((f) => /^iter-\d+-review\.json$/.test(f));
    void Promise.all(wanted.map(async (f) => {
      try {
        const res = await fetch(`${runBase(id, run.dir)}/${f}`);
        if (!res.ok) return null;
        const data = (await res.json()) as Review;
        return { n: /^iter-(\d+)-/.exec(f)?.[1] ?? '', data };
      } catch { return null; }
    })).then((loaded) => {
      if (cancelled) return;
      const next: Record<string, Review> = {};
      for (const r of loaded) if (r && r.n) next[r.n] = r.data;
      setReviews(next);
    });
    return () => { cancelled = true; };
  }, [id, run]);

  if (iterations.length === 0) return null;
  return (
    <div className="htl__strip">
      {iterations.map((it) => (
        <figure className="htl__card" key={it.n}>
          {it.render ? <img className="htl__render" src={it.render} alt={`iteration ${it.n} render`} loading="lazy" /> : null}
          <figcaption className="htl__cardbody">
            <div className="htl__cardhead">
              <span className="htl__iter">iter {Number(it.n)}</span>
              {typeof it.review?.total === 'number' ? <span className="htl__score">{it.review.total}/100</span> : null}
              {it.review?.verdict ? <span className="htl__verdict">{it.review.verdict}</span> : null}
            </div>
            {it.review?.critique ? <p className="htl__critique">{it.review.critique}</p> : null}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

// ---- verify run: formal-verification outcome --------------------------------

function VerifyRun({ id, run }: { id: string; run: HistoryRun }) {
  const [log, setLog] = useState<string | null>(null);
  const txt = run.files.find((f) => VERIFY_TXT_RE.test(f)) ?? run.files.find((f) => f === 'verify.txt');

  useEffect(() => {
    if (!txt) return;
    let cancelled = false;
    fetch(`${runBase(id, run.dir)}/${txt}`)
      .then((res) => (res.ok ? res.text() : Promise.reject(res)))
      .then((body) => { if (!cancelled) setLog(body); })
      .catch(() => { if (!cancelled) setLog(null); });
    return () => { cancelled = true; };
  }, [id, run, txt]);

  const pass = log ? /pass=true|VERIFIED/.test(log) : null;
  const checks = log ? (log.match(/^ok {2}/gm) ?? []).length : 0;
  const check = run.files.find((f) => /^check-\d+\./.test(f));
  return (
    <div className="htl__verify">
      {pass === null ? null : (
        <span className={`htl__badge ${pass ? 'htl__badge--pass' : 'htl__badge--fail'}`}>
          {pass ? 'VERIFIED' : 'FAILED'}
        </span>
      )}
      {checks > 0 ? <span className="htl__checks">{checks} checks</span> : null}
      {check ? (
        <a className="htl__src" href={`${runBase(id, run.dir)}/${check}`} target="_blank" rel="noreferrer">
          self-check source
        </a>
      ) : null}
      {log ? (
        <details className="htl__log">
          <summary>run log</summary>
          <pre>{log}</pre>
        </details>
      ) : null}
    </div>
  );
}

// ---- the timeline ------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  create: 'created',
  improve: 'visual self-improve',
  verify: 'formal verification',
  amend: 'spec amend',
  reproduce: 'reproduce',
  evidence: 'evidence fetch',
};

export function HistoryTimeline({ id }: { id: string }) {
  const [manifest, setManifest] = useState<HistoryManifest | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/samples/runs/${encodeURIComponent(id)}/manifest.json`)
      .then((res) => (res.ok ? (res.json() as Promise<HistoryManifest>) : Promise.reject(res)))
      .then((data) => { if (!cancelled && Array.isArray(data.runs) && data.runs.length > 0) setManifest(data); })
      .catch(() => { /* no published history — render nothing */ });
    return () => { cancelled = true; };
  }, [id]);

  if (!manifest) return null;
  return (
    <section className="htl" aria-label="Self-improvement history">
      <header className="htl__head">
        <h2 className="htl__title">Self-improvement history</h2>
        <p className="htl__sub">
          every step of the visualize → verify → refine loop that produced this scene, oldest first
        </p>
      </header>
      <ol className="htl__list">
        {manifest.runs.map((run) => (
          <li className={`htl__run htl__run--${run.kind}`} key={run.dir}>
            <div className="htl__meta">
              <span className="htl__kind">{KIND_LABEL[run.kind] ?? run.kind}</span>
              <span className="htl__date">{fmtDate(run.at)}</span>
            </div>
            {run.kind === 'improve' ? <ImproveRun id={id} run={run} /> : null}
            {run.kind === 'verify' ? <VerifyRun id={id} run={run} /> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
