import { useMemo, useState } from 'react';
import { SceneCard } from '../components/SceneCard';
import type { SampleCategory, SampleEntry } from '../types';

// Live-analyze controller surfaced from the app shell. `run` is fire-and-forget
// (the app streams the result and navigates to the detail page on completion).
export type AnalyzeController = {
  available: boolean;
  isLoading: boolean;
  error: string | null;
  logText: string;
  run: (value: string) => void;
};

type GalleryPageProps = {
  samples: SampleEntry[];
  categories: SampleCategory[];
  analyze: AnalyzeController;
};

type Section = { id: string; label: string; items: SampleEntry[] };

// Group samples into per-category showcase sections, in the order categories
// are declared in index.json. Anything with an unknown/absent category falls
// into a trailing "Other" section so nothing is silently dropped.
function buildSections(samples: SampleEntry[], categories: SampleCategory[]): Section[] {
  const labelOf = new Map(categories.filter((c) => c.id !== 'all').map((c) => [c.id, c.label]));
  const order = [...labelOf.keys()];

  const byCat = new Map<string, SampleEntry[]>();
  for (const s of samples) {
    const key = s.category && labelOf.has(s.category) ? s.category : '__other__';
    const bucket = byCat.get(key);
    if (bucket) bucket.push(s);
    else byCat.set(key, [s]);
  }

  const sections: Section[] = [];
  for (const id of order) {
    const items = byCat.get(id);
    if (items && items.length) sections.push({ id, label: labelOf.get(id) ?? id, items });
  }
  const other = byCat.get('__other__');
  if (other && other.length) sections.push({ id: '__other__', label: 'Other', items: other });
  return sections;
}

export function GalleryPage({ samples, categories, analyze }: GalleryPageProps) {
  const [input, setInput] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const sections = useMemo(() => buildSections(samples, categories), [samples, categories]);

  return (
    <div className="showcase">
      <header className="showcase__hero">
        <span className="hero__eyebrow">Visually</span>
        <h1>3D machinery showcase</h1>
        <p>Browse by category, or open a build to inspect its 3D model and implementation.</p>
      </header>

      {analyze.available ? (
        <section className="showcase__analyze">
          <div className="analyze-bar">
            <input
              className="analyze-bar__input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') analyze.run(input); }}
              placeholder="Generate a new build — machine name or URL…"
              aria-label="Machine name or URL"
            />
            <button
              className="analyze-bar__button"
              onClick={() => analyze.run(input)}
              disabled={analyze.isLoading || !input.trim()}
            >
              {analyze.isLoading ? 'Analyzing…' : 'Analyze'}
            </button>
          </div>
          <button
            className={`log-toggle${showLogs ? ' log-toggle--open' : ''}`}
            onClick={() => setShowLogs((prev) => !prev)}
            aria-expanded={showLogs}
          >
            {showLogs ? 'hide logs' : 'show logs'}
          </button>
          {showLogs ? (
            <section className="log-console">
              <header>
                <strong>Claude CLI stream</strong>
                <span>{analyze.isLoading ? 'running' : 'idle'}</span>
              </header>
              <pre>{analyze.logText}</pre>
            </section>
          ) : null}
          {analyze.error ? <div className="error-toast">{analyze.error}</div> : null}
        </section>
      ) : null}

      {samples.length === 0 ? (
        <p className="gallery__empty">No scenes yet — generate one above, or run <code>visually create</code>.</p>
      ) : (
        sections.map((section) => (
          <section key={section.id} className="showcase__section" aria-label={section.label}>
            <h2 className="showcase__title">{section.label}<span>{section.items.length}</span></h2>
            <div className="gallery__grid">
              {section.items.map((sample) => (
                <SceneCard key={sample.id} sample={sample} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
