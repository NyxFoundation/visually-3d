import React from 'react';
import * as THREE from 'three';

interface Part {
  id: string;
  name: string;
  shape: 'box' | 'cylinder' | 'sphere' | 'complex';
  position: [number, number, number];
  size: number[];
  material: string;
  role: string;
  connections?: string[];
}

interface ConnectionsProps {
  parts: Part[];
  selectedPartId?: string;
}

export const Connections: React.FC<ConnectionsProps> = ({ parts, selectedPartId }) => {
  const lines = [];
  const partMap = new Map(parts.map(p => [p.id, p]));

  // To avoid drawing the same connection twice (A->B and B->A)
  const processedConnections = new Set<string>();

  parts.forEach(part => {
    if (!part.connections) return;

    part.connections.forEach(targetId => {
      const target = partMap.get(targetId);
      if (!target) return;

      // Create a unique key for the connection regardless of order
      const connectionKey = [part.id, targetId].sort().join('-');
      if (processedConnections.has(connectionKey)) return;
      processedConnections.add(connectionKey);

      const start = new THREE.Vector3(...part.position);
      const end = new THREE.Vector3(...target.position);

      // Highlight if either connected part is selected
      const isHighlighted = selectedPartId === part.id || selectedPartId === targetId;

      lines.push(
        <Line 
          key={connectionKey} 
          start={start} 
          end={end} 
          highlighted={isHighlighted} 
        />
      );
    });
  });

  return <group>{lines}</group>;
};

const Line: React.FC<{ start: THREE.Vector3; end: THREE.Vector3; highlighted: boolean }> = ({ start, end, highlighted }) => {
  const distance = start.distanceTo(end);
  const center = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  const direction = new THREE.Vector3().subVectors(end, start).normalize();
  
  // Calculate rotation to align cylinder with the line direction
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), 
    direction
  );

  return (
    <mesh position={center} quaternion={quaternion}>
      <cylinderGeometry args={[0.02, 0.02, distance]} />
      <meshStandardMaterial 
        color={highlighted ? '#00ffff' : '#ffffff'} 
        emissive={highlighted ? '#00ffff' : '#444444'}
        emissiveIntensity={highlighted ? 2 : 0.5}
        opacity={0.4} 
        transparent 
      />
    </mesh>
  );
};
