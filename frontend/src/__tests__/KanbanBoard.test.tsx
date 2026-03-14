import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { AgentTile } from '../types';

function makeAgent(overrides: Partial<AgentTile> = {}): AgentTile {
  return {
    handle: '@test',
    bucket: 'planning',
    mission: 'Test mission',
    branch: null,
    lastPost: null,
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    alive: true,
    exitCode: null,
    ...overrides,
  };
}

describe('KanbanBoard', () => {
  it('renders all 5 columns', () => {
    render(<KanbanBoard agents={[]} />);
    expect(screen.getByText('Planning')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('sorts agents into correct columns', () => {
    const agents: AgentTile[] = [
      makeAgent({ handle: '@a', bucket: 'planning' }),
      makeAgent({ handle: '@b', bucket: 'in_progress' }),
      makeAgent({ handle: '@c', bucket: 'blocked' }),
      makeAgent({ handle: '@d', bucket: 'review' }),
      makeAgent({ handle: '@e', bucket: 'done' }),
    ];

    render(<KanbanBoard agents={agents} />);

    expect(screen.getByText('@a')).toBeInTheDocument();
    expect(screen.getByText('@b')).toBeInTheDocument();
    expect(screen.getByText('@c')).toBeInTheDocument();
    expect(screen.getByText('@d')).toBeInTheDocument();
    expect(screen.getByText('@e')).toBeInTheDocument();
  });

  it('shows correct count badges', () => {
    const agents: AgentTile[] = [
      makeAgent({ handle: '@a', bucket: 'in_progress' }),
      makeAgent({ handle: '@b', bucket: 'in_progress' }),
      makeAgent({ handle: '@c', bucket: 'done' }),
    ];

    render(<KanbanBoard agents={agents} />);

    const counts = screen.getAllByLabelText(/agents$/);
    const countTexts = counts.map((el) => el.textContent);
    expect(countTexts).toContain('2');
    expect(countTexts).toContain('1');
  });
});
