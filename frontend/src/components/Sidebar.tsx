import React from 'react';
import { SprintState } from '../types';

interface SidebarProps {
  sprint: SprintState | null;
  connected: boolean;
  onNewSprint: () => void;
  onLand: () => void;
}

function elapsed(createdAt: string): string {
  const diff = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remaining = mins % 60;
  return `${hours}h ${remaining}m`;
}

export const Sidebar: React.FC<SidebarProps> = ({ sprint, connected, onNewSprint, onLand }) => {
  return (
    <aside className="sidebar" aria-label="Sprint sidebar">
      <div className="sidebar-section">
        <h3>Sprint</h3>
        {sprint ? (
          <>
            <p className="sidebar-sprint-name">{sprint.name}</p>
            <p className="sidebar-goal">{sprint.goal}</p>
            <p className="sidebar-elapsed">{elapsed(sprint.createdAt)} elapsed</p>
          </>
        ) : (
          <p className="sidebar-empty">No active sprint</p>
        )}
      </div>

      <div className="sidebar-section">
        <h3>Agents</h3>
        {sprint && sprint.agents.length > 0 ? (
          <ul className="sidebar-agents">
            {sprint.agents.map((agent) => (
              <li key={agent.handle} className="sidebar-agent">
                <span
                  className={`status-dot ${agent.alive ? 'alive' : 'dead'}`}
                  aria-label={agent.alive ? 'alive' : 'stopped'}
                />
                <span className="sidebar-handle">{agent.handle}</span>
                <span className={`sidebar-bucket ${agent.bucket}`}>{agent.bucket.replace('_', ' ')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sidebar-empty">No agents</p>
        )}
      </div>

      <div className="sidebar-section sidebar-actions">
        <h3>Actions</h3>
        <button className="btn-primary sidebar-btn" onClick={onNewSprint}>New Sprint</button>
        {sprint && (
          <button className="btn-secondary sidebar-btn" onClick={onLand}>Land</button>
        )}
      </div>

      <div className="sidebar-section sidebar-connection">
        <span className={`connection-dot ${connected ? 'connected' : 'disconnected'}`} />
        <span>{connected ? 'Live' : 'Polling'}</span>
      </div>
    </aside>
  );
};
