import { useMemo } from 'react';
import { SceneCard } from '../components/SceneCard';
import type { SampleCategory, SampleEntry } from '../types';

type GalleryPageProps = {
  samples: SampleEntry[];
  categories: SampleCategory[];
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

export function GalleryPage({ samples, categories }: GalleryPageProps) {
  const sections = useMemo(() => buildSections(samples, categories), [samples, categories]);

  return (
    <div className="showcase">
      <header className="showcase__hero">
        <h1>VISUALLY</h1>
        <p>Browse by category, or open a build to inspect its 3D model and implementation.</p>
      </header>

      {samples.length === 0 ? (
        <p className="gallery__empty">No scenes yet — run <code>visually create</code> to generate one.</p>
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
