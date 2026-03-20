import React from 'react';
import { ProjectSummary, SprintState, TabId } from '../types';
import { buildOptionCards, buildOverviewModel } from '../presentation';

interface SidebarProps {
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  activeTab: TabId;
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
  activeTab,
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

      <div className="sidebar-section-label">Workspace</div>
      <nav className="sidebar-nav" aria-label="Workspace destinations">
        <button
          type="button"
          className={`sidebar-nav-item${activeTab === 'projects' ? ' active' : ''}`}
          onClick={() => onOpenTab('projects')}
        >
          <span className="material-symbols-outlined">folder_open</span>
          <span>All projects</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item${activeTab === 'archive' ? ' active' : ''}`}
          onClick={() => onOpenTab('archive')}
        >
          <span className="material-symbols-outlined">inventory_2</span>
          <span>Archive</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item${activeTab === 'collaborators' ? ' active' : ''}`}
          onClick={() => onOpenTab('collaborators')}
        >
          <span className="material-symbols-outlined">group</span>
          <span>Collaborators</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item${activeTab === 'settings' ? ' active' : ''}`}
          onClick={() => onOpenTab('settings')}
        >
          <span className="material-symbols-outlined">settings</span>
          <span>Settings</span>
        </button>
      </nav>

      <div className="sidebar-section-label">Projects</div>
      <nav className="sidebar-nav sidebar-projects" aria-label="Projects">
        {projects.length > 0 ? (
          projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={`sidebar-project-link${selectedProjectId === project.id ? ' active' : ''}`}
              onClick={() => onSelectProject(project.id)}
            >
              <div className="sidebar-project-copy">
                <div className="sidebar-project-line">
                  <span className="material-symbols-outlined sidebar-project-icon">folder_open</span>
                  <span className="sidebar-project-link-name">{project.name}</span>
                </div>
                <p className="sidebar-project-link-meta">
                  {project.activeSprintGoal ?? project.mission ?? project.statusLabel}
                </p>
              </div>
              <span className="nav-count">
                {project.needsInputCount > 0 ? project.needsInputCount : project.ideaCount}
              </span>
            </button>
          ))
        ) : (
          <p className="sidebar-empty">No projects yet.</p>
        )}
      </nav>

      <div className="sidebar-section-label">Ideas</div>
      <button type="button" className="sidebar-workspace-card" onClick={() => onOpenTab('board')}>
        {selectedProject && sprint ? (
          <>
            <div className="sidebar-workspace-line">
              <span className="material-symbols-outlined sidebar-project-icon">lightbulb</span>
              <span>Current workspace</span>
            </div>
            <p className="sidebar-workspace-title">{sprint.goal}</p>
            <p className="sidebar-workspace-meta">{elapsed(sprint.createdAt)} in play</p>
          </>
        ) : (
          <>
            <div className="sidebar-workspace-line">
              <span className="material-symbols-outlined sidebar-project-icon">lightbulb</span>
              <span>Current workspace</span>
            </div>
            <p className="sidebar-workspace-title">No active workspace</p>
            <p className="sidebar-workspace-meta">Start a sprint to make the board come alive.</p>
          </>
        )}
      </button>

      <nav className="sidebar-nav sidebar-ideas" aria-label="Ideas">
        {ideas.length > 0 ? (
          ideas.map((idea) => (
            <button
              key={idea.id}
              type="button"
              className="sidebar-idea-link"
              onClick={() => {
                onOpenTab('board');
                onFocusIdea(idea.id);
              }}
            >
              <div className="sidebar-idea-line">
                <div
                  className="idea-dot"
                  style={{ background: TONE_DOTS[idea.tone] ?? 'var(--planning)' }}
                />
                <span className="sidebar-nav-sub-label">{idea.title}</span>
              </div>
              <span className={`sidebar-nav-sub-status tone-${idea.tone}`}>{idea.status}</span>
            </button>
          ))
        ) : (
          <p className="sidebar-empty">Ideas will appear here once a sprint starts.</p>
        )}
      </nav>

      <div className="sidebar-section-label">Current picture</div>
      <div className="sidebar-clarity-card">
        <p className="sidebar-clarity-phase">{overview.summary}</p>
        <p className="sidebar-clarity-text">{overview.recommendation}</p>
      </div>

      <div className="sidebar-bottom">
        <button className="btn-primary sidebar-btn" onClick={onNewSprint}>
          <span className="material-symbols-outlined btn-icon">add</span>
          + New Project
        </button>
        <button className="btn-secondary sidebar-btn" onClick={() => onOpenTab('timeline')}>
          <span className="material-symbols-outlined btn-icon">timeline</span>
          Open timeline
        </button>
        {advancedMode && (
          <>
            <button className="btn-secondary sidebar-btn" onClick={() => onOpenTab('logs')}>
              <span className="material-symbols-outlined btn-icon">description</span>
              Open logs
            </button>
            <button className="btn-secondary sidebar-btn" onClick={() => onOpenTab('architecture')}>
              <span className="material-symbols-outlined btn-icon">account_tree</span>
              View architecture
            </button>
          </>
        )}
        <div className="sidebar-connection">
          <span className={`connection-dot ${connected ? 'connected' : 'disconnected'}`} />
          <span>{connected ? 'Live updates' : 'Polling for changes'}</span>
        </div>
      </div>
    </aside>
  );
};
