import React, { useEffect, useRef, useState } from 'react';
import { LazyViewer } from './LazyViewer';
import type { SceneDescriptor } from '../types';

export type SampleEntry = {
  id: string;
  title: string;
  subtitle: string;
  path: string;
  accent: string;
};

type SampleGalleryProps = {
  samples: SampleEntry[];
  activeId?: string;
  onSelect: (sample: SampleEntry, scene: SceneDescriptor) => void;
};

type CardState = 'idle' | 'visible' | 'loaded' | 'error';

export const SampleGallery: React.FC<SampleGalleryProps> = ({ samples, activeId, onSelect }) => (
  <section className="gallery" aria-label="Sample machine visuals">
    <div className="gallery__header">
      <div>
        <h2>Sample Machines</h2>
        <p>Tap a card to load the scene.</p>
      </div>
    </div>
    <div className="gallery__grid">
      {samples.map((sample) => (
        <SampleCard key={sample.id} sample={sample} active={sample.id === activeId} onSelect={onSelect} />
      ))}
    </div>
  </section>
);

const SampleCard: React.FC<{
  sample: SampleEntry;
  active: boolean;
  onSelect: (sample: SampleEntry, scene: SceneDescriptor) => void;
}> = ({ sample, active, onSelect }) => {
  const ref = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<CardState>('idle');
  const [scene, setScene] = useState<SceneDescriptor | null>(null);

  useEffect(() => {
    if (!ref.current || state !== 'idle') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setState('visible');
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [state]);

  useEffect(() => {
    if (state !== 'visible') return;
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
  }, [state, sample.path]);

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
        {state === 'loaded' && scene ? (
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
