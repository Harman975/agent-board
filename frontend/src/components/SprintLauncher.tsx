import React, { useState } from 'react';
import { SprintSuggestion, SprintTask, TabId } from '../types';
import { useToast } from './Toast';

interface SprintLauncherProps {
  onSwitchTab: (tab: TabId) => void;
  onClose: () => void;
}

export const SprintLauncher: React.FC<SprintLauncherProps> = ({ onSwitchTab, onClose }) => {
  const { addToast } = useToast();
  const [goal, setGoal] = useState('');
  const [suggestion, setSuggestion] = useState<SprintSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [spawning, setSpawning] = useState(false);

  const handleSuggest = async () => {
    if (!goal.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/sprint/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal }),
      });
      if (res.ok) {
        const data: SprintSuggestion = await res.json();
        setSuggestion(data);
      } else {
        addToast('Failed to generate plan', 'error');
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
      const res = await fetch('/api/sprint/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: suggestion.goal, tasks: suggestion.tasks }),
      });
      if (res.ok) {
        addToast('Sprint started successfully', 'success');
        onSwitchTab('kanban');
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
      <h2>New Sprint</h2>
      {!suggestion ? (
        <div className="launcher-form">
          <label>
            Sprint Goal:
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Describe what you want to accomplish..."
              rows={3}
            />
          </label>
          <div className="launcher-actions">
            <button
              className="btn-primary"
              onClick={handleSuggest}
              disabled={loading || !goal.trim()}
            >
              {loading ? 'Generating plan...' : 'Generate Plan'}
            </button>
            <button className="btn-secondary" onClick={handleCancel}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="launcher-plan">
          <h3>Proposed Plan</h3>
          <p className="plan-goal">{suggestion.goal}</p>
          <table className="plan-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Handle</th>
                <th>Mission</th>
                <th>Scope</th>
              </tr>
            </thead>
            <tbody>
              {suggestion.tasks.map((task: SprintTask, i: number) => (
                <tr key={i}>
                  <td>{task.agent}</td>
                  <td className="mono">{task.handle}</td>
                  <td>{task.mission}</td>
                  <td className="mono">{task.scope}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="launcher-actions">
            <button
              className="btn-primary"
              onClick={handleApprove}
              disabled={spawning}
            >
              {spawning ? 'Spawning agents...' : 'Approve & Start'}
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
