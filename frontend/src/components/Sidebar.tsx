import React from 'react';
import { ProjectSummary, SprintState, TabId } from '../types';
import { buildOptionCards, buildOverviewModel } from '../presentation';

interface SidebarProps {
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  sprint: SprintState | null;
  connected: boolean;
  onNewSprint: () => void;
  onSelectProject: (projectId: string) => void;
  onFocusIdea: (ideaId: string) => void;
  onOpenTab: (tab: TabId) => void;
  advancedMode: boolean;
}

function elapsed(createdAt: string): string {
  const diff = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remaining = mins % 60;
  return `${hours}h ${remaining}m`;
}

export const Sidebar: React.FC<SidebarProps> = ({
  projects,
  selectedProjectId,
  sprint,
  connected,
  onNewSprint,
  onSelectProject,
  onFocusIdea,
  onOpenTab,
  advancedMode,
}) => {
  const overview = buildOverviewModel(sprint);
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const ideas = sprint ? buildOptionCards(sprint.agents) : [];

  return (
    <aside className="sidebar" aria-label="Sprint sidebar">
      <div className="sidebar-section">
        <h3>Projects</h3>
        {projects.length > 0 ? (
          <div className="sidebar-list">
            {projects.map((project) => (
              <button
                key={project.id}
                className={`sidebar-project ${selectedProjectId === project.id ? 'active' : ''}`}
                onClick={() => onSelectProject(project.id)}
              >
                <div className="sidebar-project-header">
                  <p className="sidebar-project-name">{project.name}</p>
                  {project.needsInputCount > 0 && (
                    <span className="sidebar-project-pill">{project.needsInputCount}</span>
                  )}
                </div>
                <p className="sidebar-project-meta">
                  {project.statusLabel}
                  {project.ideaCount > 0 ? ` · ${project.ideaCount} ideas` : ''}
                </p>
              </button>
            ))}
          </div>
        ) : (
          <p className="sidebar-empty">No projects yet.</p>
        )}
      </div>

      <div className="sidebar-section">
        <h3>Current Project</h3>
        {selectedProject ? (
          <>
            <p className="sidebar-sprint-name">{selectedProject.name}</p>
            <p className="sidebar-note">{selectedProject.mission}</p>
            <p className="sidebar-label">{selectedProject.statusLabel}</p>
            {sprint ? (
              <p className="sidebar-elapsed">{elapsed(sprint.createdAt)} elapsed</p>
            ) : (
              <p className="sidebar-note">No active sprint right now.</p>
            )}
          </>
        ) : (
          <p className="sidebar-empty">Select a project to focus the board.</p>
        )}
      </div>

      <div className="sidebar-section">
        <h3>Ideas</h3>
        {ideas.length > 0 ? (
          <div className="sidebar-list">
            {ideas.map((idea) => (
              <button
                key={idea.id}
                className="sidebar-idea"
                onClick={() => {
                  onOpenTab('board');
                  onFocusIdea(idea.id);
                }}
              >
                <div className="sidebar-idea-main">
                  <p className="sidebar-project-name">{idea.title}</p>
                  {idea.track && <p className="sidebar-idea-track">{idea.track}</p>}
                </div>
                <span className={`sidebar-idea-status tone-${idea.tone}`}>{idea.status}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="sidebar-empty">The ideas for this project will appear here once a sprint starts.</p>
        )}
      </div>

      <div className="sidebar-section">
        <h3>Clarity</h3>
        <p className="sidebar-label">Current picture</p>
        <p className="sidebar-note">{overview.summary}</p>
        <p className="sidebar-label">Best next move</p>
        <p className="sidebar-note">{overview.recommendation}</p>
      </div>

      <div className="sidebar-section sidebar-actions">
        <h3>Actions</h3>
        <button className="btn-primary sidebar-btn" onClick={onNewSprint}>Start New Sprint</button>
        {sprint && (
          <>
            <button className="btn-secondary sidebar-btn" onClick={() => onOpenTab('board')}>
              Open Board
            </button>
            <button className="btn-secondary sidebar-btn" onClick={() => onOpenTab('timeline')}>
              Open Timeline
            </button>
          </>
        )}
      </div>

      {advancedMode && (
        <div className="sidebar-section sidebar-actions">
          <h3>Technical</h3>
          <button className="btn-secondary sidebar-btn" onClick={() => onOpenTab('logs')}>
            Logs
          </button>
          <button className="btn-secondary sidebar-btn" onClick={() => onOpenTab('architecture')}>
            Architecture Map
          </button>
        </div>
      )}

      <div className="sidebar-section sidebar-connection">
        <span className={`connection-dot ${connected ? 'connected' : 'disconnected'}`} />
        <span>{connected ? 'Live updates' : 'Polling for changes'}</span>
      </div>
    </aside>
  );
};
