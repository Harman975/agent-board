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
  it('renders the form', () => {
    renderLauncher();
    expect(screen.getByText('New Sprint')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Describe what you want to accomplish...')).toBeInTheDocument();
  });

  it('disables generate button when goal is empty', () => {
    renderLauncher();
    expect(screen.getByText('Generate Plan')).toBeDisabled();
  });

  it('calls suggest endpoint on generate', async () => {
    const suggestion = {
      goal: 'Build things',
      tasks: [
        { agent: 'frontend', handle: '@frontend', mission: 'Build UI', scope: 'frontend/src/' },
      ],
    };
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => suggestion,
    } as Response);

    renderLauncher();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Build things' } });
    fireEvent.click(screen.getByText('Generate Plan'));

    await waitFor(() => {
      expect(screen.getByText('Proposed Plan')).toBeInTheDocument();
    });
    expect(screen.getByText('@frontend')).toBeInTheDocument();
    expect(screen.getByText('Build UI')).toBeInTheDocument();
  });

  it('calls start endpoint on approve', async () => {
    const suggestion = {
      goal: 'Build things',
      tasks: [
        { agent: 'frontend', handle: '@frontend', mission: 'Build UI', scope: 'frontend/src/' },
      ],
    };
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => suggestion } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sprintName: 'Sprint-1', agents: [] }) } as Response);

    const onSwitchTab = vi.fn();
    renderLauncher({ onSwitchTab });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Build things' } });
    fireEvent.click(screen.getByText('Generate Plan'));

    await waitFor(() => {
      expect(screen.getByText('Approve & Start')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Approve & Start'));

    await waitFor(() => {
      expect(onSwitchTab).toHaveBeenCalledWith('kanban');
    });
  });

  it('calls onClose on cancel', () => {
    const onClose = vi.fn();
    renderLauncher({ onClose });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
