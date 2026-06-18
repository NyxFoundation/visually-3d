import { useState } from 'react';
import { hrefForDetail } from '../router';
import type { SampleEntry } from '../types';

// A gallery card. Shows a static pre-rendered screenshot (../<id>.png) rather
// than a live WebGL <Canvas> — so the gallery can't exhaust the browser's
// concurrent-context cap (the white-out bug), and there's nothing to render.
export function SceneCard({ sample, active }: { sample: SampleEntry; active?: boolean }) {
  const [failed, setFailed] = useState(false);
  const thumb = sample.path.replace(/\.json$/, '.png');
  return (
    <a
      className={`gallery__card${active ? ' gallery__card--active' : ''}`}
      style={{ ['--accent' as string]: sample.accent }}
      href={hrefForDetail(sample.id)}
      aria-label={`Open ${sample.title}`}
    >
      <div className="gallery__thumb">
        {failed ? (
          <div className="gallery__thumb-poster" aria-hidden />
        ) : (
          <img className="gallery__thumb-img" src={thumb} alt="" loading="lazy" onError={() => setFailed(true)} />
        )}
      </div>
      <div className="gallery__meta">
        <h3>{sample.title}</h3>
        <p>{sample.subtitle}</p>
      </div>
    </a>
  );
}
