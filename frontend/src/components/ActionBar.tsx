import React from 'react';
import { SprintState, BucketState } from '../types';

interface ActionBarProps {
  sprint: SprintState | null;
  connected: boolean;
  onToggleChat: () => void;
  chatOpen: boolean;
}

function elapsed(createdAt: string): string {
  const diff = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remaining = mins % 60;
  return `${hours}h ${remaining}m`;
}

function countByBucket(
  agents: SprintState['agents']
): Record<BucketState, number> {
  const counts: Record<BucketState, number> = {
    planning: 0,
    in_progress: 0,
    blocked: 0,
    review: 0,
    done: 0,
  };
  for (const a of agents) {
    counts[a.bucket]++;
  }
  return counts;
}

export const ActionBar: React.FC<ActionBarProps> = ({ sprint, connected, onToggleChat, chatOpen }) => {
  if (!sprint) {
    return (
      <header className="action-bar">
        <span className="sprint-name">No active sprint</span>
      </header>
    );
  }

  const counts = countByBucket(sprint.agents);

  const handleMerge = async () => {
    try {
      const res = await fetch(`/data/sprint/${sprint.name}/merge`, { method: 'POST' });
      if (res.ok) {
        const result = await res.json();
        if (result.allDone) {
          alert(`Sprint complete! ${result.results.length} branches merged.`);
        }
      }
    } catch {
      // merge failed
    }
  };

  return (
    <header className="action-bar">
      <div className="action-bar-left">
        <span className="sprint-name">{sprint.name}</span>
        <span className="sprint-goal">{sprint.goal}</span>
        <span className="sprint-elapsed">{elapsed(sprint.createdAt)}</span>
      </div>
      <div className="action-bar-center">
        <span className="bucket-count planning">{counts.planning} planning</span>
        <span className="bucket-count in_progress">{counts.in_progress} active</span>
        <span className="bucket-count blocked">{counts.blocked} blocked</span>
        <span className="bucket-count review">{counts.review} review</span>
        <span className="bucket-count done">{counts.done} done</span>
      </div>
      <div className="action-bar-right">
        <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? 'Live' : 'Polling'}
        </span>
        <button className="merge-button" onClick={handleMerge}>
          Merge Sprint
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
