import { useEffect, useMemo, useState } from 'react';
import { InfoPanel } from '../components/InfoPanel';
import { SceneStudio } from '../components/SceneStudio';
import { Icon } from '../components/Icon';
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
  const info = scene.metadata?.info;
  // The short DESCRIPTION shown under the title.
  const description = info?.description ?? info?.summary ?? scene.assembly_instructions ?? '';
  // The "more detailed" info that lives behind the info button (facts, how it
  // differs, sources) — only offered when there's something beyond the blurb.
  const hasDetails = Boolean(
    scene.metadata?.reference ||
    (info && (info.operator || info.contractor || info.contract_date
      || info.contract_value || info.status || info.facts?.length || info.comparisons?.length || info.sources?.length)),
  );

  return (
    <main className="studio-page">
      <header className="studio__bar">
        <a className="studio__back" href={GALLERY_HREF}>← gallery</a>
        <div className="studio__titlewrap">
          <div className="studio__titlerow">
            <h1 className="studio__name">{scene.machine_name}</h1>
            {hasDetails ? (
              <button type="button" className={`studio__info${infoOpen ? ' studio__info--active' : ''}`} onClick={() => setInfoOpen((p) => !p)} aria-expanded={infoOpen} aria-label="More details" title="More details">
                <Icon name="info" size={16} />
              </button>
            ) : null}
          </div>
          {description ? <p className="studio__desc">{description}</p> : null}
        </div>
      </header>

      <SceneStudio id={id} fallbackScene={scene} />
      <InfoPanel scene={scene} open={infoOpen} onClose={() => setInfoOpen(false)} />
    </main>
  );
}
