export interface Part {
  id: string;
  name: string;
  shape: 'box' | 'cylinder' | 'sphere' | 'complex';
  position: [number, number, number];
  rotation?: [number, number, number];
  size: number[];
  material: string;
  role: string;
  connections?: string[];
}

export interface SceneDescriptor {
  machine_name: string;
  assembly_instructions?: string;
  metadata?: Record<string, unknown>;
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
