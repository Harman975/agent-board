import React, { useState } from 'react';
import { AgentTile as AgentTileType } from '../types';

interface AgentTileProps {
  agent: AgentTileType;
  sprintName?: string;
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

export const AgentTile: React.FC<AgentTileProps> = ({ agent, sprintName }) => {
  const [expanded, setExpanded] = useState(false);
  const [steering, setSteering] = useState(false);
  const [directive, setDirective] = useState('');

  const statusClass = agent.alive ? 'alive' : 'dead';

  const handleKill = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!sprintName) return;
    const handle = agent.handle.replace(/^@/, '');
    try {
      await fetch(`/data/sprint/${sprintName}/kill/${handle}`, { method: 'POST' });
    } catch { /* best effort */ }
  };

  const handleSteer = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sprintName || !directive.trim()) return;
    const handle = agent.handle.replace(/^@/, '');
    try {
      await fetch(`/data/sprint/${sprintName}/steer/${handle}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directive: directive.trim() }),
      });
      setDirective('');
      setSteering(false);
    } catch { /* best effort */ }
  };

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
          {agent.alive ? '\u25CF' : '\u25CB'} {timeAgo(agent.lastPost)}
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
          {sprintName && (
            <div className="tile-actions" onClick={(e) => e.stopPropagation()}>
              {agent.alive && (
                <>
                  <button className="action-btn steer-btn" onClick={() => setSteering(!steering)}>
                    Steer
                  </button>
                  <button className="action-btn kill-btn" onClick={handleKill}>
                    Kill
                  </button>
                </>
              )}
              {steering && (
                <form className="steer-form" onSubmit={handleSteer}>
                  <input
                    type="text"
                    value={directive}
                    onChange={(e) => setDirective(e.target.value)}
                    placeholder="Enter directive..."
                    autoFocus
                  />
                  <button type="submit" className="action-btn send-btn">Send</button>
                </form>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
