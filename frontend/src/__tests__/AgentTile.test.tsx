import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentTile } from '../components/AgentTile';
import { AgentTile as AgentTileType } from '../types';

const agent: AgentTileType = {
  handle: '@frontend',
  bucket: 'in_progress',
  mission: 'Build the React kanban command center frontend for AgentBoard with full component suite',
  branch: 'agent/frontend',
  lastPost: 'Working on components',
  additions: 150,
  deletions: 20,
  filesChanged: 8,
  alive: true,
  exitCode: null,
};

describe('AgentTile', () => {
  it('renders handle and truncated mission', () => {
    render(<AgentTile agent={agent} />);
    expect(screen.getByText('@frontend')).toBeInTheDocument();
    expect(screen.getByText(/Build the React kanban/)).toBeInTheDocument();
  });

  it('shows diff stats', () => {
    render(<AgentTile agent={agent} />);
    expect(screen.getByText('+150')).toBeInTheDocument();
    expect(screen.getByText('-20')).toBeInTheDocument();
    expect(screen.getByText('8f')).toBeInTheDocument();
  });

  it('expands on click to show details', () => {
    render(<AgentTile agent={agent} />);
    expect(screen.queryByText(/Branch:/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Branch: agent/frontend')).toBeInTheDocument();
    expect(screen.getByText('Working on components')).toBeInTheDocument();
  });

  it('shows exit code for dead agents', () => {
    const deadAgent: AgentTileType = {
      ...agent,
      alive: false,
      exitCode: 1,
    };
    render(<AgentTile agent={deadAgent} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Exit code: 1')).toBeInTheDocument();
  });
});
