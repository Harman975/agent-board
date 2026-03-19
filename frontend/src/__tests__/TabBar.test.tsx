import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabBar } from '../components/TabBar';

describe('TabBar', () => {
  it('renders the primary board-first tabs', () => {
    render(<TabBar activeTab="board" onTabChange={() => {}} advancedMode={false} />);
    expect(screen.getByText('Board')).toBeInTheDocument();
    expect(screen.getByText('Timeline')).toBeInTheDocument();
    expect(screen.queryByText('Logs')).not.toBeInTheDocument();
  });

  it('marks the active tab', () => {
    render(<TabBar activeTab="timeline" onTabChange={() => {}} advancedMode={false} />);
    expect(screen.getByText('Timeline')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Board')).toHaveAttribute('aria-selected', 'false');
  });

  it('renders technical tabs in advanced mode', () => {
    render(<TabBar activeTab="logs" onTabChange={() => {}} advancedMode={true} />);
    expect(screen.getByText('Logs')).toBeInTheDocument();
    expect(screen.getByText('Architecture')).toBeInTheDocument();
  });

  it('calls onTabChange when a tab is clicked', () => {
    const onChange = vi.fn();
    render(<TabBar activeTab="board" onTabChange={onChange} advancedMode={true} />);
    fireEvent.click(screen.getByText('Logs'));
    expect(onChange).toHaveBeenCalledWith('logs');
  });

  it('uses tablist role', () => {
    render(<TabBar activeTab="board" onTabChange={() => {}} advancedMode={false} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });
});
