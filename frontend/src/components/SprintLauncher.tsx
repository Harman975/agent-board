import React, { useState } from 'react';
import { SprintSuggestion, SprintTask, TabId } from '../types';
import { humanizeIdentifier, humanizeScope } from '../presentation';
import { useToast } from './Toast';

interface SprintLauncherProps {
  projectId?: string | null;
  projectName?: string | null;
  onSwitchTab: (tab: TabId) => void;
  onClose: () => void;
}

export const SprintLauncher: React.FC<SprintLauncherProps> = ({ projectId, projectName, onSwitchTab, onClose }) => {
  const { addToast } = useToast();
  const [goal, setGoal] = useState('');
  const [suggestion, setSuggestion] = useState<SprintSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [spawning, setSpawning] = useState(false);

  const handleSuggest = async () => {
    if (!goal.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/data/sprint/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal }),
      });
      if (res.ok) {
        const data: SprintSuggestion = await res.json();
        setSuggestion(data);
      } else {
        addToast('Failed to draft routes', 'error');
      }
    } catch {
      addToast('Failed to connect to server', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!suggestion) return;
    setSpawning(true);
    try {
      const res = await fetch('/data/sprint/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: suggestion.goal,
          tasks: suggestion.tasks,
          teamName: projectId && projectId !== '__general__' ? projectId : null,
        }),
      });
      if (res.ok) {
        addToast('Sprint started successfully', 'success');
        onSwitchTab('board');
      } else {
        addToast('Failed to start sprint', 'error');
      }
    } catch {
      addToast('Failed to connect to server', 'error');
    } finally {
      setSpawning(false);
    }
  };

  const handleCancel = () => {
    setSuggestion(null);
    setGoal('');
    onClose();
  };

  return (
    <div className="sprint-launcher">
      <p className="section-kicker">New Sprint</p>
      <h2>Start with a clear question</h2>
      {projectName && (
        <p className="plan-goal">Project: {projectName}</p>
      )}
      {!suggestion ? (
        <div className="launcher-form">
          <label>
            What are we trying to learn?
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Describe the outcome you want in plain English..."
              rows={3}
            />
          </label>
          <div className="launcher-actions">
            <button
              className="btn-primary"
              onClick={handleSuggest}
              disabled={loading || !goal.trim()}
            >
              {loading ? 'Drafting routes...' : 'Draft Routes'}
            </button>
            <button className="btn-secondary" onClick={handleCancel}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="launcher-plan">
          <h3>Suggested routes</h3>
          <p className="plan-goal">{suggestion.goal}</p>
          <div className="plan-route-list">
            {suggestion.tasks.map((task: SprintTask, i: number) => (
              <article key={i} className="plan-route-card">
                <p className="plan-route-label">Route {i + 1}</p>
                <h4>{task.mission}</h4>
                {(task.approachLabel || task.track) && (
                  <p className="plan-route-context">
                    {humanizeIdentifier(task.approachLabel) ?? humanizeIdentifier(task.track)}
                  </p>
                )}
                <p>Focus area: {humanizeScope(task.scope)}</p>
              </article>
            ))}
          </div>
          <div className="launcher-actions">
            <button
              className="btn-primary"
              onClick={handleApprove}
              disabled={spawning}
            >
              {spawning ? 'Starting sprint...' : 'Start Sprint'}
            </button>
            <button className="btn-secondary" onClick={() => setSuggestion(null)}>
              Back
            </button>
            <button className="btn-secondary" onClick={handleCancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};
