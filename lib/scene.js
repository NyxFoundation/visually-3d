// Shared MachineSceneDescriptor helpers: JSON extraction, schema validation,
// slugification and gallery-index derivation. Centralised here so create,
// check, upload and serve all agree on what a valid scene is.

export const SHAPES = new Set([
  'box', 'cylinder', 'sphere', 'cone', 'torus', 'capsule', 'complex',
]);

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// Balanced-brace, string-aware scan from the first "{" so braces inside string
// literals do not confuse the depth counter. Returns the parsed object or
// throws.
export function extractScene(text) {
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
          throw new Error(`model returned invalid JSON: ${e.message}`);
        }
      }
    }
  }
  throw new Error('unterminated JSON object in model output');
}

// Returns an array of human-readable problems; empty array means valid.
export function validateScene(scene) {
  const errors = [];
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
    return ['scene is not an object'];
  }
  if (typeof scene.machine_name !== 'string' || !scene.machine_name.trim()) {
    errors.push('scene.machine_name is missing');
  }
  if (!Array.isArray(scene.parts) || scene.parts.length === 0) {
    errors.push('scene.parts is missing or empty');
    return errors;
  }
  const ids = new Set();
  scene.parts.forEach((p, idx) => {
    const at = `parts[${idx}]${p && p.id ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object') return errors.push(`${at}: not an object`);
    for (const k of ['id', 'name', 'shape', 'material', 'role']) {
      if (typeof p[k] !== 'string' || !p[k].trim()) errors.push(`${at}: missing "${k}"`);
    }
    if (!SHAPES.has(p.shape)) errors.push(`${at}: invalid shape "${p.shape}"`);
    if (!Array.isArray(p.position) || p.position.length !== 3 || !p.position.every(finite)) {
      errors.push(`${at}: position must be 3 finite numbers`);
    }
    if (p.rotation !== undefined &&
        (!Array.isArray(p.rotation) || p.rotation.length !== 3 || !p.rotation.every(finite))) {
      errors.push(`${at}: rotation must be 3 finite numbers`);
    }
    if (!Array.isArray(p.size) || p.size.length < 1 || !p.size.every(finite) ||
        p.size.some((n) => n <= 0)) {
      errors.push(`${at}: size must be a list of positive finite numbers`);
    }
    if (ids.has(p.id)) errors.push(`${at}: duplicate part id "${p.id}"`);
    ids.add(p.id);
  });
  return errors;
}

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'scene';
}

// Build the gallery index entry the frontend expects for a scene.
export function deriveIndexEntry(scene, id, accent = '#58a6ff') {
  const meta = (scene && scene.metadata) || {};
  return {
    id,
    title: (scene && scene.machine_name) || id,
    subtitle: meta.subtitle || meta.summary || meta.description || '',
    path: `/samples/${id}.json`,
    accent: meta.accent || accent,
    category: meta.category || 'all',
    source: 'workspace',
  };
}
