import React, { Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, Environment, ContactShadows, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { Connections } from './Connections';
import type { Part, SceneDescriptor } from '../types';

const materialColor = (material: string, shape: Part['shape']): string => {
  const lower = material.toLowerCase();
  if (lower.includes('glass') || lower.includes('display')) return '#46b7ff';
  if (lower.includes('carbon')) return '#0f1115';
  if (lower.includes('brass')) return '#d4a657';
  if (lower.includes('copper')) return '#b87333';
  if (lower.includes('fiberglass')) return '#e8e8ea';
  if (lower.includes('white')) return '#f0f0f2';
  if (lower.includes('rubber') || lower.includes('black')) return '#1a1d24';
  if (lower.includes('anodized')) return '#3a3d44';
  if (lower.includes('steel') || lower.includes('aluminum') || lower.includes('metal') || lower.includes('forged')) return '#9ca3af';
  return shape === 'complex' ? '#a855f7' : '#8b949e';
};

const materialPhysical = (material: string) => {
  const lower = material.toLowerCase();
  if (lower.includes('rubber')) return { metalness: 0.0, roughness: 0.95 };
  if (lower.includes('glass') || lower.includes('display')) return { metalness: 0.15, roughness: 0.15 };
  if (lower.includes('carbon')) return { metalness: 0.35, roughness: 0.55 };
  if (lower.includes('brass') || lower.includes('copper')) return { metalness: 0.9, roughness: 0.35 };
  if (lower.includes('brushed')) return { metalness: 0.8, roughness: 0.45 };
  if (lower.includes('anodized') || lower.includes('aluminum')) return { metalness: 0.7, roughness: 0.4 };
  if (lower.includes('steel') || lower.includes('forged')) return { metalness: 0.85, roughness: 0.35 };
  if (lower.includes('fiberglass')) return { metalness: 0.05, roughness: 0.6 };
  if (lower.includes('composite')) return { metalness: 0.1, roughness: 0.65 };
  return { metalness: 0.5, roughness: 0.45 };
};

const ScenePart: React.FC<{
  part: Part;
  selected: boolean;
  interactive: boolean;
  onSelect: (part: Part) => void;
}> = ({ part, selected, interactive, onSelect }) => {
  const physical = useMemo(() => materialPhysical(part.material), [part.material]);
  const color = useMemo(() => materialColor(part.material, part.shape), [part.material, part.shape]);

  const click = interactive
    ? (event: { stopPropagation: () => void }) => {
        event.stopPropagation();
        onSelect(part);
      }
    : undefined;

  const material = (
    <meshStandardMaterial
      color={selected ? '#ffdd55' : color}
      metalness={physical.metalness}
      roughness={physical.roughness}
      emissive={selected ? '#ffaa00' : '#000000'}
      emissiveIntensity={selected ? 0.55 : 0}
    />
  );

  const common = {
    position: part.position,
    rotation: part.rotation,
    onClick: click,
    castShadow: true,
    receiveShadow: true,
  };

  if (part.shape === 'cylinder') {
    const [radius = 0.5, height = 1] = part.size;
    return (
      <mesh {...common}>
        <cylinderGeometry args={[radius, radius, height, 28]} />
        {material}
      </mesh>
    );
  }

  if (part.shape === 'sphere') {
    const [radius = 0.5] = part.size;
    return (
      <mesh {...common}>
        <sphereGeometry args={[radius, 24, 14]} />
        {material}
      </mesh>
    );
  }

  const args: [number, number, number] = part.size.length >= 3 ? [part.size[0], part.size[1], part.size[2]] : [1, 1, 1];
  return (
    <mesh {...common}>
      <boxGeometry args={args} />
      {material}
    </mesh>
  );
};

type ViewerProps = {
  scene: SceneDescriptor;
  selectedPartId?: string;
  onPartSelect?: (part: Part) => void;
  /** Compact thumbnail mode: auto-rotate, no grid, no interaction. */
  compact?: boolean;
  /** Dpr cap for pixel-ratio limiting. */
  maxDpr?: number;
};

const sceneBounds = (scene: SceneDescriptor) => {
  const box = new THREE.Box3();
  scene.parts.forEach((part) => {
    const half = part.shape === 'cylinder'
      ? new THREE.Vector3(part.size[0] ?? 0.5, (part.size[1] ?? 1) / 2, part.size[0] ?? 0.5)
      : part.shape === 'sphere'
      ? new THREE.Vector3(part.size[0] ?? 0.5, part.size[0] ?? 0.5, part.size[0] ?? 0.5)
      : new THREE.Vector3((part.size[0] ?? 1) / 2, (part.size[1] ?? 1) / 2, (part.size[2] ?? 1) / 2);
    const center = new THREE.Vector3(...part.position);
    box.expandByPoint(center.clone().add(half));
    box.expandByPoint(center.clone().sub(half));
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const radius = Math.max(size.x, size.y, size.z);
  return { center, radius };
};

export const Viewer: React.FC<ViewerProps> = ({
  scene,
  selectedPartId,
  onPartSelect,
  compact = false,
  maxDpr = 1.75,
}) => {
  const bounds = useMemo(() => sceneBounds(scene), [scene]);
  const cameraPos = useMemo<[number, number, number]>(() => {
    const meta = scene.metadata as { thumbnail_camera?: [number, number, number] } | undefined;
    if (meta?.thumbnail_camera && meta.thumbnail_camera.length === 3) return meta.thumbnail_camera;
    const d = Math.max(bounds.radius * 1.6, 3);
    return [bounds.center.x + d, bounds.center.y + d * 0.7, bounds.center.z + d];
  }, [scene, bounds]);

  const interactive = !compact;

  return (
    <div className="viewer" aria-label={`3D view of ${scene.machine_name}`}>
      <Canvas
        shadows={!compact}
        dpr={[1, maxDpr]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        frameloop={compact ? 'always' : 'demand'}
      >
        <PerspectiveCamera makeDefault position={cameraPos} fov={compact ? 38 : 45} near={0.1} far={200} />
        <color attach="background" args={[compact ? '#0b0d12' : '#0d1117']} />
        <ambientLight intensity={0.35} />
        <directionalLight
          position={[bounds.center.x + 8, bounds.center.y + 12, bounds.center.z + 6]}
          intensity={1.15}
          castShadow={!compact}
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-camera-left={-bounds.radius * 2}
          shadow-camera-right={bounds.radius * 2}
          shadow-camera-top={bounds.radius * 2}
          shadow-camera-bottom={-bounds.radius * 2}
          shadow-camera-near={0.1}
          shadow-camera-far={bounds.radius * 6}
        />
        <pointLight position={[bounds.center.x - 8, bounds.center.y + 4, bounds.center.z - 8]} intensity={0.35} />

        <Suspense fallback={null}>
          <Environment preset="city" environmentIntensity={0.35} />
        </Suspense>

        <group>
          {scene.parts.map((part) => (
            <ScenePart
              key={part.id}
              part={part}
              selected={part.id === selectedPartId}
              interactive={interactive}
              onSelect={onPartSelect ?? (() => undefined)}
            />
          ))}
        </group>
        <Connections parts={scene.parts} selectedPartId={selectedPartId} />

        {!compact ? (
          <>
            <ContactShadows
              position={[bounds.center.x, 0, bounds.center.z]}
              opacity={0.5}
              scale={Math.max(bounds.radius * 4, 10)}
              blur={2.4}
              far={bounds.radius * 3}
            />
            <Grid
              args={[60, 60]}
              cellSize={1}
              cellThickness={0.6}
              sectionSize={5}
              sectionThickness={1}
              sectionColor="#30363d"
              cellColor="#1f242c"
              fadeDistance={Math.max(bounds.radius * 6, 30)}
              fadeStrength={1.8}
              infiniteGrid
            />
          </>
        ) : null}

        {interactive ? (
          <OrbitControls
            makeDefault
            target={bounds.center}
            enableDamping
            dampingFactor={0.08}
            minDistance={bounds.radius * 0.6}
            maxDistance={bounds.radius * 6}
            maxPolarAngle={Math.PI * 0.48}
          />
        ) : (
          <AutoRotate center={bounds.center} distance={Math.max(bounds.radius * 1.6, 3)} />
        )}

      </Canvas>
    </div>
  );
};

const AutoRotate: React.FC<{ center: THREE.Vector3; distance: number }> = ({ center, distance }) => (
  <OrbitControls
    target={center}
    enableZoom={false}
    enablePan={false}
    autoRotate
    autoRotateSpeed={0.8}
    minDistance={distance * 0.8}
    maxDistance={distance * 1.5}
    minPolarAngle={Math.PI * 0.3}
    maxPolarAngle={Math.PI * 0.5}
  />
);
