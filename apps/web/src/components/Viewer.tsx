import React from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, Stage } from '@react-three/drei';

interface Part {
  id: string;
  name: string;
  shape: 'box' | 'cylinder' | 'sphere' | 'complex';
  position: [number, number, number];
  size: number[];
  material: string;
  role: string;
}

interface SceneDescriptor {
  machine_name: string;
  parts: Part[];
}

const ScenePart: React.FC<{ part: Part }> = ({ part }) => {
  const { shape, position, size } = part;
  
  // Default material properties
  const materialProps = {
    color: shape === 'complex' ? '#ff00ff' : '#888888',
    metalness: 0.6,
    roughness: 0.2,
  };

  switch (shape) {
    case 'box':
      return (
        <mesh position={position}>
          <boxGeometry args={size.length >= 3 ? size : [1, 1, 1]} />
          <meshStandardMaterial {...materialProps} />
        </mesh>
      );
    case 'cylinder':
      return (
        <mesh position={position}>
          <cylinderGeometry args={size.length >= 2 ? [size[0], size[0], size[1]] : [0.5, 0.5, 1]} />
          <meshStandardMaterial {...materialProps} />
        </mesh>
      );
    case 'sphere':
      return (
        <mesh position={position}>
          <sphereGeometry args={size.length >= 1 ? [size[0]] : [0.5]} />
          <meshStandardMaterial {...materialProps} />
        </mesh>
      );
    case 'complex':
    default:
      return (
        <mesh position={position}>
          <boxGeometry args={size.length >= 3 ? size : [1, 1, 1]} />
          <meshStandardMaterial {...materialProps} />
        </mesh>
      );
  }
};

export const Viewer: React.FC<{ scene: SceneDescriptor }> = ({ scene }) => {
  return (
    <div style={{ width: '100%', height: '100vh', background: '#111' }}>
      <Canvas camera={{ position: [5, 5, 5], fov: 50 }}>
        <color attach="background" args={['#1a1a1a']} />
        
        {/* Lighting */}
        <ambientLight intensity={0.5} />
        <directionalLight 
          position={[10, 10, 5]} 
          intensity={1} 
          castShadow 
        />
        <pointLight position={[-10, -10, -10]} intensity={0.5} />

        {/* Navigation & Environment */}
        <OrbitControls makeDefault />
        <Grid 
          infiniteGrid 
          fadeDistance={20} 
          fadeStrength={5} 
          sectionColor="#333" 
          cellColor="#444" 
        />

        {/* Parts Rendering */}
        <group>
          {scene.parts.map((part) => (
            <ScenePart key={part.id} part={part} />
          ))}
        </group>

        {/* Ground Plane for visual context */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
          <planeGeometry args={[100, 100]} />
          <meshStandardMaterial color="#222" opacity={0.5} transparent />
        </mesh>
      </Canvas>
    </div>
  );
};
