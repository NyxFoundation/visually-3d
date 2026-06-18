// Canonical per-scene implementation store. `reproduce` distils its best
// implementation (the runnable self-checking program) + recorded verification
// here, keyed by scene id, so the web detail page can show source ⇄ 3D and
// re-run the tests live without re-running the whole reproduce loop.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { IMPLS_DIR } from './paths.js';
import type { StoredImpl, StoredImplMeta } from './types.js';

export function implDir(id: string): string {
  return path.join(IMPLS_DIR, id);
}

export function saveImpl(id: string, impl: StoredImpl): void {
  const dir = implDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `impl.${impl.meta.ext}`), impl.code);
  if (impl.verifyLog != null) writeFileSync(path.join(dir, 'verify.txt'), impl.verifyLog);
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(impl.meta, null, 2) + '\n');
}

export function readImpl(id: string): StoredImpl | null {
  const dir = implDir(id);
  const metaPath = path.join(dir, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as StoredImplMeta;
    const codePath = path.join(dir, `impl.${meta.ext}`);
    const code = existsSync(codePath) ? readFileSync(codePath, 'utf8') : '';
    const verifyPath = path.join(dir, 'verify.txt');
    const verifyLog = existsSync(verifyPath) ? readFileSync(verifyPath, 'utf8') : undefined;
    return { meta, code, verifyLog };
  } catch {
    return null;
  }
}
