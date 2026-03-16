import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ToastProvider, useToast } from '../components/Toast';

function TestComponent() {
  const { addToast } = useToast();
  return (
    <div>
      <button onClick={() => addToast('Success!', 'success')}>Show Success</button>
      <button onClick={() => addToast('Error!', 'error')}>Show Error</button>
    </div>
  );
}

describe('Toast', () => {
  it('renders toast on addToast call', () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );
    act(() => {
      screen.getByText('Show Success').click();
    });
    expect(screen.getByText('Success!')).toBeInTheDocument();
  });

  it('renders error toast', () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );
    act(() => {
      screen.getByText('Show Error').click();
    });
    expect(screen.getByText('Error!')).toBeInTheDocument();
  });

  it('auto-dismisses after 4 seconds', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );
    act(() => {
      screen.getByText('Show Success').click();
    });
    expect(screen.getByText('Success!')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByText('Success!')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('stacks multiple toasts', () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );
    act(() => {
      screen.getByText('Show Success').click();
      screen.getByText('Show Error').click();
    });
    expect(screen.getByText('Success!')).toBeInTheDocument();
    expect(screen.getByText('Error!')).toBeInTheDocument();
  });
});
