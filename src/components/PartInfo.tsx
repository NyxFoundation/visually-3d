import React from 'react';
import type { Part } from '../types';

interface PartInfoProps {
  part: Part | null;
  open: boolean;
  onClose: () => void;
}

export const PartInfo: React.FC<PartInfoProps> = ({ part, open, onClose }) => {
  if (!part) return null;

  return (
    <aside className={`part-panel${open ? ' part-panel--open' : ''}`} aria-hidden={!open}>
      <div className="part-panel__header">
        <h2>{part.name}</h2>
        <button onClick={onClose} aria-label="Close part details">
          ×
        </button>
      </div>
      <dl>
        <dt>ID</dt>
        <dd>{part.id}</dd>
        <dt>Shape</dt>
        <dd>{part.shape}</dd>
        <dt>Material</dt>
        <dd>{part.material}</dd>
        <dt>Role</dt>
        <dd>{part.role}</dd>
        {part.connections && part.connections.length > 0 ? (
          <>
            <dt>Connections</dt>
            <dd>{part.connections.join(', ')}</dd>
          </>
        ) : null}
      </dl>
    </aside>
  );
};
