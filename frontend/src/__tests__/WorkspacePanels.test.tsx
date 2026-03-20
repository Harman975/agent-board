import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectsPanel } from '../components/ProjectsPanel';
import { CollaboratorsPanel } from '../components/CollaboratorsPanel';
import { ArchivePanel } from '../components/ArchivePanel';
import { SettingsPanel } from '../components/SettingsPanel';
import {
  ProjectArchiveData,
  ProjectCollaboratorsData,
  ProjectSettingsData,
  ProjectSummary,
} from '../types';

const projects: ProjectSummary[] = [
  {
    id: 'compiler',
    name: 'Compiler',
    mission: 'Build a small compiler with strong architectural clarity.',
    statusLabel: 'Needs input',
    needsInputCount: 1,
    ideaCount: 3,
    activeSprintName: 'compiler-parser',
    activeSprintGoal: 'Choose the parser architecture.',
  },
  {
    id: 'ui',
    name: 'UI',
    mission: 'Design a calmer decision board.',
    statusLabel: 'Exploring',
    needsInputCount: 0,
    ideaCount: 2,
    activeSprintName: null,
    activeSprintGoal: null,
  },
];

const collaborators: ProjectCollaboratorsData = {
  project: {
    id: 'compiler',
    name: 'Compiler',
    mission: 'Build a small compiler with strong architectural clarity.',
    manager: '@admin',
    statusLabel: 'Exploring',
    activeSprintName: 'compiler-parser',
  },
  activeAgents: [
    {
      handle: '@parser',
      name: 'Parser Explorer',
      role: 'Exploring parser directions',
      focus: 'Comparing Pratt and recursive descent.',
      status: 'Exploring',
      recentActivity: 'Pratt parser handles precedence more cleanly so far.',
    },
  ],
  members: [
    {
      handle: '@admin',
      name: 'Admin',
      role: 'Manager',
      permissions: 'Full access',
      recentActivity: 'Reviewed the open architecture question.',
    },
  ],
};

const archive: ProjectArchiveData = {
  project: {
    id: 'compiler',
    name: 'Compiler',
    mission: 'Build a small compiler with strong architectural clarity.',
  },
  stats: {
    successRate: 75,
    archivedCount: 4,
    completedCount: 3,
    failedCount: 1,
  },
  featured: {
    name: 'compiler-parser',
    goal: 'Choose the parser architecture.',
    statusLabel: 'Completed',
    createdAt: '2026-03-18T09:00:00Z',
    finishedAt: '2026-03-18T12:00:00Z',
  },
  records: [
    {
      name: 'compiler-parser',
      goal: 'Choose the parser architecture.',
      statusLabel: 'Completed',
      createdAt: '2026-03-18T09:00:00Z',
      finishedAt: '2026-03-18T12:00:00Z',
    },
  ],
};

const settings: ProjectSettingsData = {
  workspace: {
    id: 'compiler',
    name: 'Compiler',
    mission: 'Build a small compiler with strong architectural clarity.',
    manager: '@admin',
    statusLabel: 'Needs input',
    activeSprintGoal: 'Choose the parser architecture.',
    memberCount: 3,
  },
  connectedTools: [
    {
      name: 'stitch',
      scope: 'global',
      status: 'Configured',
      note: 'Available from the global Codex MCP config.',
    },
  ],
  preferences: [
    {
      id: 'notify-needs-input',
      label: 'Needs input alerts',
      description: 'Notify when a route cannot orient without human judgment.',
      enabled: true,
    },
  ],
};

describe('workspace panels', () => {
  it('renders the projects portfolio and lets the user select a project', () => {
    const onSelectProject = vi.fn();
    render(
      <ProjectsPanel
        projects={projects}
        selectedProjectId="compiler"
        onSelectProject={onSelectProject}
      />
    );

    expect(screen.getByRole('heading', { name: 'Project portfolio' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /UI/i }));
    expect(onSelectProject).toHaveBeenCalledWith('ui');
  });

  it('renders collaborators and active agent context', () => {
    render(<CollaboratorsPanel data={collaborators} />);

    expect(screen.getByRole('heading', { name: 'Team governance' })).toBeInTheDocument();
    expect(screen.getByText('Parser Explorer')).toBeInTheDocument();
    expect(screen.getByText('Full access')).toBeInTheDocument();
  });

  it('renders archive summaries and records', () => {
    render(<ArchivePanel data={archive} />);

    expect(screen.getByRole('heading', { name: 'Vault archive' })).toBeInTheDocument();
    expect(screen.getByText('Success rate')).toBeInTheDocument();
    expect(screen.getAllByText('Choose the parser architecture.').length).toBeGreaterThan(0);
  });

  it('renders connected tools and preferences', () => {
    render(<SettingsPanel data={settings} />);

    expect(screen.getByRole('heading', { name: 'Workspace settings' })).toBeInTheDocument();
    expect(screen.getByText('stitch')).toBeInTheDocument();
    expect(screen.getByText('Needs input alerts')).toBeInTheDocument();
  });
});
