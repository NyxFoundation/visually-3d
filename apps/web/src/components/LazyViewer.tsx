import React, { Suspense, lazy } from 'react';
import type { ComponentProps } from 'react';

const Viewer = lazy(() => import('./Viewer').then((m) => ({ default: m.Viewer })));

type LazyViewerProps = ComponentProps<typeof Viewer>;

export const LazyViewer: React.FC<LazyViewerProps> = (props) => (
  <Suspense fallback={<div className="viewer viewer--loading" aria-hidden />}>
    <Viewer {...props} />
  </Suspense>
);
