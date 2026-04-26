import React from 'react';
import type { Part } from '../types';

interface PartInfoProps {
  part: Part | null;
  open: boolean;
  onClose: () => void;
}

const profileLabel: Record<string, string> = {
  'gpu-compute-bound': 'GPU compute-bound',
  'gpu-memory-bound': 'GPU memory-bound',
  'gpu-bandwidth-bound': 'GPU bandwidth-bound',
  'memory-capacity-bound': 'memory-capacity bound',
  'communication-bound': 'communication-bound',
  'host-cpu': 'host / CPU',
  'storage-bound': 'storage / I/O bound',
  'mixed': 'mixed profile',
  'negligible': 'negligible cost',
};

const parallelismLabel: Record<string, string> = {
  'embarrassingly-parallel': 'embarrassingly parallel',
  'tensor-parallel': 'tensor-parallel friendly',
  'expert-parallel': 'expert-parallel (MoE)',
  'data-parallel': 'data-parallel only',
  'pipeline-parallel': 'pipeline-parallel friendly',
  'sequential': 'sequential (per token)',
  'mostly-sequential': 'mostly sequential',
  'partially-parallel': 'partially parallel',
};

export const PartInfo: React.FC<PartInfoProps> = ({ part, open, onClose }) => {
  if (!part) return null;

  const hasEngineering = Boolean(
    part.compute_profile ||
      part.parallelism ||
      part.flops_per_token ||
      part.memory_footprint ||
      part.bottleneck,
  );

  return (
    <aside className={`part-panel${open ? ' part-panel--open' : ''}`} aria-hidden={!open}>
      <div className="part-panel__header">
        <h2>{part.name}</h2>
        <button onClick={onClose} aria-label="Close part details">
          ×
        </button>
      </div>

      {hasEngineering ? (
        <div className="part-panel__chips">
          {part.compute_profile ? (
            <span className={`part-chip part-chip--${part.compute_profile}`}>
              {profileLabel[part.compute_profile] ?? part.compute_profile}
            </span>
          ) : null}
          {part.parallelism ? (
            <span className={`part-chip part-chip--parallel`}>
              {parallelismLabel[part.parallelism] ?? part.parallelism}
            </span>
          ) : null}
        </div>
      ) : null}

      <dl>
        <dt>Role</dt>
        <dd>{part.role}</dd>

        {part.flops_per_token ? (
          <>
            <dt>FLOPs / token</dt>
            <dd>{part.flops_per_token}</dd>
          </>
        ) : null}

        {part.memory_footprint ? (
          <>
            <dt>Memory footprint</dt>
            <dd>{part.memory_footprint}</dd>
          </>
        ) : null}

        {part.algorithm ? (
          <>
            <dt>Algorithm (scratch-build)</dt>
            <dd>
              <pre className="part-panel__code">{part.algorithm}</pre>
            </dd>
          </>
        ) : null}

        {part.bottleneck ? (
          <>
            <dt>Bottleneck</dt>
            <dd>{part.bottleneck}</dd>
          </>
        ) : null}

        {part.improvement_ideas && part.improvement_ideas.length > 0 ? (
          <>
            <dt>How to improve</dt>
            <dd>
              <ul className="part-panel__list">
                {part.improvement_ideas.map((idea, i) => (
                  <li key={i}>{idea}</li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}

        <dt>Identity</dt>
        <dd>
          <span className="part-panel__id">{part.id}</span> · {part.shape} · {part.material}
        </dd>

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
