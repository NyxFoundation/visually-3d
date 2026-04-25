import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LazyViewer } from './LazyViewer';
import type { SceneDescriptor } from '../types';

export type SampleEntry = {
  id: string;
  title: string;
  subtitle: string;
  path: string;
  accent: string;
  category?: string;
};

export type SampleCategory = {
  id: string;
  label: string;
};

type SampleGalleryProps = {
  samples: SampleEntry[];
  categories?: SampleCategory[];
  activeId?: string;
  onSelect: (sample: SampleEntry, scene: SceneDescriptor) => void;
};

type CardState = 'idle' | 'visible' | 'loaded' | 'error';

// Browsers cap concurrent WebGL contexts (Safari ≈ 8, Chrome 16). With one main
// viewer plus a thumbnail per card, scrolling the gallery quickly exceeds that
// cap and the oldest context — the main viewer — gets evicted, whiting it out.
// So keep observing each card's visibility and unmount the thumbnail <Canvas>
// when the card scrolls back off-screen.

export const SampleGallery: React.FC<SampleGalleryProps> = ({ samples, categories, activeId, onSelect }) => {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return samples.filter((sample) => {
      if (activeCategory !== 'all' && sample.category !== activeCategory) return false;
      if (!q) return true;
      return sample.title.toLowerCase().includes(q) || sample.subtitle.toLowerCase().includes(q);
    });
  }, [samples, query, activeCategory]);

  const visibleCategories = useMemo(() => {
    if (categories && categories.length > 0) return categories;
    // Fall back to deriving categories from sample data if index.json doesn't ship them.
    const seen = new Set<string>();
    const derived: SampleCategory[] = [{ id: 'all', label: 'All' }];
    for (const s of samples) {
      if (s.category && !seen.has(s.category)) {
        seen.add(s.category);
        derived.push({ id: s.category, label: s.category });
      }
    }
    return derived;
  }, [categories, samples]);

  return (
    <section className="gallery" aria-label="Sample machine visuals">
      <div className="gallery__header">
        <div>
          <h2>Sample Machines</h2>
          <p>Tap a card to load the scene.</p>
        </div>
        <input
          type="search"
          className="gallery__search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name or description…"
          aria-label="Search samples"
        />
        <div className="gallery__chips" role="tablist" aria-label="Filter by category">
          {visibleCategories.map((cat) => {
            const active = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`gallery__chip${active ? ' gallery__chip--active' : ''}`}
                onClick={() => setActiveCategory(cat.id)}
              >
                {cat.label}
              </button>
            );
          })}
        </div>
      </div>
      {filtered.length === 0 ? (
        <p className="gallery__empty">No samples match the current filter.</p>
      ) : (
        <div className="gallery__grid">
          {filtered.map((sample) => (
            <SampleCard key={sample.id} sample={sample} active={sample.id === activeId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </section>
  );
};

const SampleCard: React.FC<{
  sample: SampleEntry;
  active: boolean;
  onSelect: (sample: SampleEntry, scene: SceneDescriptor) => void;
}> = ({ sample, active, onSelect }) => {
  const ref = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<CardState>('idle');
  const [inView, setInView] = useState(false);
  const [scene, setScene] = useState<SceneDescriptor | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setInView(entry.isIntersecting);
      },
      { rootMargin: '200px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || state !== 'idle') return;
    let cancelled = false;
    fetch(sample.path)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: SceneDescriptor) => {
        if (cancelled) return;
        setScene(data);
        setState('loaded');
      })
      .catch(() => {
        if (cancelled) return;
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [inView, state, sample.path]);

  const handleClick = () => {
    if (scene) onSelect(sample, scene);
  };

  return (
    <button
      ref={ref}
      type="button"
      className={`gallery__card${active ? ' gallery__card--active' : ''}`}
      style={{ ['--accent' as string]: sample.accent }}
      onClick={handleClick}
      disabled={!scene}
      aria-pressed={active}
    >
      <div className="gallery__thumb">
        {state === 'loaded' && scene && inView ? (
          <LazyViewer scene={scene} compact maxDpr={1.25} />
        ) : state === 'error' ? (
          <div className="gallery__thumb-fallback">failed to load</div>
        ) : (
          <div className="gallery__thumb-fallback">
            <span className="gallery__spinner" aria-hidden />
          </div>
        )}
      </div>
      <div className="gallery__meta">
        <h3>{sample.title}</h3>
        <p>{sample.subtitle}</p>
      </div>
    </button>
  );
};
