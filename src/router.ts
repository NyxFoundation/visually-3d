// Tiny hash-based router. Hash routing (`#/s/<id>`) needs zero server/deploy
// config — it works identically under the local `serve` process and on the
// static Cloudflare deploy, with no SPA-fallback rewrite rules.

import { useEffect, useState } from 'react';

export type Route =
  | { name: 'gallery' }
  | { name: 'detail'; id: string };

// The synthetic id used for a scene produced live by Analyze (not in the
// bundled gallery). Held in app state, resolved by the detail page.
export const LIVE_ID = '__live__';

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 's' && parts[1]) {
    return { name: 'detail', id: decodeURIComponent(parts[1]) };
  }
  return { name: 'gallery' };
}

export function hrefForDetail(id: string): string {
  return `#/s/${encodeURIComponent(id)}`;
}

export const GALLERY_HREF = '#/';

export function navigate(href: string): void {
  window.location.hash = href.startsWith('#') ? href : `#${href}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
