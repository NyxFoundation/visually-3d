import { useEffect, useMemo, useState } from 'react';
import { InfoPanel } from '../components/InfoPanel';
import { SceneStudio } from '../components/SceneStudio';
import { GALLERY_HREF, LIVE_ID } from '../router';
import type { SampleEntry, SceneDescriptor } from '../types';

type DetailPageProps = {
  id: string;
  samples: SampleEntry[];
  liveScene: SceneDescriptor | null;
  samplesLoaded: boolean;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; scene: SceneDescriptor }
  | { status: 'missing' };

export function DetailPage({ id, samples, liveScene, samplesLoaded }: DetailPageProps) {
  const sample = useMemo(() => samples.find((s) => s.id === id), [samples, id]);
  const [fetched, setFetched] = useState<SceneDescriptor | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  // The app shell remounts this component per id (key={id}), so state starts
  // fresh on navigation — no manual reset effect needed.
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
    if (id === LIVE_ID) return liveScene ? { status: 'ready', scene: liveScene } : { status: 'missing' };
    if (fetched) return { status: 'ready', scene: fetched };
    if (fetchFailed || (samplesLoaded && !sample)) return { status: 'missing' };
    return { status: 'loading' };
  }, [id, liveScene, fetched, fetchFailed, samplesLoaded, sample]);

  if (load.status === 'missing') {
    return (
      <main className="studio-page">
        <div className="detail-empty">
          <p>That scene isn’t available.</p>
          <a className="detail-back" href={GALLERY_HREF}>← back to gallery</a>
        </div>
      </main>
    );
  }
  if (load.status === 'loading') {
    return <main className="studio-page"><div className="detail-empty"><span className="gallery__spinner" aria-hidden /></div></main>;
  }

  const scene = load.scene;
  const hasInfo = Boolean(scene.metadata?.info || scene.assembly_instructions || scene.metadata?.reference);

  return (
    <main className="studio-page">
      <header className="studio__bar">
        <a className="studio__back" href={GALLERY_HREF}>← gallery</a>
        <h1 className="studio__name">{scene.machine_name}</h1>
        <div className="studio__bar-right">
          <span className="badge badge--count">{scene.parts.length} parts</span>
          {hasInfo ? (
            <button type="button" className={`badge badge--info${infoOpen ? ' badge--active' : ''}`} onClick={() => setInfoOpen((p) => !p)} aria-expanded={infoOpen}>
              <span className="badge__icon" aria-hidden>i</span><span>info</span>
            </button>
          ) : null}
        </div>
      </header>

      <SceneStudio id={id} fallbackScene={scene} />
      <InfoPanel scene={scene} open={infoOpen} onClose={() => setInfoOpen(false)} />
    </main>
  );
}
