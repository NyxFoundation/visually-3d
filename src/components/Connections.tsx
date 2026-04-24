import React from 'react';
import * as THREE from 'three';
import type { Part } from '../types';

interface ConnectionsProps {
  parts: Part[];
  selectedPartId?: string;
}

export const Connections: React.FC<ConnectionsProps> = ({ parts, selectedPartId }) => {
  const partMap = new Map(parts.map((part) => [part.id, part]));
  const processed = new Set<string>();
  const lines: React.ReactElement[] = [];

  parts.forEach((part) => {
    part.connections?.forEach((targetId) => {
      const target = partMap.get(targetId);
      if (!target) return;
      const key = [part.id, targetId].sort().join('-');
      if (processed.has(key)) return;
      processed.add(key);
      lines.push(
        <Line
          key={key}
          start={new THREE.Vector3(...part.position)}
          end={new THREE.Vector3(...target.position)}
          highlighted={selectedPartId === part.id || selectedPartId === targetId}
        />,
      );
    });
  });

  return <group>{lines}</group>;
};

const Line: React.FC<{ start: THREE.Vector3; end: THREE.Vector3; highlighted: boolean }> = ({ start, end, highlighted }) => {
  const distance = start.distanceTo(end);
  const center = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  const direction = new THREE.Vector3().subVectors(end, start).normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);

  return (
    <mesh position={center} quaternion={quaternion}>
      <cylinderGeometry args={[highlighted ? 0.035 : 0.018, highlighted ? 0.035 : 0.018, distance, 12]} />
      <meshStandardMaterial
        color={highlighted ? '#00e5ff' : '#d0d7de'}
        emissive={highlighted ? '#00e5ff' : '#30363d'}
        emissiveIntensity={highlighted ? 1.8 : 0.25}
        opacity={highlighted ? 0.9 : 0.35}
        transparent
      />
    </mesh>
  );
};
