import { useEffect, useMemo, useState } from 'react';
import { LazyViewer } from '../components/LazyViewer';
import { PartInfo } from '../components/PartInfo';
import { InfoPanel } from '../components/InfoPanel';
import { ImplPanel } from '../components/ImplPanel';
import { GALLERY_HREF, LIVE_ID } from '../router';
import type { Part, SampleEntry, SceneDescriptor } from '../types';

type DetailPageProps = {
  id: string;
  samples: SampleEntry[];
  liveScene: SceneDescriptor | null;
  samplesLoaded: boolean;
  backendOnline: boolean;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; scene: SceneDescriptor }
  | { status: 'missing' };

export function DetailPage({ id, samples, liveScene, samplesLoaded, backendOnline }: DetailPageProps) {
  const sample = useMemo(() => samples.find((s) => s.id === id), [samples, id]);
  const [fetched, setFetched] = useState<SceneDescriptor | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);

  // The app shell remounts this component per id (key={id}), so transient state
  // starts fresh on navigation — no manual reset effect needed.
  useEffect(() => {
    if (id === LIVE_ID || !sample) return;
    let cancelled = false;
    fetch(sample.path)
      .then((res) => (res.ok ? (res.json() as Promise<SceneDescriptor>) : Promise.reject(res)))
      .then((data) => { if (!cancelled) setFetched(data); })
      .catch(() => { if (!cancelled) setFetchFailed(true); });
    return () => { cancelled = true; };
  }, [id, sample]);

  const load: LoadState = useMemo(() => {
    if (id === LIVE_ID) {
      return liveScene ? { status: 'ready', scene: liveScene } : { status: 'missing' };
    }
    if (fetched) return { status: 'ready', scene: fetched };
    if (fetchFailed || (samplesLoaded && !sample)) return { status: 'missing' };
    return { status: 'loading' };
  }, [id, liveScene, fetched, fetchFailed, samplesLoaded, sample]);

  if (load.status === 'missing') {
    return (
      <main className="app-shell">
        <div className="detail-empty">
          <p>That scene isn’t available.</p>
          <a className="detail-back" href={GALLERY_HREF}>← back to gallery</a>
        </div>
      </main>
    );
  }

  if (load.status === 'loading') {
    return (
      <main className="app-shell">
        <div className="detail-empty"><span className="gallery__spinner" aria-hidden /></div>
      </main>
    );
  }

  const scene = load.scene;
  const hasInfo = Boolean(scene.metadata?.info || scene.assembly_instructions || scene.metadata?.reference);

  return (
    <main className="app-shell">
      <div className="stage">
        <LazyViewer scene={scene} selectedPartId={selectedPart?.id} onPartSelect={(part) => { setSelectedPart(part); setPanelOpen(true); }} />

        <header className="hero" aria-label="Current machine">
          <div className="hero__group">
            <a className="menu-toggle" href={GALLERY_HREF} aria-label="Back to gallery">
              <span className="detail-back__arrow" aria-hidden>←</span>
            </a>
            <div className="hero__title">
              <span className="hero__eyebrow">Visually</span>
              <h1>{scene.machine_name}</h1>
            </div>
          </div>
          <div className="hero__badges">
            <button
              type="button"
              className={`badge badge--info${codeOpen ? ' badge--active' : ''}`}
              onClick={() => setCodeOpen((prev) => !prev)}
              aria-expanded={codeOpen}
              title="Show the implementation source and run its tests"
            >
              <span className="badge__icon" aria-hidden>{'</>'}</span>
              <span>code</span>
            </button>
            {hasInfo ? (
              <button
                type="button"
                className="badge badge--info"
                onClick={() => setInfoOpen((prev) => !prev)}
                aria-expanded={infoOpen}
                title="Show sources and basic info"
              >
                <span className="badge__icon" aria-hidden>i</span>
                <span>info</span>
              </button>
            ) : null}
            <span className="badge badge--count">{scene.parts.length} parts</span>
          </div>
        </header>

        <PartInfo part={selectedPart} open={panelOpen && !!selectedPart} onClose={() => setPanelOpen(false)} />
        <InfoPanel scene={scene} open={infoOpen} onClose={() => setInfoOpen(false)} />
        <ImplPanel id={id} backendOnline={backendOnline} open={codeOpen} onClose={() => setCodeOpen(false)} />
      </div>
    </main>
  );
}
