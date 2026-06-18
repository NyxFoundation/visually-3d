// Shared MachineSceneDescriptor helpers: JSON extraction, schema validation,
// slugification and gallery-index derivation. Centralised here so create,
// check, upload and serve all agree on what a valid scene is.

import { z } from 'zod';
import type { GalleryEntry, SceneDescriptor } from './types.js';

export const SHAPES: ReadonlySet<string> = new Set([
  'box', 'cylinder', 'sphere', 'cone', 'torus', 'capsule', 'complex',
]);

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// ── zod boundary schema ──────────────────────────────────────────────────────
// The strict, parse-don't-validate boundary: untyped model JSON in, a typed
// SceneDescriptor (or a thrown error) out. validateScene() below stays as the
// lenient, message-collecting check used by create/upload/smoke.
const Triple = z.tuple([z.number(), z.number(), z.number()]);
const PartSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  shape: z.enum(['box', 'cylinder', 'sphere', 'cone', 'torus', 'capsule', 'complex']),
  position: Triple,
  rotation: Triple.optional(),
  size: z.array(z.number().positive()).min(1),
  material: z.string().min(1),
  role: z.string().min(1),
  connections: z.array(z.string()).optional(),
}).loose();

export const SceneSchema = z.object({
  machine_name: z.string().min(1),
  assembly_instructions: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  parts: z.array(PartSchema).min(1),
}).loose();

export function parseScene(raw: unknown): SceneDescriptor {
  return SceneSchema.parse(raw) as unknown as SceneDescriptor;
}

// Balanced-brace, string-aware scan from the first "{" so braces inside string
// literals do not confuse the depth counter. Returns the parsed object or throws.
export function extractScene(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in model output');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (e) {
          throw new Error(`model returned invalid JSON: ${(e as Error).message}`);
        }
      }
    }
  }
  throw new Error('unterminated JSON object in model output');
}

// Returns an array of human-readable problems; empty array means valid.
export function validateScene(scene: unknown): string[] {
  const errors: string[] = [];
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
    return ['scene is not an object'];
  }
  const s = scene as Record<string, unknown>;
  if (typeof s.machine_name !== 'string' || !s.machine_name.trim()) {
    errors.push('scene.machine_name is missing');
  }
  if (!Array.isArray(s.parts) || s.parts.length === 0) {
    errors.push('scene.parts is missing or empty');
    return errors;
  }
  const ids = new Set<unknown>();
  (s.parts as unknown[]).forEach((raw, idx) => {
    const p = raw as Record<string, unknown>;
    const at = `parts[${idx}]${p && typeof p.id === 'string' ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object') { errors.push(`${at}: not an object`); return; }
    for (const k of ['id', 'name', 'shape', 'material', 'role'] as const) {
      const v = p[k];
      if (typeof v !== 'string' || !v.trim()) errors.push(`${at}: missing "${k}"`);
    }
    if (typeof p.shape !== 'string' || !SHAPES.has(p.shape)) {
      errors.push(`${at}: invalid shape "${String(p.shape)}"`);
    }
    const pos = p.position;
    if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(finite)) {
      errors.push(`${at}: position must be 3 finite numbers`);
    }
    const rot = p.rotation;
    if (rot !== undefined && (!Array.isArray(rot) || rot.length !== 3 || !rot.every(finite))) {
      errors.push(`${at}: rotation must be 3 finite numbers`);
    }
    const size = p.size;
    if (!Array.isArray(size) || size.length < 1 || !size.every(finite) ||
        size.some((n) => (n as number) <= 0)) {
      errors.push(`${at}: size must be a list of positive finite numbers`);
    }
    if (ids.has(p.id)) errors.push(`${at}: duplicate part id "${String(p.id)}"`);
    ids.add(p.id);
  });
  return errors;
}

// djb2 → 6 hex chars; stable id fallback for names with no ASCII to slugify
// (e.g. Japanese), so "井波彫刻 雲龍欄間" and "九谷焼" don't both collapse to "scene".
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(6, '0').slice(0, 6);
}

export function slugify(name: unknown): string {
  const ascii = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (ascii) return ascii;
  return `scene-${shortHash(String(name))}`;
}

// Build the gallery index entry the frontend expects for a scene.
export function deriveIndexEntry(
  scene: Partial<SceneDescriptor> | null | undefined,
  id: string,
  accent = '#58a6ff',
): GalleryEntry {
  const meta = (scene?.metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    id,
    title: scene?.machine_name || id,
    subtitle: str(meta.subtitle) || str(meta.summary) || str(meta.description) || '',
    path: `/samples/${id}.json`,
    accent: str(meta.accent) || accent,
    category: str(meta.category) || 'all',
    source: 'workspace',
  };
}
