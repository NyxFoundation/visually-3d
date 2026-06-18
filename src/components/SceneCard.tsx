import React, { useEffect, useRef, useState } from 'react';
import { LazyViewer } from './LazyViewer';
import { hrefForDetail } from '../router';
import type { SampleEntry, SceneDescriptor } from '../types';

type CardState = 'idle' | 'visible' | 'loaded' | 'error';

// Browsers cap concurrent WebGL contexts (mobile Safari ≈ 8, Chrome ≈ 16). One
// live <Canvas> per thumbnail blows past that as you scroll, and the browser
// evicts the oldest context — usually the main viewer — leaving it (or the new
// thumbnails) blank-white. Unmounting off-screen cards alone is not enough on
// mobile: context teardown lags behind a fast scroll. So we also hard-cap how
// many thumbnail canvases may be live at once with a tiny global pool. Cards
// that can't get a slot show a static poster instead of forcing a new context.
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

// A gallery card: lazy-loads its scene when scrolled into view, mounts a live
// thumbnail <Canvas> only if a global WebGL slot is free, and links to the
// per-id detail page via the hash router.
export const SceneCard: React.FC<{ sample: SampleEntry; active?: boolean }> = ({ sample, active }) => {
  const ref = useRef<HTMLAnchorElement>(null);
  const [state, setState] = useState<CardState>('idle');
  const [inView, setInView] = useState(false);
  const [scene, setScene] = useState<SceneDescriptor | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setInView(entry.isIntersecting);
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
        return res.json() as Promise<SceneDescriptor>;
      })
      .then((data) => {
        if (cancelled) return;
        setScene(data);
        setState('loaded');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => { cancelled = true; };
  }, [inView, state, sample.path]);

  const hasSlot = useThumbnailSlot(state === 'loaded' && !!scene && inView);

  return (
    <a
      ref={ref}
      className={`gallery__card${active ? ' gallery__card--active' : ''}`}
      style={{ ['--accent' as string]: sample.accent }}
      href={hrefForDetail(sample.id)}
      aria-label={`Open ${sample.title}`}
    >
      <div className="gallery__thumb">
        {state === 'error' ? (
          <div className="gallery__thumb-fallback">failed to load</div>
        ) : hasSlot && scene ? (
          <LazyViewer scene={scene} compact maxDpr={1.25} />
        ) : state === 'loaded' ? (
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
    </a>
  );
};
