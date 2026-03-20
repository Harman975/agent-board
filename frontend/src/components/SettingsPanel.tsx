import React from 'react';
import { ProjectSettingsData } from '../types';

interface SettingsPanelProps {
  data: ProjectSettingsData | null;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ data }) => {
  if (!data) {
    return (
      <section className="screen-panel">
        <div className="empty-panel">
          <span className="material-symbols-outlined empty-panel-icon">settings</span>
          <h2>No settings loaded</h2>
          <p>Select a project to review its workspace settings and connected tools.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="screen-panel">
      <div className="screen-header">
        <div>
          <p className="section-kicker">Settings</p>
          <h2>Workspace settings</h2>
          <p className="screen-summary">
            Keep the project identity, tools, and notification defaults readable in one place.
          </p>
        </div>
      </div>

      <div className="settings-layout">
        <section className="screen-card settings-card">
          <p className="settings-section-label">Workspace identity</p>
          <h3>{data.workspace.name}</h3>
          <p className="project-card-text">{data.workspace.mission}</p>
          <div className="settings-grid">
            <div className="settings-field">
              <span>Manager</span>
              <strong>{data.workspace.manager ?? 'Not assigned yet'}</strong>
            </div>
            <div className="settings-field">
              <span>Status</span>
              <strong>{data.workspace.statusLabel}</strong>
            </div>
            <div className="settings-field">
              <span>Members</span>
              <strong>{data.workspace.memberCount}</strong>
            </div>
            <div className="settings-field">
              <span>Active sprint</span>
              <strong>{data.workspace.activeSprintGoal ?? 'No active sprint right now'}</strong>
            </div>
          </div>
        </section>

        <section className="screen-section">
          <div className="screen-section-heading">
            <h3>Connected tools</h3>
            <span className="screen-count-pill">{data.connectedTools.length} configured</span>
          </div>
          <div className="card-grid">
            {data.connectedTools.length === 0 && (
              <p className="screen-empty">No MCP tools are configured for this workspace yet.</p>
            )}
            {data.connectedTools.map((tool) => (
              <article key={`${tool.scope}-${tool.name}`} className="screen-card tool-card">
                <div className="project-card-header">
                  <span className="material-symbols-outlined project-card-icon">extension</span>
                  <span className="projects-status-pill subdued">{tool.scope}</span>
                </div>
                <h3>{tool.name}</h3>
                <p className="screen-note">{tool.note}</p>
                <p className="meta-line">{tool.status}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="screen-section">
          <div className="screen-section-heading">
            <h3>Notification preferences</h3>
          </div>
          <div className="card-grid">
            {data.preferences.map((preference) => (
              <article key={preference.id} className="screen-card preference-card">
                <div className="preference-header">
                  <div>
                    <h3>{preference.label}</h3>
                    <p className="screen-note">{preference.description}</p>
                  </div>
                  <span className={`preference-toggle ${preference.enabled ? 'enabled' : ''}`}>
                    <span className="preference-knob" />
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
};
