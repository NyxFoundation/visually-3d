import { useEffect, useState } from 'react';
import { Code } from './Code';
import { Icon } from './Icon';

// Browse the cloned reference SOURCE for a scene — the whole real repo the
// evidence gatherer brought in (evidence/<id>/source/). Renders nothing when
// there is no cloned source, so it only appears for scenes that have one.

type SrcFile = { path: string; size: number };

function langOf(p: string): string | undefined {
  if (/\.(v|sv|svh|vh)$/i.test(p)) return 'verilog';
  if (/\.py$/i.test(p)) return 'python';
  if (/\.json$/i.test(p)) return 'json';
  return undefined;
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

// One file's content. Keyed by path upstream so it remounts (and refetches)
// cleanly when the selection changes — no state reset in an effect.
function SourceFile({ id, path }: { id: string; path: string }) {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/source/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`)
      .then((r) => r.text())
      .then((t) => { if (!cancelled) setCode(t); })
      .catch(() => { if (!cancelled) setCode('(failed to load)'); });
    return () => { cancelled = true; };
  }, [id, path]);
  if (code == null) return <pre className="studio__code">loading…</pre>;
  return <Code code={code} lang={langOf(path)} />;
}

export function SourceBrowser({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const [files, setFiles] = useState<SrcFile[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/source/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ root: string | null; files: SrcFile[] }>) : Promise.reject(r)))
      .then((d) => {
        if (cancelled) return;
        setRoot(d.root);
        setFiles(d.files);
        if (d.files.length) setSel(d.files[0].path);
      })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [id]);

  if (files === null || files.length === 0) return null; // loading or no clone → hide

  const body = (
    <div className="srcb__body">
      <ul className="srcb__list">
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className={`srcb__file${f.path === sel ? ' srcb__file--active' : ''}`}
              onClick={() => setSel(f.path)}
              title={`${f.path} · ${fmtSize(f.size)}`}
            >
              {f.path}
            </button>
          </li>
        ))}
      </ul>
      <div className="srcb__code">
        {sel ? <SourceFile key={sel} id={id} path={sel} /> : null}
      </div>
    </div>
  );

  // Embedded inside the studio's implementation pane — the pane supplies its own
  // header, so render just the file list + viewer, filling the pane.
  if (embedded) return <div className="srcb srcb--embedded">{body}</div>;

  return (
    <section className="srcb">
      <div className="srcb__head">
        <Icon name="code" size={14} /> Reference source
        <span className="diff__muted"> · {root} · {files.length} file{files.length === 1 ? '' : 's'} (fetched ground truth)</span>
      </div>
      {body}
    </section>
  );
}
