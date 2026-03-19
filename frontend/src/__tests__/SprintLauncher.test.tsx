import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SprintLauncher } from '../components/SprintLauncher';
import { ToastProvider } from '../components/Toast';

function renderLauncher(props = {}) {
  const defaultProps = {
    onSwitchTab: vi.fn(),
    onClose: vi.fn(),
    ...props,
  };
  return render(
    <ToastProvider>
      <SprintLauncher {...defaultProps} />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SprintLauncher', () => {
  it('renders the clarity-first form', () => {
    renderLauncher();
    expect(screen.getByText('Start with a clear question')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Describe the outcome you want in plain English...')).toBeInTheDocument();
    expect(screen.getByText('Draft Routes')).toBeDisabled();
  });

  it('calls the suggest endpoint and renders route cards', async () => {
    const suggestion = {
      goal: 'Build things',
      tasks: [
        {
          agent: 'frontend',
          handle: '@frontend',
          mission: 'Build a cleaner interface brief.',
          scope: 'frontend/src/',
          approachLabel: 'plain-language',
          track: 'clarity',
        },
      ],
    };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => suggestion,
    } as Response);

    renderLauncher();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Build things' } });
    fireEvent.click(screen.getByText('Draft Routes'));

    await waitFor(() => {
      expect(screen.getByText('Suggested routes')).toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenCalledWith('/data/sprint/suggest', expect.objectContaining({
      method: 'POST',
    }));
    expect(screen.getByText('Build a cleaner interface brief.')).toBeInTheDocument();
    expect(screen.getByText('Plain Language')).toBeInTheDocument();
    expect(screen.getByText('Focus area: interface, product code')).toBeInTheDocument();
    expect(screen.queryByText('@frontend')).not.toBeInTheDocument();
  });

  it('calls the start endpoint on approve and returns to the board', async () => {
    const suggestion = {
      goal: 'Build things',
      tasks: [
        { agent: 'frontend', handle: '@frontend', mission: 'Build UI', scope: 'frontend/src/' },
      ],
    };
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => suggestion } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sprintName: 'Sprint-1', agents: [] }) } as Response);

    const onSwitchTab = vi.fn();
    renderLauncher({ onSwitchTab });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Build things' } });
    fireEvent.click(screen.getByText('Draft Routes'));

    await waitFor(() => {
      expect(screen.getByText('Start Sprint')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Start Sprint'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenNthCalledWith(2, '/data/sprint/start', expect.objectContaining({
        method: 'POST',
      }));
      expect(onSwitchTab).toHaveBeenCalledWith('board');
    });
  });

  it('calls onClose on cancel', () => {
    const onClose = vi.fn();
    renderLauncher({ onClose });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
