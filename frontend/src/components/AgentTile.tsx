import React, { useState } from 'react';
import { AgentTile as AgentTileType } from '../types';

interface AgentTileProps {
  agent: AgentTileType;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'no activity';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

export const AgentTile: React.FC<AgentTileProps> = ({ agent }) => {
  const [expanded, setExpanded] = useState(false);

  const statusClass = agent.alive ? 'alive' : 'dead';

  return (
    <div
      className={`agent-tile ${agent.bucket} ${statusClass}`}
      onClick={() => setExpanded(!expanded)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded(!expanded);
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
    >
      <div className="tile-header">
        <span className="tile-handle">{agent.handle}</span>
        <span className="tile-status" aria-label={agent.alive ? 'alive' : 'stopped'}>
          {agent.alive ? '\u25CF' : '\u25CB'}
        </span>
      </div>

      <p className="tile-mission">
        {expanded ? agent.mission : agent.mission.slice(0, 80) + (agent.mission.length > 80 ? '\u2026' : '')}
      </p>

      <div className="tile-meta">
        <span className="tile-diff" aria-label="diff stats">
          <span className="additions">+{agent.additions}</span>
          <span className="deletions">-{agent.deletions}</span>
          <span className="files">{agent.filesChanged}f</span>
        </span>
      </div>

      {expanded && (
        <div className="tile-details">
          {agent.branch && (
            <p className="tile-branch">Branch: {agent.branch}</p>
          )}
          {agent.lastPost && (
            <p className="tile-last-post">{agent.lastPost}</p>
          )}
          {agent.exitCode !== null && (
            <p className="tile-exit">Exit code: {agent.exitCode}</p>
          )}
        </div>
      )}
    </div>
  );
};
