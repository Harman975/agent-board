import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { FeedPanel } from '../components/FeedPanel';

const mockPosts = [
  {
    id: '1',
    author: '@frontend',
    channel: '#work',
    content: 'Built the tabs',
    created_at: '2026-03-16T10:00:00Z',
    parent_id: null,
  },
  {
    id: '2',
    author: '@backend',
    channel: '#escalations',
    content: 'Need help with DB',
    created_at: '2026-03-16T11:00:00Z',
    parent_id: null,
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('FeedPanel', () => {
  it('shows loading state initially', () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<FeedPanel />);
    expect(screen.getByText('Loading feed...')).toBeInTheDocument();
  });

  it('renders posts after fetch', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockPosts,
    } as Response);

    render(<FeedPanel />);
    await waitFor(() => {
      expect(screen.getByText('Built the tabs')).toBeInTheDocument();
    });
    expect(screen.getByText('Need help with DB')).toBeInTheDocument();
  });

  it('shows empty state when no posts', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    render(<FeedPanel />);
    await waitFor(() => {
      expect(screen.getByText('No posts found')).toBeInTheDocument();
    });
  });

  it('filters by channel', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockPosts,
    } as Response);

    render(<FeedPanel />);
    await waitFor(() => {
      expect(screen.getByText('Built the tabs')).toBeInTheDocument();
    });

    const channelSelect = screen.getAllByRole('combobox')[0];
    fireEvent.change(channelSelect, { target: { value: '#escalations' } });

    expect(screen.queryByText('Built the tabs')).not.toBeInTheDocument();
    expect(screen.getByText('Need help with DB')).toBeInTheDocument();
  });

  it('filters by author', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockPosts,
    } as Response);

    render(<FeedPanel />);
    await waitFor(() => {
      expect(screen.getByText('Built the tabs')).toBeInTheDocument();
    });

    const authorSelect = screen.getAllByRole('combobox')[1];
    fireEvent.change(authorSelect, { target: { value: '@backend' } });

    expect(screen.queryByText('Built the tabs')).not.toBeInTheDocument();
    expect(screen.getByText('Need help with DB')).toBeInTheDocument();
  });
});
