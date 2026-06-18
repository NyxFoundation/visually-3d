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

// ── run history (lib/runs) ───────────────────────────────────────────────────
export type RunType = 'create' | 'improve' | 'reproduce' | 'unknown';

export interface RunArtifact {
  kind: 'screenshot' | 'scene' | 'log' | 'impl' | 'report' | 'prompt' | 'verify' | 'review' | 'other';
  label: string;
  file: string; // path relative to the run dir
  iter?: number;
}

export interface RunIteration {
  n: number;
  render?: string;
  scene?: string;
  log?: string;
  review?: string;
  score?: number;
  critique?: string;
}

// At-a-glance, type-specific signals so the history UI can show badges (scores,
// pass/fail, validity) without the client fetching+parsing artifact files.
export interface RunImplHighlight {
  n: number;
  lang: string;
  pass: boolean | null;
  codeFile: string;
  verifyFile?: string;
  logFile?: string;
}

export interface RunHighlights {
  scores?: number[];
  reproducibility?: number;
  verdict?: string;
  verify?: { passed: number; total: number };
  impls?: RunImplHighlight[];
  parts?: number;
  valid?: boolean;
  mode?: string;
}

export interface RunSummary {
  id: string;
  runId: string; // "<type>-<stamp>"
  type: RunType;
  stamp: string;
  startedAt: string;
  mtimeMs: number;
  status: 'done' | 'interrupted' | 'unknown';
  score: number | null;
  iterations: number;
}

export interface RunDetail extends RunSummary {
  iters: RunIteration[];
  artifacts: RunArtifact[];
  highlights: RunHighlights;
}

// ── revision timeline (lib/revisions) ────────────────────────────────────────
// A unified, chronological version history of a scene: create + every improve
// iteration as numbered revisions, with reproduce runs pinned as verification
// markers. The detail of a revision pairs the LLM's reasoning (why) with the
// structural diff of the scene descriptor (what changed).
export interface FileRef { runId: string; file: string; }

export interface RevisionEntry {
  kind: 'revision';
  key: string; // "<runId>:<iter>"
  runId: string;
  startedAt: string;
  version: number; // v0, v1, …
  source: 'created' | 'baseline' | 'refined';
  iter: number;
  score: number | null;
  delta: number | null;
  render: FileRef | null;
  hasReasoning: boolean;
}

export interface VerificationEntry {
  kind: 'verification';
  key: string;
  runId: string;
  startedAt: string;
  reproducibility: number | null;
  verdict?: string;
  verify?: { passed: number; total: number };
  impls: RunImplHighlight[];
}

export type TimelineEntry = RevisionEntry | VerificationEntry;

export interface FieldChange { field: string; before: unknown; after: unknown; }
export interface PartRef { id: string; name?: string; shape?: string; }
export interface PartChange { id: string; name?: string; fields: FieldChange[]; }

export interface StructuralDiff {
  initial: boolean; // v0 — no predecessor
  added: PartRef[];
  removed: PartRef[];
  changed: PartChange[];
  meta: FieldChange[];
}

export interface RevisionDetail {
  key: string;
  version: number;
  startedAt: string;
  source: string;
  score: number | null;
  delta: number | null;
  render: FileRef | null;
  trace: FileRef | null; // events.jsonl (full LLM thinking trace)
  reasoning: { critique?: string; remainingGaps?: string[]; verdict?: string };
  diff: StructuralDiff;
  rawDiff: string; // unified line diff of the pretty-printed scene JSON
}
