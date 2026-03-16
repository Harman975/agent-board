import { describe, it, expect, vi } from 'vitest';
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

  it('shows kill and steer buttons when expanded with sprintName', () => {
    render(<AgentTile agent={agent} sprintName="test-sprint" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Kill')).toBeInTheDocument();
    expect(screen.getByText('Steer')).toBeInTheDocument();
  });

  it('does not show action buttons without sprintName', () => {
    render(<AgentTile agent={agent} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('Kill')).not.toBeInTheDocument();
    expect(screen.queryByText('Steer')).not.toBeInTheDocument();
  });

  it('does not show action buttons for dead agents', () => {
    const deadAgent: AgentTileType = { ...agent, alive: false, exitCode: 0 };
    render(<AgentTile agent={deadAgent} sprintName="test-sprint" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('Kill')).not.toBeInTheDocument();
    expect(screen.queryByText('Steer')).not.toBeInTheDocument();
  });

  it('shows steer form when steer button clicked', () => {
    render(<AgentTile agent={agent} sprintName="test-sprint" />);
    fireEvent.click(screen.getByRole('button')); // expand
    fireEvent.click(screen.getByText('Steer'));
    expect(screen.getByPlaceholderText('Enter directive...')).toBeInTheDocument();
    expect(screen.getByText('Send')).toBeInTheDocument();
  });

  it('calls kill endpoint when kill button clicked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    render(<AgentTile agent={agent} sprintName="test-sprint" />);
    fireEvent.click(screen.getByRole('button')); // expand
    fireEvent.click(screen.getByText('Kill'));
    expect(fetchSpy).toHaveBeenCalledWith(
      '/data/sprint/test-sprint/kill/frontend',
      { method: 'POST' }
    );
    fetchSpy.mockRestore();
  });

  it('calls steer endpoint when directive submitted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    render(<AgentTile agent={agent} sprintName="test-sprint" />);
    fireEvent.click(screen.getByRole('button')); // expand
    fireEvent.click(screen.getByText('Steer'));
    fireEvent.change(screen.getByPlaceholderText('Enter directive...'), {
      target: { value: 'Focus on tests' },
    });
    fireEvent.submit(screen.getByText('Send').closest('form')!);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/data/sprint/test-sprint/steer/frontend',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ directive: 'Focus on tests' }),
      })
    );
    fetchSpy.mockRestore();
  });
});
