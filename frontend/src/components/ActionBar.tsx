import React from 'react';
import { SprintState } from '../types';
import { buildOverviewModel } from '../presentation';

interface ActionBarProps {
  sprint: SprintState | null;
  projectName?: string | null;
  connected: boolean;
  onToggleChat: () => void;
  chatOpen: boolean;
  onToggleAdvanced: () => void;
  advancedOpen: boolean;
}

export const ActionBar: React.FC<ActionBarProps> = ({
  sprint,
  projectName,
  connected,
  onToggleChat,
  chatOpen,
  onToggleAdvanced,
  advancedOpen,
}) => {
  const overview = buildOverviewModel(sprint);

  if (!sprint) {
    return (
      <header className="action-bar">
        <div className="action-bar-left">
          <span className="section-kicker">{projectName ? `Project · ${projectName}` : 'AgentBoard'}</span>
          <div>
            <p className="action-title">No active sprint</p>
            <p className="action-subtitle">Start a new sprint to explore a small set of clear routes.</p>
          </div>
        </div>
        <div className="action-bar-right">
          <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? 'Live' : 'Polling'}
          </span>
          <button
            className={`chat-toggle-btn ${chatOpen ? 'active' : ''}`}
            onClick={onToggleChat}
            aria-label="Toggle chat"
          >
            Chat
          </button>
        </div>
      </header>
    );
  }

  return (
    <header className="action-bar">
      <div className="action-bar-left">
        <span className="section-kicker">{projectName ? `Project · ${projectName}` : 'AgentBoard'}</span>
        <div>
          <p className="action-title">{sprint.goal}</p>
          <p className="action-subtitle">{overview.summary}</p>
        </div>
      </div>
      <div className="action-bar-right">
        <span className="summary-pill">{overview.phase}</span>
        {overview.needsInputCount > 0 && (
          <span className="summary-pill tone-blocked">
            {overview.needsInputCount} need input
          </span>
        )}
        {overview.readyCount > 0 && (
          <span className="summary-pill tone-review">
            {overview.readyCount} ready to compare
          </span>
        )}
        <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? 'Live' : 'Polling'}
        </span>
        <button
          className={`chat-toggle-btn ${advancedOpen ? 'active' : ''}`}
          onClick={onToggleAdvanced}
          aria-label="Toggle technical details"
        >
          Technical
        </button>
        <button
          className={`chat-toggle-btn ${chatOpen ? 'active' : ''}`}
          onClick={onToggleChat}
          aria-label="Toggle chat"
        >
          Chat
        </button>
      </div>
    </header>
  );
};
