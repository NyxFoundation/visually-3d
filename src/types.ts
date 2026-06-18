export type ComputeProfile =
  | 'gpu-compute-bound'
  | 'gpu-memory-bound'
  | 'gpu-bandwidth-bound'
  | 'memory-capacity-bound'
  | 'communication-bound'
  | 'host-cpu'
  | 'storage-bound'
  | 'mixed'
  | 'negligible';

export type Parallelism =
  | 'embarrassingly-parallel'
  | 'tensor-parallel'
  | 'expert-parallel'
  | 'data-parallel'
  | 'pipeline-parallel'
  | 'sequential'
  | 'mostly-sequential'
  | 'partially-parallel';

export interface PartEngineering {
  /** Where this part spends its budget on a real GPU node (H800/H100). */
  compute_profile?: ComputeProfile;
  /** Approximate FLOPs per token (forward, decode-step), as a string for readability. */
  flops_per_token?: string;
  /** Activation / weight / KV memory footprint (per token or per layer, labelled inline). */
  memory_footprint?: string;
  /** How this part parallelises across devices (or doesn't). */
  parallelism?: Parallelism;
  /** Pseudocode or a one-screen recipe so a CS student can scratch-build this part. */
  algorithm?: string;
  /** The first thing that hurts when you try to scale this part. */
  bottleneck?: string;
  /** Concrete improvement ideas (research directions, kernel work, scheduling tricks). */
  improvement_ideas?: string[];
}

export interface Part extends PartEngineering {
  id: string;
  name: string;
  shape: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'capsule' | 'complex';
  position: [number, number, number];
  rotation?: [number, number, number];
  size: number[];
  material: string;
  role: string;
  connections?: string[];
}

export interface SceneInfoSource {
  title: string;
  url: string;
}

export interface SceneInfoFact {
  label: string;
  value: string;
}

export interface VersionDiff {
  /** Short tag, e.g. "vs DeepSeek-V3", "vs DeepSeek-V2", "vs GPT-4-class". */
  versus: string;
  /** Plain-English explanation of what changed and why it matters. */
  delta: string;
}

export interface SceneInfo {
  japanese_name?: string;
  english_name?: string;
  summary?: string;
  description?: string;
  operator?: string;
  contractor?: string;
  contract_date?: string;
  contract_value?: string;
  status?: string;
  facts?: SceneInfoFact[];
  sources?: SceneInfoSource[];
  /** Version-to-version comparisons (e.g. against earlier DeepSeek models or peer GPT-class models). */
  comparisons?: VersionDiff[];
}

export interface SceneMetadata {
  reference?: string;
  domain?: string;
  thumbnail_camera?: [number, number, number];
  info?: SceneInfo;
  [key: string]: unknown;
}

export interface SceneDescriptor {
  machine_name: string;
  assembly_instructions?: string;
  metadata?: SceneMetadata;
  parts: Part[];
}

export const MOCK_SCENE: SceneDescriptor = {
  machine_name: 'Local Claude Bridge Demo',
  assembly_instructions: 'Run the backend locally and authenticate the Claude CLI, then analyze a machine name or URL.',
  parts: [
    {
      id: 'base',
      name: 'Mounting Base',
      shape: 'box',
      position: [0, 0, 0],
      size: [5, 0.25, 3],
      material: 'brushed steel',
      role: 'Stable base for the visualization demo.',
      connections: ['processor'],
    },
    {
      id: 'processor',
      name: 'Local Bridge Process',
      shape: 'box',
      position: [0, 1, 0],
      size: [1.8, 1, 1.2],
      material: 'dark anodized aluminum',
      role: 'FastAPI process that spawns the locally authenticated claude command.',
      connections: ['antenna', 'display'],
    },
    {
      id: 'antenna',
      name: 'Claude CLI Stream',
      shape: 'cylinder',
      position: [-1.5, 2.2, 0],
      size: [0.12, 2.4],
      material: 'black composite',
      role: 'Represents stdout/stderr streaming from `claude -p`.',
      connections: ['processor'],
    },
    {
      id: 'display',
      name: 'GUI Log Console',
      shape: 'box',
      position: [1.7, 1.1, 0],
      size: [1.4, 0.9, 0.12],
      material: 'glass display',
      role: 'Shows logs in real time and renders the final JSON scene.',
      connections: ['processor'],
    },
  ],
};

// ── gallery index (served at /samples/index.json) ────────────────────────────
export interface SampleEntry {
  id: string;
  title: string;
  subtitle: string;
  path: string;
  accent: string;
  category?: string;
}

export interface SampleCategory {
  id: string;
  label: string;
}

// ── persisted implementation (served at /api/impl/<id>) ──────────────────────
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

// ── run history (served at /api/runs) ────────────────────────────────────────
export type RunType = 'create' | 'improve' | 'reproduce' | 'unknown';

export interface RunArtifact {
  kind: string;
  label: string;
  file: string;
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
  runId: string;
  type: RunType;
  stamp: string;
  startedAt: string;
  mtimeMs: number;
  status: string;
  score: number | null;
  iterations: number;
}

export interface RunDetail extends RunSummary {
  iters: RunIteration[];
  artifacts: RunArtifact[];
  highlights: RunHighlights;
}
