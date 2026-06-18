// Shared types for the Node CLI (compiled in place by tsconfig.cli.json).
// The web app keeps its own types in src/types.ts.

export type Mode = 'hardware' | 'algorithm' | 'architecture';

export type Shape =
  | 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'capsule' | 'complex';

// ── functional spec substrate (lib/amend) ────────────────────────────────────
// The mode-agnostic "genome" that carries what a part actually DOES, distinct
// from how it looks. Geometry (shape/position/size) is the visualization; this
// is the verifiable behavior. `reproduce` reads it as authoritative truth and
// `amend` writes verification-discovered facts back into it, which is what lets
// the reproducibility score climb across a `refine` loop. Every field is
// optional and free-form per mode (widths/ops for a circuit, load/span for a
// building, torque/tolerance for a machine), so it generalizes across modes.
export interface PortSpec {
  name: string;
  dir?: 'in' | 'out' | 'inout';
  width?: number;
  [key: string]: unknown;
}

export interface PartSpec {
  params?: Record<string, number | string | boolean>;
  widths?: Record<string, number>;
  ports?: PortSpec[];
  ops?: string[];
  fsm?: string[];
  notes?: string;
  [key: string]: unknown;
}

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
  // The functional spec for this part: what it computes / how it behaves,
  // filled in by `amend` from verification findings. Geometry stays decoration.
  spec?: PartSpec;
  // generation/engineering modes attach extra fields (compute_profile, …).
  [key: string]: unknown;
}

export interface SceneMetadata {
  mode?: Mode;
  reference?: string;
  domain?: string;
  thumbnail_camera?: [number, number, number];
  info?: Record<string, unknown>;
  // System-level functional spec (clocking, handshake, FSM, global params) that
  // belongs to no single part. Same role as Part.spec, one level up.
  spec?: PartSpec;
  // Optional override of the verification substrate for this scene, regardless
  // of mode — lets a circuit-flavored hardware scene route to SMT, etc.
  backend?: string;
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

// How a verification attempt ended. `pass`/`fail` mean the self-check actually
// RAN and reached a verdict (semantic signal); the rest are HARNESS failures —
// the generated check never produced a verdict, so they must not be conflated
// with "the implementation is wrong".
export type VerifyKind = 'pass' | 'fail' | 'syntax' | 'timeout' | 'error' | 'no-script' | 'no-runner';

export interface VerifyResult {
  pass: boolean;
  ran: boolean;
  kind?: VerifyKind;
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
  fidelity?: number;
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
  scene: FileRef; // the scene snapshot at this version (for re-rendering the 3D)
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

// Unified per-frame detail. Every frame — a scene revision OR a verification —
// is shown the same way: a REASONING half (why) and a CHANGES half (what). For
// a revision the change is the descriptor diff (the 3D/screenshot moves); for a
// verification it's the implementation code diff.
export interface FrameDetail {
  kind: 'revision' | 'verification';
  key: string;
  version: number | null;
  startedAt: string;
  label: string; // 'created' | 'refined' | 'verification'
  score: number | null; // visual rubric (revision) or reproducibility (verification)
  delta: number | null;
  reasoning: { text?: string; gaps?: string[]; verdict?: string };
  changeKind: 'scene' | 'impl';
  structural: StructuralDiff | null; // present when changeKind === 'scene'
  rawDiff: string; // descriptor diff (scene) or code diff (impl), unified line format
  lang?: string; // impl language hint for the code diff
}
