import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabBar } from '../components/TabBar';

describe('TabBar', () => {
  it('renders all three tabs', () => {
    render(<TabBar activeTab="kanban" onTabChange={() => {}} />);
    expect(screen.getByText('Kanban')).toBeInTheDocument();
    expect(screen.getByText('Feed')).toBeInTheDocument();
    expect(screen.getByText('Logs')).toBeInTheDocument();
  });

  it('marks the active tab', () => {
    render(<TabBar activeTab="feed" onTabChange={() => {}} />);
    expect(screen.getByText('Feed')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Kanban')).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onTabChange when a tab is clicked', () => {
    const onChange = vi.fn();
    render(<TabBar activeTab="kanban" onTabChange={onChange} />);
    fireEvent.click(screen.getByText('Logs'));
    expect(onChange).toHaveBeenCalledWith('logs');
  });

  it('uses tablist role', () => {
    render(<TabBar activeTab="kanban" onTabChange={() => {}} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });
});
