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

// Browsers cap concurrent WebGL contexts (mobile Safari ≈ 8, Chrome ≈ 16). One
// live <Canvas> per thumbnail blows past that as you scroll, and the browser
// evicts the oldest context — usually the main viewer — leaving it (or the new
// thumbnails) blank-white. Unmounting off-screen cards alone is not enough on
// mobile: context teardown lags behind a fast scroll. So we also hard-cap how
// many thumbnail canvases may be live at once with a tiny global pool. Cards
// that can't get a slot show a static poster instead of forcing a new context.
// Lower on phones — both to stay under the smaller context cap and to spare the
// GPU from too many simultaneous auto-rotating canvases.
const MAX_THUMBNAIL_CANVASES =
  typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? 3 : 6;
let liveThumbnails = 0;
const slotWaiters = new Set<() => void>();

function acquireThumbnailSlot(): boolean {
  if (liveThumbnails >= MAX_THUMBNAIL_CANVASES) return false;
  liveThumbnails += 1;
  return true;
}
function releaseThumbnailSlot(): void {
  liveThumbnails = Math.max(0, liveThumbnails - 1);
  const next = slotWaiters.values().next().value as (() => void) | undefined;
  if (next) {
    slotWaiters.delete(next);
    next();
  }
}

// Grant a thumbnail WebGL slot while `want` is true, capped globally. Returns
// whether this card currently holds a slot; releases it on unmount / when the
// card scrolls away.
function useThumbnailSlot(want: boolean): boolean {
  const [granted, setGranted] = useState(false);
  const heldRef = useRef(false);
  useEffect(() => {
    if (!want) return undefined;
    const grab = () => {
      if (acquireThumbnailSlot()) {
        heldRef.current = true;
        setGranted(true);
        return true;
      }
      return false;
    };
    const waiter = () => { grab(); };
    if (!grab()) slotWaiters.add(waiter);
    return () => {
      slotWaiters.delete(waiter);
      if (heldRef.current) {
        heldRef.current = false;
        setGranted(false);
        releaseThumbnailSlot();
      }
    };
  }, [want]);
  return granted && want;
}

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

  // Only mount a thumbnail <Canvas> if a global WebGL slot is free (see pool
  // above) — otherwise the gallery exhausts the browser's context cap and the
  // main viewer whites out.
  const hasSlot = useThumbnailSlot(state === 'loaded' && !!scene && inView);

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
        {state === 'error' ? (
          <div className="gallery__thumb-fallback">failed to load</div>
        ) : hasSlot && scene ? (
          <LazyViewer scene={scene} compact maxDpr={1.25} />
        ) : state === 'loaded' ? (
          // Loaded, but waiting for a free WebGL slot — show a static accent
          // poster rather than a blank/white canvas.
          <div className="gallery__thumb-poster" aria-hidden />
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
