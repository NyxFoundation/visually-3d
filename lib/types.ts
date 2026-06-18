// Shared types for the Node CLI (compiled in place by tsconfig.cli.json).
// The web app keeps its own types in src/types.ts.

export type Mode = 'hardware' | 'algorithm' | 'architecture';

export type Shape =
  | 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'capsule' | 'complex';

export interface Part {
  id: string;
  name: string;
  shape: Shape;
  position: [number, number, number];
  rotation?: [number, number, number];
  size: number[];
  material: string;
  role: string;
  connections?: string[];
  // generation/engineering modes attach extra fields (compute_profile, …).
  [key: string]: unknown;
}

export interface SceneMetadata {
  mode?: Mode;
  reference?: string;
  domain?: string;
  thumbnail_camera?: [number, number, number];
  info?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SceneDescriptor {
  machine_name: string;
  assembly_instructions?: string;
  metadata?: SceneMetadata;
  parts: Part[];
}

// ── verification backends (lib/backends) ─────────────────────────────────────
export type Availability =
  | { ok: true; runner: string }
  | { ok: false; reason: string };

export interface VerifyResult {
  pass: boolean;
  ran: boolean;
  stdout?: string;
  stderr?: string;
  code?: number;
}

export interface Backend {
  readonly id: string;
  readonly label: string;
  readonly language: string;
  available(): Promise<Availability>;
  implementInstructions(): string;
  verify(script: string, dir: string): Promise<VerifyResult>;
}

export interface GalleryEntry {
  id: string;
  title: string;
  subtitle: string;
  path: string;
  accent: string;
  category: string;
  source: string;
}

// ── persisted implementations (lib/impls) ────────────────────────────────────
// The canonical implementation distilled from a `reproduce` run for one scene.
export interface StoredImplMeta {
  id: string;
  mode: string;
  language: string;
  ext: string;
  backend: string;
  confidence?: number;
  reproducibility?: number;
  verdict?: string;
  verified: { pass: boolean; ran: boolean } | null;
  savedAt: string;
  runDir: string;
}

export interface StoredImpl {
  meta: StoredImplMeta;
  code: string;
  verifyLog?: string;
}
