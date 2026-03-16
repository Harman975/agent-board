import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LandingBrief } from '../components/LandingBrief';
import { ToastProvider } from '../components/Toast';

const briefData = {
  agents: [
    {
      handle: '@frontend',
      status: 'passed',
      branch: 'agent/frontend',
      testsPassed: 10,
      testsFailed: 0,
      filesChanged: 5,
      additions: 200,
      deletions: 30,
    },
    {
      handle: '@backend',
      status: 'failed',
      branch: 'agent/backend',
      testsPassed: 8,
      testsFailed: 2,
      filesChanged: 3,
      additions: 100,
      deletions: 10,
    },
  ],
};

function renderBrief(props = {}) {
  const defaultProps = {
    sprintName: 'Sprint Alpha',
    onClose: vi.fn(),
    ...props,
  };
  return render(
    <ToastProvider>
      <LandingBrief {...defaultProps} />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('LandingBrief', () => {
  it('shows loading state', () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}));
    renderBrief();
    expect(screen.getByText('Loading brief...')).toBeInTheDocument();
  });

  it('renders agent data after fetch', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => briefData,
    } as Response);

    renderBrief();
    await waitFor(() => {
      expect(screen.getByText('@frontend')).toBeInTheDocument();
    });
    expect(screen.getByText('@backend')).toBeInTheDocument();
    expect(screen.getByText('10 passed')).toBeInTheDocument();
    expect(screen.getByText('2 failed')).toBeInTheDocument();
  });

  it('shows merge all passing button', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => briefData,
    } as Response);

    renderBrief();
    await waitFor(() => {
      expect(screen.getByText('Merge All Passing')).toBeInTheDocument();
    });
  });

  it('shows per-agent merge buttons', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => briefData,
    } as Response);

    renderBrief();
    await waitFor(() => {
      const mergeButtons = screen.getAllByText('Merge');
      expect(mergeButtons).toHaveLength(2);
    });
  });

  it('calls onClose when close is clicked', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
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
