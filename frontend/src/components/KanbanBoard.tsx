import React from 'react';
import { AgentTile, BucketState } from '../types';
import { KanbanColumn } from './KanbanColumn';

interface KanbanBoardProps {
  agents: AgentTile[];
}

const COLUMNS: { bucket: BucketState; label: string }[] = [
  { bucket: 'planning', label: 'Planning' },
  { bucket: 'in_progress', label: 'In Progress' },
  { bucket: 'blocked', label: 'Blocked' },
  { bucket: 'review', label: 'Review' },
  { bucket: 'done', label: 'Done' },
];

export const KanbanBoard: React.FC<KanbanBoardProps> = ({ agents }) => {
  const grouped = new Map<BucketState, AgentTile[]>();
  for (const col of COLUMNS) {
    grouped.set(col.bucket, []);
  }
  for (const agent of agents) {
    grouped.get(agent.bucket)?.push(agent);
  }

  return (
    <div className="kanban-board" role="region" aria-label="Kanban board">
      {COLUMNS.map(({ bucket, label }) => (
        <KanbanColumn
          key={bucket}
          bucket={bucket}
          label={label}
          agents={grouped.get(bucket) ?? []}
        />
      ))}
    </div>
  );
};
