import React from 'react';
import { AgentTile as AgentTileType, BucketState } from '../types';
import { AgentTile } from './AgentTile';

interface KanbanColumnProps {
  bucket: BucketState;
  label: string;
  agents: AgentTileType[];
}

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  bucket,
  label,
  agents,
}) => {
  return (
    <section className={`kanban-column ${bucket}`} aria-label={`${label} column`}>
      <header className="column-header">
        <h2>{label}</h2>
        <span className="column-count" aria-label={`${agents.length} agents`}>
          {agents.length}
        </span>
      </header>
      <div className="column-body">
        {agents.map((agent) => (
          <AgentTile key={agent.handle} agent={agent} />
        ))}
      </div>
    </section>
  );
};
