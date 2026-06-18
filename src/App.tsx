import { useEffect, useState } from 'react';
import { GalleryPage } from './pages/GalleryPage';
import { DetailPage } from './pages/DetailPage';
import { useRoute } from './router';
import type { SampleCategory, SampleEntry } from './types';

function App() {
  const route = useRoute();
  const [samples, setSamples] = useState<SampleEntry[]>([]);
  const [categories, setCategories] = useState<SampleCategory[]>([]);
  const [samplesLoaded, setSamplesLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/samples/index.json')
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: { samples?: SampleEntry[]; categories?: SampleCategory[] }) => {
        if (cancelled) return;
        setSamples(data.samples ?? []);
        setCategories(data.categories ?? []);
      })
      .catch(() => { if (!cancelled) { setSamples([]); setCategories([]); } })
      .finally(() => { if (!cancelled) setSamplesLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  if (route.name === 'detail') {
    return <DetailPage key={route.id} id={route.id} samples={samples} samplesLoaded={samplesLoaded} />;
  }
  return <GalleryPage samples={samples} categories={categories} />;
}

export default App;
