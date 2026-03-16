import React, { useCallback, useEffect, useState } from 'react';
import { LandingBriefAgent, LandingBriefData } from '../types';
import { useToast } from './Toast';

interface LandingBriefProps {
  sprintName: string;
  onClose: () => void;
}

export const LandingBrief: React.FC<LandingBriefProps> = ({ sprintName, onClose }) => {
  const { addToast } = useToast();
  const [agents, setAgents] = useState<LandingBriefAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sprint/${encodeURIComponent(sprintName)}/brief`);
        if (res.ok) {
          const data: LandingBriefData = await res.json();
          if (!cancelled) setAgents(data.agents);
        }
      } catch {
        // fetch failed
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sprintName]);

  const mergeAgent = useCallback(async (handle: string) => {
    setMerging(handle);
    try {
      const res = await fetch(`/api/sprint/${encodeURIComponent(sprintName)}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handles: [handle] }),
      });
      if (res.ok) {
        addToast(`Merged ${handle}`, 'success');
        setAgents((prev) =>
          prev.map((a) => a.handle === handle ? { ...a, status: 'passed' as const } : a)
        );
      } else {
        addToast(`Failed to merge ${handle}`, 'error');
      }
    } catch {
      addToast('Merge failed', 'error');
    } finally {
      setMerging(null);
    }
  }, [sprintName, addToast]);

  const mergeAllPassing = useCallback(async () => {
    const passing = agents.filter((a) => a.status === 'passed').map((a) => a.handle);
    if (passing.length === 0) {
      addToast('No passing agents to merge', 'error');
      return;
    }
    setMerging('all');
    try {
      const res = await fetch(`/api/sprint/${encodeURIComponent(sprintName)}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handles: passing }),
      });
      if (res.ok) {
        addToast(`Merged ${passing.length} agents`, 'success');
      } else {
        addToast('Merge failed', 'error');
      }
    } catch {
      addToast('Merge failed', 'error');
    } finally {
      setMerging(null);
    }
  }, [agents, sprintName, addToast]);

  const statusIcon = (status: string) => {
    switch (status) {
      case 'passed': return '\u2705';
      case 'failed': return '\u274C';
      case 'running': return '\u23F3';
      default: return '\u2753';
    }
  };

  if (loading) {
    return <div className="landing-brief"><p>Loading brief...</p></div>;
  }

  return (
    <div className="landing-brief">
      <div className="brief-header">
        <h2>Landing Brief: {sprintName}</h2>
        <button className="btn-secondary" onClick={onClose}>Close</button>
      </div>

      <div className="brief-actions">
        <button
          className="btn-primary"
          onClick={mergeAllPassing}
          disabled={merging !== null}
        >
          {merging === 'all' ? 'Merging...' : 'Merge All Passing'}
        </button>
      </div>

      <table className="brief-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Agent</th>
            <th>Branch</th>
            <th>Tests</th>
            <th>Files</th>
            <th>Diff</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.handle} className={`brief-row brief-${agent.status}`}>
              <td>{statusIcon(agent.status)}</td>
              <td className="mono">{agent.handle}</td>
              <td className="mono">{agent.branch}</td>
              <td>
                <span className="tests-passed">{agent.testsPassed} passed</span>
                {agent.testsFailed > 0 && (
                  <span className="tests-failed"> {agent.testsFailed} failed</span>
                )}
              </td>
              <td>{agent.filesChanged}f</td>
              <td>
                <span className="additions">+{agent.additions}</span>{' '}
                <span className="deletions">-{agent.deletions}</span>
              </td>
              <td>
                <button
                  className="btn-small"
                  onClick={() => mergeAgent(agent.handle)}
                  disabled={merging !== null}
                >
                  {merging === agent.handle ? 'Merging...' : 'Merge'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
