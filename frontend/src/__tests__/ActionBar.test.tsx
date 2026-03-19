import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActionBar } from '../components/ActionBar';
import { SprintState } from '../types';

const sprint: SprintState = {
  name: 'Sprint Alpha',
  goal: 'Build the board',
  status: 'running',
  agents: [
    {
      handle: '@frontend',
      bucket: 'in_progress',
      mission: 'Explore a clearer front page for the board.',
      approachGroup: 'front-page',
      approachLabel: 'plain-english',
      branch: null,
      lastPost: null,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      alive: true,
      exitCode: null,
    },
    {
      handle: '@backend',
      bucket: 'review',
      mission: 'Keep the data model simple for the new surface.',
      approachGroup: 'back-office',
      approachLabel: 'minimal-brief',
      branch: null,
      lastPost: null,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      alive: false,
      exitCode: 0,
    },
  ],
  createdAt: new Date().toISOString(),
};

function renderBar(overrides: Partial<ComponentProps<typeof ActionBar>> = {}) {
  const props: ComponentProps<typeof ActionBar> = {
    sprint,
    connected: true,
    onToggleChat: vi.fn(),
    chatOpen: false,
    onToggleAdvanced: vi.fn(),
    advancedOpen: false,
    ...overrides,
  };
  render(<ActionBar {...props} />);
  return props;
}

describe('ActionBar', () => {
  it('shows the sprint goal and English summary', () => {
    renderBar();
    expect(screen.getByText('Build the board')).toBeInTheDocument();
    expect(screen.getByText('2 routes are in play. 1 route is ready to compare.')).toBeInTheDocument();
  });

  it('shows summary pills for phase and ready routes', () => {
    renderBar();
    expect(screen.getByText('Exploring')).toBeInTheDocument();
    expect(screen.getByText('1 ready to compare')).toBeInTheDocument();
  });

  it('shows no active sprint when sprint is null', () => {
    renderBar({ sprint: null, connected: false });
    expect(screen.getByText('No active sprint')).toBeInTheDocument();
    expect(screen.getByText('Start a new sprint to explore a small set of clear routes.')).toBeInTheDocument();
  });

  it('shows connection status', () => {
    renderBar({ connected: true });
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('shows polling status when disconnected', () => {
    renderBar({ connected: false });
    expect(screen.getByText('Polling')).toBeInTheDocument();
  });

  it('lets the user toggle technical details and chat', () => {
    const onToggleChat = vi.fn();
    const onToggleAdvanced = vi.fn();
    renderBar({ onToggleChat, onToggleAdvanced });

    fireEvent.click(screen.getByRole('button', { name: 'Toggle technical details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle chat' }));

    expect(onToggleAdvanced).toHaveBeenCalledTimes(1);
    expect(onToggleChat).toHaveBeenCalledTimes(1);
  });
});
