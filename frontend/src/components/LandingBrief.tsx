import React, { useEffect, useState } from 'react';
import { LandingBriefData } from '../types';
import { buildDecisionBriefModel } from '../presentation';

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

  if (loading) {
    return <div className="landing-brief"><p>Loading decision brief...</p></div>;
  }

  if (!brief) {
    return <div className="landing-brief"><p>Unable to load the decision brief.</p></div>;
  }

  const decision = buildDecisionBriefModel(brief);
  const passedCount = decision.options.filter((option) => option.tone === 'passed').length;
  const runningCount = decision.options.filter((option) => option.tone === 'running').length;
  const crashedCount = decision.options.filter((option) => option.tone === 'crashed').length;

  return (
    <div className="landing-brief">
      <div className="brief-header">
        <div>
          <p className="section-kicker">Decision Brief</p>
          <h2>{brief.sprint.goal}</h2>
        </div>
        <button className="btn-secondary" onClick={onClose}>Close</button>
      </div>

      <div className="decision-callout">
        <h3>{decision.headline}</h3>
        <p>{decision.recommendation}</p>
        {decision.compressionNote && <p className="decision-support">{decision.compressionNote}</p>}
      </div>

      <div className="decision-stat-row">
        <article className="overview-stat">
          <p className="overview-stat-label">Likely survivors</p>
          <p className="overview-stat-value">{passedCount}</p>
          <p className="overview-stat-note">Routes that currently hold up.</p>
        </article>
        <article className="overview-stat">
          <p className="overview-stat-label">Still open</p>
          <p className="overview-stat-value">{runningCount}</p>
          <p className="overview-stat-note">Routes that still need more learning.</p>
        </article>
        <article className="overview-stat">
          <p className="overview-stat-label">Not stable yet</p>
          <p className="overview-stat-value">{crashedCount}</p>
          <p className="overview-stat-note">Routes that should not survive as they are.</p>
        </article>
      </div>

      <div className="decision-grid">
        {decision.options.map((option) => (
          <article key={option.id} className={`decision-card tone-${option.tone}`}>
            <div className="decision-card-header">
              <div>
                <p className="decision-card-title">{option.title}</p>
                <p className="decision-card-verdict">{option.verdict}</p>
              </div>
              <span className={`status-badge tone-${option.tone}`}>{option.status}</span>
            </div>
            <p className="decision-card-body">{option.whyItMatters}</p>
            <div className="signal-grid decision-signal-grid">
              {option.whatItReuses && (
                <article className="signal-tile">
                  <p className="signal-label">What it reuses</p>
                  <p className="signal-text">{option.whatItReuses}</p>
                </article>
              )}
              {option.existingCodeGap && (
                <article className="signal-tile">
                  <p className="signal-label">Why the current code was not enough</p>
                  <p className="signal-text">{option.existingCodeGap}</p>
                </article>
              )}
              {option.evidence && (
                <article className="signal-tile">
                  <p className="signal-label">Evidence</p>
                  <p className="signal-text">{option.evidence}</p>
                </article>
              )}
              {option.concern && (
                <article className="signal-tile">
                  <p className="signal-label">Watchout</p>
                  <p className="signal-text">{option.concern}</p>
                </article>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
};
