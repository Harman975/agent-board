import React from 'react';
import { ProjectCollaboratorsData } from '../types';

interface CollaboratorsPanelProps {
  data: ProjectCollaboratorsData | null;
}

export const CollaboratorsPanel: React.FC<CollaboratorsPanelProps> = ({ data }) => {
  if (!data) {
    return (
      <section className="screen-panel">
        <div className="empty-panel">
          <span className="material-symbols-outlined empty-panel-icon">group</span>
          <h2>No collaborators view yet</h2>
          <p>Select a project to see the current team and the agents carrying the active routes.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="screen-panel">
      <div className="screen-header screen-header-row">
        <div>
          <p className="section-kicker">Collaborators</p>
          <h2>Team governance</h2>
          <p className="screen-summary">
            Coordinate the people and agents around {data.project.name} without leaving the workspace.
          </p>
        </div>
        <div className="screen-actions">
          <button type="button" className="btn-secondary">Export logs</button>
          <button type="button" className="btn-primary">Invite member</button>
        </div>
      </div>

      <section className="screen-section">
        <div className="screen-section-heading">
          <h3>Active AI agents</h3>
          <span className="screen-count-pill">
            {data.activeAgents.length} {data.activeAgents.length === 1 ? 'running' : 'running'}
          </span>
        </div>
        <div className="card-grid two-up">
          {data.activeAgents.length === 0 && (
            <p className="screen-empty">No agents are actively carrying a route in this project right now.</p>
          )}
          {data.activeAgents.map((agent) => (
            <article key={agent.handle} className="screen-card agent-summary-card">
              <div className="project-card-header">
                <span className="material-symbols-outlined project-card-icon">smart_toy</span>
                <span className="projects-status-pill subdued">{agent.status}</span>
              </div>
              <h3>{agent.name}</h3>
              <p className="project-card-text">{agent.focus}</p>
              <p className="meta-line">{agent.role}</p>
              <p className="screen-note">{agent.recentActivity}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="screen-section">
        <div className="screen-section-heading">
          <h3>Core team members</h3>
          <span className="screen-count-pill">{data.members.length} members</span>
        </div>
        {data.members.length === 0 ? (
          <p className="screen-empty">This project does not have any named members yet.</p>
        ) : (
          <div className="data-table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Collaborator</th>
                  <th>Permissions</th>
                  <th>Recent activity</th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((member) => (
                  <tr key={member.handle}>
                    <td>
                      <div className="table-identity">
                        <span className="table-avatar">{member.name.slice(0, 1)}</span>
                        <div>
                          <p>{member.name}</p>
                          <span>{member.handle}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="projects-status-pill subdued">{member.permissions}</span>
                    </td>
                    <td>{member.recentActivity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
};
