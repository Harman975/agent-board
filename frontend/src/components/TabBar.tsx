import React from 'react';
import { TabId } from '../types';

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  advancedMode: boolean;
}

const PRIMARY_TABS: { id: TabId; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'timeline', label: 'Timeline' },
];

const TECHNICAL_TABS: { id: TabId; label: string }[] = [
  { id: 'logs', label: 'Logs' },
  { id: 'architecture', label: 'Architecture' },
];

export const TabBar: React.FC<TabBarProps> = ({ activeTab, onTabChange, advancedMode }) => {
  return (
    <nav className="tab-bar" role="tablist" aria-label="Main navigation">
      {PRIMARY_TABS.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={activeTab === tab.id}
          className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
      {advancedMode && (
        <>
          <span className="tab-divider" aria-hidden="true" />
          {TECHNICAL_TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`tab-button tab-button-technical ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </>
      )}
    </nav>
  );
};
