import React from 'react';
import { SprintState, TabId } from '../types';
import { buildOverviewModel } from '../presentation';

const PRIMARY_TABS: { id: TabId; label: string }[] = [
  { id: 'board', label: 'Overview' },
  { id: 'timeline', label: 'Timeline' },
];

const TECHNICAL_TABS: { id: TabId; label: string }[] = [
  { id: 'logs', label: 'Logs' },
  { id: 'architecture', label: 'Architecture' },
];

interface ActionBarProps {
  sprint: SprintState | null;
  projectName?: string | null;
  connected: boolean;
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
}

export const ActionBar: React.FC<ActionBarProps> = ({
  sprint,
  connected,
  activeTab,
  onTabChange,
  advancedOpen,
  onToggleAdvanced,
  chatOpen,
  onToggleChat,
}) => {
  const overview = buildOverviewModel(sprint);

  return (
    <header className="action-bar">
      <div className="action-bar-left">
        <h1 className="action-bar-brand">Cognitive Canvas</h1>
        {sprint && (
          <span className={`action-bar-status-dot ${connected ? 'connected' : 'disconnected'}`}>
            <span className={`connection-dot-inline ${connected ? 'connected' : 'disconnected'}`} />
            {overview.phase}
          </span>
        )}
        {!sprint && (
          <span className={`action-bar-status-dot ${connected ? 'connected' : 'disconnected'}`}>
            <span className={`connection-dot-inline ${connected ? 'connected' : 'disconnected'}`} />
            {connected ? 'Live' : 'Polling'}
          </span>
        )}
      </div>

      <nav className="action-bar-tabs" role="tablist" aria-label="Main navigation">
        {PRIMARY_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`action-bar-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        {advancedOpen && TECHNICAL_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`action-bar-tab action-bar-tab-technical ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="action-bar-right">
        <div className="action-bar-search">
          <span className="material-symbols-outlined action-bar-search-icon">search</span>
          <input
            className="action-bar-search-input"
            type="text"
            placeholder="Command + K to search"
            readOnly
          />
        </div>
        <button
          className={`action-bar-icon-btn ${advancedOpen ? 'active' : ''}`}
          onClick={onToggleAdvanced}
          aria-label="Toggle technical details"
          title="Technical details"
        >
          <span className="material-symbols-outlined">build</span>
        </button>
        <button
          className="action-bar-icon-btn"
          aria-label="Notifications"
          title="Notifications"
        >
          <span className="material-symbols-outlined">notifications</span>
        </button>
        <button
          className={`action-bar-icon-btn ${chatOpen ? 'active' : ''}`}
          onClick={onToggleChat}
          aria-label="Toggle chat"
          title="Chat"
        >
          <span className="material-symbols-outlined">chat</span>
        </button>
        <div className="action-bar-avatar">
          <span className="material-symbols-outlined">person</span>
        </div>
      </div>
    </header>
  );
};
