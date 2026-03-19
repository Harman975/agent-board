import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LandingBrief } from '../components/LandingBrief';

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

function renderBrief(props = {}) {
  const defaultProps = {
    sprintName: 'Sprint Alpha',
    onClose: vi.fn(),
    ...props,
  };
  return render(<LandingBrief {...defaultProps} />);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('LandingBrief', () => {
  it('shows loading state', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    renderBrief();
    expect(screen.getByText('Loading decision brief...')).toBeInTheDocument();
  });

  it('renders the decision brief after fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => briefData,
    } as Response);

    renderBrief();
    await waitFor(() => {
      expect(screen.getByText('Decision Brief')).toBeInTheDocument();
    });

    expect(screen.getByText('Explore auth approaches')).toBeInTheDocument();
    expect(screen.getByText('Token Exchange is the clearest route right now.')).toBeInTheDocument();
    expect(screen.getByText('The synthesis pass reduced the surviving change by 40%.')).toBeInTheDocument();
    expect(screen.getByText('What it reuses')).toBeInTheDocument();
    expect(screen.getByText('The current callback and session checks.')).toBeInTheDocument();
    expect(screen.getByText('Why the current code was not enough')).toBeInTheDocument();
    expect(screen.getByText('The current flow stops before the token exchange completes.')).toBeInTheDocument();
    expect(screen.getByText('Middleware First')).toBeInTheDocument();
    expect(screen.getByText('This route is not stable enough to keep yet.')).toBeInTheDocument();
  });

  it('shows a fallback when the brief cannot be loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
    } as Response);

    renderBrief();
    await waitFor(() => {
      expect(screen.getByText('Unable to load the decision brief.')).toBeInTheDocument();
    });
  });

  it('calls onClose when close is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => briefData,
    } as Response);

    const onClose = vi.fn();
    renderBrief({ onClose });
    await waitFor(() => {
      expect(screen.getByText('Close')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});
