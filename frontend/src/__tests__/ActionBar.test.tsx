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
    activeTab: 'board',
    onTabChange: vi.fn(),
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
  it('shows the brand name', () => {
    renderBar();
    expect(screen.getByText('Cognitive Canvas')).toBeInTheDocument();
  });

  it('shows navigation tabs', () => {
    renderBar();
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Timeline' })).toBeInTheDocument();
  });

  it('marks the active tab', () => {
    renderBar({ activeTab: 'timeline' });
    const timelineTab = screen.getByRole('tab', { name: 'Timeline' });
    expect(timelineTab.classList.contains('active')).toBe(true);
  });

  it('fires onTabChange when a tab is clicked', () => {
    const onTabChange = vi.fn();
    renderBar({ onTabChange });
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(onTabChange).toHaveBeenCalledWith('timeline');
  });

  it('shows technical tabs only when advancedOpen is true', () => {
    renderBar({ advancedOpen: false });
    expect(screen.queryByRole('tab', { name: 'Logs' })).not.toBeInTheDocument();

    renderBar({ advancedOpen: true });
    expect(screen.getByRole('tab', { name: 'Logs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Architecture' })).toBeInTheDocument();
  });

  it('shows phase status when sprint is active', () => {
    renderBar();
    expect(screen.getByText('Exploring')).toBeInTheDocument();
  });

  it('shows connection status when no sprint', () => {
    renderBar({ sprint: null, connected: true });
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('shows polling status when disconnected and no sprint', () => {
    renderBar({ sprint: null, connected: false });
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
