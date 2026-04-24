import React from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import { Connections } from './Connections';
import type { Part, SceneDescriptor } from '../types';

const materialColor = (material: string, shape: Part['shape']) => {
  const lower = material.toLowerCase();
  if (lower.includes('glass') || lower.includes('display')) return '#46b7ff';
  if (lower.includes('steel') || lower.includes('aluminum') || lower.includes('metal')) return '#9ca3af';
  if (lower.includes('rubber') || lower.includes('black')) return '#1f2937';
  if (lower.includes('copper')) return '#b87333';
  return shape === 'complex' ? '#a855f7' : '#8b949e';
};

const ScenePart: React.FC<{ part: Part; selected: boolean; onSelect: (part: Part) => void }> = ({ part, selected, onSelect }) => {
  const materialProps = {
    color: selected ? '#ffdd55' : materialColor(part.material, part.shape),
    metalness: 0.45,
    roughness: 0.35,
    emissive: selected ? '#6b5200' : '#000000',
    emissiveIntensity: selected ? 0.6 : 0,
  };

  const click = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onSelect(part);
  };

  if (part.shape === 'cylinder') {
    const [radius = 0.5, height = 1] = part.size;
    return (
      <mesh position={part.position} onClick={click}>
        <cylinderGeometry args={[radius, radius, height, 32]} />
        <meshStandardMaterial {...materialProps} />
      </mesh>
    );
  }

  if (part.shape === 'sphere') {
    const [radius = 0.5] = part.size;
    return (
      <mesh position={part.position} onClick={click}>
        <sphereGeometry args={[radius, 32, 16]} />
        <meshStandardMaterial {...materialProps} />
      </mesh>
    );
  }

  const args: [number, number, number] = part.size.length >= 3 ? [part.size[0], part.size[1], part.size[2]] : [1, 1, 1];
  return (
    <mesh position={part.position} onClick={click}>
      <boxGeometry args={args} />
      <meshStandardMaterial {...materialProps} />
    </mesh>
  );
};

export const Viewer: React.FC<{ scene: SceneDescriptor; selectedPartId?: string; onPartSelect: (part: Part) => void }> = ({
  scene,
  selectedPartId,
  onPartSelect,
}) => (
  <div className="viewer">
    <Canvas camera={{ position: [6, 5, 6], fov: 50 }}>
      <color attach="background" args={['#101218']} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[10, 10, 6]} intensity={1.2} />
      <pointLight position={[-8, 4, -8]} intensity={0.5} />
      <OrbitControls makeDefault />
      <Grid infiniteGrid fadeDistance={24} fadeStrength={4} sectionColor="#30363d" cellColor="#22272e" />
      <group>
        {scene.parts.map((part) => (
          <ScenePart key={part.id} part={part} selected={part.id === selectedPartId} onSelect={onPartSelect} />
        ))}
      </group>
      <Connections parts={scene.parts} selectedPartId={selectedPartId} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color="#0d1117" opacity={0.45} transparent />
      </mesh>
    </Canvas>
  </div>
);
