import React from 'react';
import { SprintState } from '../types';
import { buildOptionCards, buildOverviewModel } from '../presentation';

interface OverviewPanelProps {
  sprint: SprintState | null;
}

export const OverviewPanel: React.FC<OverviewPanelProps> = ({ sprint }) => {
  const overview = buildOverviewModel(sprint);
  const options = sprint ? buildOptionCards(sprint.agents).slice(0, 3) : [];

  if (!sprint) {
    return (
      <section className="overview-panel">
        <div className="empty-panel">
          <h2>No active sprint</h2>
          <p>Start a new sprint to explore a few clear routes before you commit to one.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="overview-panel">
      <div className="overview-hero">
        <p className="section-kicker">{overview.phase}</p>
        <h2>{sprint.goal}</h2>
        <p className="overview-summary">{overview.summary}</p>
      </div>

      <div className="overview-stat-row">
        <article className="overview-stat">
          <p className="overview-stat-label">Routes in play</p>
          <p className="overview-stat-value">{overview.optionCount}</p>
          <p className="overview-stat-note">Different ideas being tested right now.</p>
        </article>
        <article className="overview-stat">
          <p className="overview-stat-label">Need input</p>
          <p className="overview-stat-value">{overview.needsInputCount}</p>
          <p className="overview-stat-note">Routes waiting on your judgment.</p>
        </article>
        <article className="overview-stat">
          <p className="overview-stat-label">Ready to compare</p>
          <p className="overview-stat-value">{overview.readyCount}</p>
          <p className="overview-stat-note">Routes with enough signal to judge.</p>
        </article>
      </div>

      <div className="overview-grid overview-detail-grid">
        <article className="overview-card">
          <h3>What matters now</h3>
          <p>{overview.focus}</p>
        </article>
        <article className="overview-card">
          <h3>Best next move</h3>
          <p>{overview.recommendation}</p>
        </article>
      </div>

      <div className="overview-card">
        <div className="overview-card-header">
          <div>
            <h3>Route snapshots</h3>
            <p className="overview-card-support">A small, readable view of the main routes still in play.</p>
          </div>
        </div>
        {options.length === 0 ? (
          <p>No routes are active yet.</p>
        ) : (
          <div className="overview-route-grid">
            {options.map((option) => (
              <article key={option.id} className="overview-route-tile">
                <div className="overview-route-tile-header">
                  <p className="overview-route-title">{option.title}</p>
                  <span className={`status-badge tone-${option.tone}`}>{option.status}</span>
                </div>
                <p className="overview-route-text">{option.summary}</p>
                <p className="overview-route-support">{option.nextStep}</p>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
