import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BoardPanel } from '../components/BoardPanel';
import { SprintState } from '../types';

const sprint: SprintState = {
  name: 'Sprint Alpha',
  goal: 'Explore auth approaches',
  status: 'ready',
  createdAt: '2026-03-19T10:00:00Z',
  agents: [
    {
      handle: '@frontend',
      bucket: 'review',
      mission: 'Try a token exchange flow.',
      track: 'auth',
      approachGroup: 'oauth-flow',
      approachLabel: 'token-exchange',
      branch: 'agent/frontend',
      lastPost: '10 checks passed with the new exchange step.',
      additions: 20,
      deletions: 8,
      filesChanged: 3,
      alive: false,
      exitCode: 0,
    },
    {
      handle: '@backend',
      bucket: 'review',
      mission: 'Try middleware-first validation.',
      track: 'auth',
      approachGroup: 'middleware-flow',
      approachLabel: 'middleware-first',
      branch: 'agent/backend',
      lastPost: '8 checks ran before the route became unstable.',
      additions: 16,
      deletions: 4,
      filesChanged: 2,
      alive: false,
      exitCode: 1,
    },
  ],
};

const briefData = {
  sprint: {
    name: 'Sprint Alpha',
    goal: 'Explore auth approaches',
    status: 'ready',
  },
  summary: {
    passed: 1,
    crashed: 1,
    running: 0,
    totalTests: 18,
  },
  conflicts: [],
  compression: {
    status: 'ready',
    beforeLines: 120,
    afterLines: 72,
    ratio: 0.4,
    errorMessage: null,
    bypassReason: null,
  },
  agents: [
    {
      handle: '@frontend',
      status: 'passed',
      branch: 'agent/frontend',
      mission: 'Try a token exchange flow',
      track: 'auth',
      approachGroup: 'oauth-flow',
      approachLabel: 'token-exchange',
      testCount: 10,
      commitCount: 3,
      lastDagPushMessage: 'refine callback flow',
      report: {
        summary: 'This route keeps the callback flow small.',
        hypothesis: 'The callback path can handle the exchange step.',
        reused: 'The current callback and session checks.',
        whyNotExistingCode: 'The current flow stops before the token exchange completes.',
        whySurvives: 'It reuses the current callback flow and adds only the missing exchange step.',
        newFiles: null,
        architecture: null,
        dataFlow: null,
        edgeCases: null,
        tests: '10 checks passed with the new exchange step.',
      },
    },
    {
      handle: '@backend',
      status: 'crashed',
      branch: 'agent/backend',
      mission: 'Try middleware-first validation',
      track: 'auth',
      approachGroup: 'middleware-flow',
      approachLabel: 'middleware-first',
      testCount: 8,
      commitCount: 2,
      lastDagPushMessage: 'prototype middleware route',
      report: {
        summary: 'This route centralizes validation before requests reach the handler.',
        hypothesis: 'Middleware can simplify the handler layer.',
        reused: null,
        whyNotExistingCode: null,
        whySurvives: null,
        newFiles: null,
        architecture: null,
        dataFlow: null,
        edgeCases: null,
        tests: '8 checks ran before the route became unstable.',
      },
    },
  ],
};

describe('BoardPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the empty state when there is no sprint', () => {
    render(<BoardPanel sprint={null} />);
    expect(screen.getByText('No active sprint')).toBeInTheDocument();
  });

  it('renders a route-first board and opens a detail drawer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => briefData,
    } as Response);

    render(<BoardPanel sprint={sprint} />);

    await waitFor(() => {
      expect(screen.getByText('Explore auth approaches')).toBeInTheDocument();
    });

    expect(screen.getByText('Survives')).toBeInTheDocument();
    expect(screen.getByText('Discarded for now')).toBeInTheDocument();
    expect(screen.getByText('Token Exchange')).toBeInTheDocument();
    expect(screen.getByText('Middleware First')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Token Exchange/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Token Exchange details')).toBeInTheDocument();
    });

    expect(screen.getByText('Why the current code is not enough')).toBeInTheDocument();
    expect(screen.getByText('The current flow stops before the token exchange completes.')).toBeInTheDocument();
    expect(screen.getByText('What it reuses')).toBeInTheDocument();
    expect(screen.getByText('The current callback and session checks.')).toBeInTheDocument();
  });
});
