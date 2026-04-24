import React from 'react';
import type { SceneDescriptor, SceneInfo } from '../types';

interface InfoPanelProps {
  scene: SceneDescriptor;
  open: boolean;
  onClose: () => void;
}

const field = (label: string, value: string | undefined) =>
  value ? (
    <div className="info-panel__field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  ) : null;

export const InfoPanel: React.FC<InfoPanelProps> = ({ scene, open, onClose }) => {
  const info: SceneInfo | undefined = scene.metadata?.info;
  const fallbackSource = scene.metadata?.reference;

  const hasAny =
    !!info ||
    !!scene.assembly_instructions ||
    !!fallbackSource;

  if (!hasAny) return null;

  return (
    <aside
      id="info-panel"
      className={`info-panel${open ? ' info-panel--open' : ''}`}
      aria-hidden={!open}
      role="dialog"
      aria-label={`Information about ${scene.machine_name}`}
    >
      <div className="info-panel__header">
        <div>
          {info?.japanese_name ? (
            <p className="info-panel__jp">{info.japanese_name}</p>
          ) : null}
          <h2>{info?.english_name ?? scene.machine_name}</h2>
          {info?.summary ? <p className="info-panel__summary">{info.summary}</p> : null}
        </div>
        <button onClick={onClose} aria-label="Close information">×</button>
      </div>

      {info?.description || scene.assembly_instructions ? (
        <section className="info-panel__section">
          <h3>About</h3>
          <p>{info?.description ?? scene.assembly_instructions}</p>
        </section>
      ) : null}

      {info &&
      (info.operator ||
        info.contractor ||
        info.contract_date ||
        info.contract_value ||
        info.status) ? (
        <section className="info-panel__section">
          <h3>Basic info</h3>
          <dl className="info-panel__facts">
            {field('Operator', info.operator)}
            {field('Contractor', info.contractor)}
            {field('Contract date', info.contract_date)}
            {field('Contract value', info.contract_value)}
            {field('Status', info.status)}
            {info.facts?.map((fact) => (
              <div key={fact.label} className="info-panel__field">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {info?.sources && info.sources.length > 0 ? (
        <section className="info-panel__section">
          <h3>Sources</h3>
          <ul className="info-panel__sources">
            {info.sources.map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer noopener">
                  {source.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : fallbackSource ? (
        <section className="info-panel__section">
          <h3>Source</h3>
          <ul className="info-panel__sources">
            <li>
              <a href={fallbackSource} target="_blank" rel="noreferrer noopener">
                {fallbackSource}
              </a>
            </li>
          </ul>
        </section>
      ) : null}
    </aside>
  );
};
