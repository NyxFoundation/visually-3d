// `syncScene` — mirror a scene's LOCAL workspace artifacts (its scene JSON, the
// full visualize/verify/refine run history, the gathered evidence, and the
// canonical impl) into the repo-tracked `examples/<id>/`, as-is. This is the
// shared mirror step `upload` uses (direct-push in a repo checkout, or into a
// fork clone for the PR path). The loop writes to `~/.visually-3d` (outside any
// repo); this promotes a scene's history into version control. A curated
// `examples/<id>/notes.md` (if any) is preserved.
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveScene, scenePath, sceneRunsDir, evidenceDir, packagedExampleDir, } from './paths.js';
import { implDir } from './impls.js';
// Copy a whole directory tree (as-is) into dest, replacing any prior copy so the
// mirror never keeps stale files. No-op when the source is absent.
function mirrorDir(src, dest) {
    if (!existsSync(src))
        return 0;
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    let n = 0;
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory())
                walk(path.join(d, e.name));
            else
                n++;
        }
    };
    walk(dest);
    return n;
}
// Mirror everything the loop produced for `id` into `dest` (defaults to the
// package's examples/<id>/). Pure-ish (filesystem only) so it is testable with a
// temp dest.
export function syncScene(id, opts = {}) {
    const dest = opts.dest ?? packagedExampleDir(id);
    mkdirSync(dest, { recursive: true });
    // The canonical scene JSON (the version the loop has been improving).
    const sceneSrc = existsSync(scenePath(id)) ? scenePath(id) : (resolveScene(id) ?? '');
    let scene = false;
    if (sceneSrc && existsSync(sceneSrc)) {
        copyFileSync(sceneSrc, path.join(dest, 'scene.json'));
        scene = true;
    }
    const runs = mirrorDir(sceneRunsDir(id), path.join(dest, 'runs'));
    const evidence = mirrorDir(evidenceDir(id), path.join(dest, 'evidence'));
    const impl = mirrorDir(implDir(id), path.join(dest, 'impl'));
    return { scene, runs, evidence, impl, dest };
}
