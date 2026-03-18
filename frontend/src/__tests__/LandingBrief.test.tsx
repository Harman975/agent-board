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
    },
    {
      handle: '@backend',
      status: 'crashed',
      branch: 'agent/backend',
      mission: 'Try middleware-first validation',
      track: 'auth',
      approachGroup: 'oauth-flow',
      approachLabel: 'middleware-first',
      testCount: 8,
      commitCount: 2,
      lastDagPushMessage: 'prototype middleware route',
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
    expect(screen.getByText('Loading brief...')).toBeInTheDocument();
  });

  it('renders grouped sprint data after fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => briefData,
    } as Response);

    renderBrief();
    await waitFor(() => {
      expect(screen.getByText('Landing Brief: Sprint Alpha')).toBeInTheDocument();
    });

    expect(screen.getByText('auth: oauth-flow')).toBeInTheDocument();
    expect(screen.getByText('@frontend')).toBeInTheDocument();
    expect(screen.getByText('@backend')).toBeInTheDocument();
    expect(screen.getByText('token-exchange')).toBeInTheDocument();
    expect(screen.getByText('middleware-first')).toBeInTheDocument();
    expect(screen.getByText(/Synthesis: ready \(40% reduction\)/)).toBeInTheDocument();
  });

  it('shows a fallback when the brief cannot be loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
    } as Response);

    renderBrief();
    await waitFor(() => {
      expect(screen.getByText('Unable to load brief.')).toBeInTheDocument();
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
