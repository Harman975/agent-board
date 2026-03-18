import React, { useCallback, useEffect, useState } from 'react';
import { LandingBriefAgent, LandingBriefData } from '../types';

interface LandingBriefProps {
  sprintName: string;
  onClose: () => void;
}

export const LandingBrief: React.FC<LandingBriefProps> = ({ sprintName, onClose }) => {
  const [brief, setBrief] = useState<LandingBriefData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/data/sprint/${encodeURIComponent(sprintName)}/brief`);
        if (res.ok) {
          const data: LandingBriefData = await res.json();
          if (!cancelled) setBrief(data);
        }
      } catch {
        // fetch failed
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sprintName]);

  const statusIcon = (status: string) => {
    switch (status) {
      case 'passed': return '\u2705';
      case 'crashed': return '\u274C';
      case 'running': return '\u23F3';
      default: return '\u2753';
    }
  };

  const groupedAgents = useCallback((agents: LandingBriefAgent[]) => {
    const groups = new Map<string, LandingBriefAgent[]>();
    for (const agent of agents) {
      const key = agent.approachGroup ?? `solo:${agent.handle}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(agent);
      groups.set(key, bucket);
    }
    return Array.from(groups.values());
  }, []);

  if (loading) {
    return <div className="landing-brief"><p>Loading brief...</p></div>;
  }

  if (!brief) {
    return <div className="landing-brief"><p>Unable to load brief.</p></div>;
  }

  return (
    <div className="landing-brief">
      <div className="brief-header">
        <h2>Landing Brief: {brief.sprint.name}</h2>
        <button className="btn-secondary" onClick={onClose}>Close</button>
      </div>

      <div className="brief-actions">
        <p>
          {brief.summary.passed} passed, {brief.summary.crashed} crashed, {brief.summary.running} running.
          {brief.compression && (
            <> Synthesis: {brief.compression.status} ({Math.round(brief.compression.ratio * 100)}% reduction).</>
          )}
        </p>
      </div>

      {groupedAgents(brief.agents).map((group) => (
        <div key={group[0].approachGroup ?? group[0].handle} className="brief-group">
          {group[0].approachGroup && (
            <h3>
              {group[0].track ? `${group[0].track}: ` : ''}
              {group[0].approachGroup}
            </h3>
          )}
          <table className="brief-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Agent</th>
                <th>Approach</th>
                <th>Branch</th>
                <th>Tests</th>
                <th>Commits</th>
                <th>DAG</th>
              </tr>
            </thead>
            <tbody>
              {group.map((agent) => (
                <tr key={agent.handle} className={`brief-row brief-${agent.status}`}>
                  <td>{statusIcon(agent.status)}</td>
                  <td className="mono">{agent.handle}</td>
                  <td>{agent.approachLabel ?? agent.mission ?? '-'}</td>
                  <td className="mono">{agent.branch ?? '-'}</td>
                  <td>{agent.testCount ?? '-'}</td>
                  <td>{agent.commitCount}</td>
                  <td>{agent.lastDagPushMessage ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
};
