import React from 'react';
import { ProjectSummary } from '../types';

interface ProjectsPanelProps {
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
}

function summaryLine(project: ProjectSummary): string {
  if (project.needsInputCount > 0) {
    return `${project.needsInputCount} ${project.needsInputCount === 1 ? 'route needs' : 'routes need'} your input.`;
  }
  if (project.ideaCount > 0) {
    return `${project.ideaCount} ${project.ideaCount === 1 ? 'route is' : 'routes are'} active.`;
  }
  return 'No active routes right now.';
}

export const ProjectsPanel: React.FC<ProjectsPanelProps> = ({
  projects,
  selectedProjectId,
  onSelectProject,
}) => {
  const featured = projects[0] ?? null;

  return (
    <section className="projects-panel">
      <div className="screen-header">
        <div>
          <p className="section-kicker">Projects</p>
          <h2>Project portfolio</h2>
          <p className="screen-summary">
            Move between projects quickly and focus the board only when a project earns your attention.
          </p>
        </div>
      </div>

      {featured && (
        <button
          type="button"
          className="projects-featured-card"
          onClick={() => onSelectProject(featured.id)}
        >
          <div className="projects-featured-copy">
            <p className="projects-status-pill">{featured.statusLabel}</p>
            <h3>{featured.name}</h3>
            <p>{featured.activeSprintGoal ?? featured.mission}</p>
          </div>
          <div className="projects-featured-meta">
            <span>{summaryLine(featured)}</span>
            <span>{featured.activeSprintName ? 'Active sprint' : 'Quiet workspace'}</span>
          </div>
        </button>
      )}

      <div className="projects-grid">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className={`project-card${selectedProjectId === project.id ? ' active' : ''}`}
            onClick={() => onSelectProject(project.id)}
          >
            <div className="project-card-header">
              <span className="material-symbols-outlined project-card-icon">folder_open</span>
              <span className="projects-status-pill subdued">{project.statusLabel}</span>
            </div>
            <h3>{project.name}</h3>
            <p className="project-card-text">{project.activeSprintGoal ?? project.mission}</p>
            <div className="project-card-footer">
              <span>{summaryLine(project)}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
};
