import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActionBar } from '../components/ActionBar';
import { SprintState } from '../types';

const sprint: SprintState = {
  name: 'Sprint Alpha',
  goal: 'Build the board',
  agents: [
    {
      handle: '@frontend',
      bucket: 'in_progress',
      mission: 'Build frontend',
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
      bucket: 'done',
      mission: 'Build backend',
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

describe('ActionBar', () => {
  it('shows sprint name', () => {
    render(<ActionBar sprint={sprint} connected={true} />);
    expect(screen.getByText('Sprint Alpha')).toBeInTheDocument();
  });

  it('shows agent counts per bucket', () => {
    render(<ActionBar sprint={sprint} connected={true} />);
    expect(screen.getByText('1 active')).toBeInTheDocument();
    expect(screen.getByText('1 done')).toBeInTheDocument();
    expect(screen.getByText('0 blocked')).toBeInTheDocument();
  });

  it('shows no active sprint when sprint is null', () => {
    render(<ActionBar sprint={null} connected={false} />);
    expect(screen.getByText('No active sprint')).toBeInTheDocument();
  });

  it('shows connection status', () => {
    render(<ActionBar sprint={sprint} connected={true} />);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('shows polling status when disconnected', () => {
    render(<ActionBar sprint={sprint} connected={false} />);
    expect(screen.getByText('Polling')).toBeInTheDocument();
  });
});
