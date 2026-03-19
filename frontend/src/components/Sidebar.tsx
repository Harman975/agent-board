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

const TONE_DOTS: Record<string, string> = {
  blocked: 'var(--blocked)',
  review: 'var(--review)',
  in_progress: 'var(--in-progress)',
  planning: 'var(--planning)',
  done: 'var(--done)',
};

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
      {/* Project header with brand icon */}
      <div className="sidebar-brand">
        <div className="brand-icon">
          <span className="material-symbols-outlined">token</span>
        </div>
        <div>
          <h2 className="brand-title">
            {selectedProject ? selectedProject.name : 'AgentBoard'}
          </h2>
          <p className="brand-subtitle">
            {selectedProject
              ? selectedProject.mission || selectedProject.statusLabel
              : 'Strategic Decisions'}
          </p>
        </div>
      </div>

      {/* High-Level Projects nav section */}
      <div className="sidebar-section-label">High-Level Projects</div>
      <nav className="sidebar-nav">
        {projects.length > 0 ? (
          projects.map((project) => (
            <a
              key={project.id}
              className={`sidebar-nav-item${selectedProjectId === project.id ? ' active' : ''}`}
              onClick={() => onSelectProject(project.id)}
              role="button"
              tabIndex={0}
            >
              <span className="material-symbols-outlined">folder_open</span>
              <span>{project.name}</span>
              {project.needsInputCount > 0 && (
                <span className="nav-count">{project.needsInputCount}</span>
              )}
              {project.needsInputCount === 0 && project.ideaCount > 0 && (
                <span className="nav-count">{project.ideaCount}</span>
              )}
            </a>
          ))
        ) : (
          <p className="sidebar-empty">No projects yet.</p>
        )}

        <a
          className="sidebar-nav-item"
          onClick={() => onOpenTab('board')}
          role="button"
          tabIndex={0}
        >
          <span className="material-symbols-outlined">dashboard</span>
          <span>Board</span>
        </a>
        <a
          className="sidebar-nav-item"
          onClick={() => onOpenTab('timeline')}
          role="button"
          tabIndex={0}
        >
          <span className="material-symbols-outlined">timeline</span>
          <span>Timeline</span>
        </a>
        {advancedMode && (
          <>
            <a
              className="sidebar-nav-item"
              onClick={() => onOpenTab('logs')}
              role="button"
              tabIndex={0}
            >
              <span className="material-symbols-outlined">description</span>
              <span>Logs</span>
            </a>
            <a
              className="sidebar-nav-item"
              onClick={() => onOpenTab('architecture')}
              role="button"
              tabIndex={0}
            >
              <span className="material-symbols-outlined">account_tree</span>
              <span>Architecture</span>
            </a>
          </>
        )}
      </nav>

      {/* Active Ideas & Routes sub-navigation */}
      <div className="sidebar-section-label">Active Ideas &amp; Routes</div>
      <nav className="sidebar-nav">
        {selectedProject && sprint ? (
          <a className="sidebar-nav-item sub-nav" role="button" tabIndex={0}>
            <span className="material-symbols-outlined text-secondary">lightbulb</span>
            <span>Current Workspace</span>
            {sprint && (
              <span className="nav-elapsed">
                {elapsed(sprint.createdAt)}
              </span>
            )}
          </a>
        ) : (
          <a className="sidebar-nav-item sub-nav" role="button" tabIndex={0}>
            <span className="material-symbols-outlined text-secondary">lightbulb</span>
            <span>No active workspace</span>
          </a>
        )}

        {ideas.length > 0 ? (
          ideas.map((idea) => (
            <a
              key={idea.id}
              className="sidebar-nav-sub"
              onClick={() => {
                onOpenTab('board');
                onFocusIdea(idea.id);
              }}
              role="button"
              tabIndex={0}
            >
              <div
                className="idea-dot"
                style={{ background: TONE_DOTS[idea.tone] ?? 'var(--planning)' }}
              />
              <span className="sidebar-nav-sub-label">{idea.title}</span>
              <span className={`sidebar-nav-sub-status tone-${idea.tone}`}>{idea.status}</span>
            </a>
          ))
        ) : (
          <p className="sidebar-empty">Ideas will appear here once a sprint starts.</p>
        )}
      </nav>

      {/* Clarity compact summary */}
      <div className="sidebar-clarity">
        <div className="sidebar-section-label">Clarity</div>
        <p className="sidebar-clarity-phase">{overview.phase}</p>
        <p className="sidebar-clarity-text">{overview.recommendation}</p>
      </div>

      {/* Settings nav item */}
      <a className="sidebar-nav-item sidebar-settings" role="button" tabIndex={0}>
        <span className="material-symbols-outlined">tune</span>
        <span>Settings</span>
      </a>

      {/* Bottom actions */}
      <div className="sidebar-bottom">
        <button className="btn-primary sidebar-btn" onClick={onNewSprint}>
          <span className="material-symbols-outlined btn-icon">add</span>
          + New Project
        </button>
        <div className="sidebar-connection">
          <span className={`connection-dot ${connected ? 'connected' : 'disconnected'}`} />
          <span>{connected ? 'Live updates' : 'Polling for changes'}</span>
        </div>
      </div>
    </aside>
  );
};
