import React from 'react';
import { AgentTile } from '../types';
import { buildOptionCards, type OptionCardModel } from '../presentation';

interface KanbanBoardProps {
  agents: AgentTile[];
}

export const KanbanBoard: React.FC<KanbanBoardProps> = ({ agents }) => {
  const options = buildOptionCards(agents);
  const sections: {
    tone: OptionCardModel['tone'];
    title: string;
    description: string;
  }[] = [
    {
      tone: 'blocked',
      title: 'Needs your input',
      description: 'These routes are waiting on a human decision before they can move.',
    },
    {
      tone: 'review',
      title: 'Ready to compare',
      description: 'These routes have enough signal to judge against each other.',
    },
    {
      tone: 'in_progress',
      title: 'Still exploring',
      description: 'These routes are actively learning and should stay narrow for now.',
    },
    {
      tone: 'planning',
      title: 'Being framed',
      description: 'These routes are still being shaped before more work is added.',
    },
    {
      tone: 'done',
      title: 'Completed pass',
      description: 'These routes finished their current pass and are waiting to be kept or dropped.',
    },
  ];

  return (
    <section className="options-layout" role="region" aria-label="Options board">
      {options.length === 0 ? (
        <div className="empty-panel">
          <h2>No routes in play yet</h2>
          <p>Once a sprint starts, the active routes will appear here in plain English.</p>
        </div>
      ) : (
        sections.map((section) => {
          const group = options.filter((option) => option.tone === section.tone);
          if (group.length === 0) return null;

          return (
            <section key={section.tone} className="option-section">
              <div className="option-section-header">
                <div>
                  <p className="section-kicker">Option group</p>
                  <h2>{section.title}</h2>
                  <p className="option-section-description">{section.description}</p>
                </div>
                <span className="option-section-count">
                  {group.length} {group.length === 1 ? 'route' : 'routes'}
                </span>
              </div>

              <div className="options-board">
                {group.map((option) => (
                  <article key={option.id} className={`option-card tone-${option.tone}`}>
                    <div className="option-card-header">
                      <div>
                        <p className="option-card-title">{option.title}</p>
                        {option.track && <p className="option-card-track">{option.track}</p>}
                      </div>
                      <span className={`status-badge tone-${option.tone}`}>{option.status}</span>
                    </div>

                    <p className="option-card-summary">{option.summary}</p>

                    <div className="signal-grid">
                      <article className="signal-tile">
                        <p className="signal-label">Current state</p>
                        <p className="signal-value">{option.status}</p>
                      </article>
                      <article className="signal-tile">
                        <p className="signal-label">Who is carrying it</p>
                        <p className="signal-text">{option.memberSentence}</p>
                      </article>
                      <article className="signal-tile">
                        <p className="signal-label">What it needs next</p>
                        <p className="signal-text">{option.nextStep}</p>
                      </article>
                      {option.latestNote && (
                        <article className="signal-tile">
                          <p className="signal-label">Latest signal</p>
                          <p className="signal-text">{option.latestNote}</p>
                        </article>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })
      )}
    </section>
  );
};
