import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FeedPanel } from '../components/FeedPanel';

function makePosts() {
  const now = Date.now();
  return [
    {
      id: '1',
      author: '@frontend',
      channel: '#work',
      content: 'Built the tabs',
      created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      parent_id: null,
    },
    {
      id: '2',
      author: '@backend',
      channel: '#escalations',
      content: 'Need help with DB',
      created_at: new Date(now - 60 * 60 * 1000).toISOString(),
      parent_id: null,
    },
  ];
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('FeedPanel', () => {
  it('shows loading state initially', () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}));
    render(<FeedPanel />);
    expect(screen.getByText('Loading timeline...')).toBeInTheDocument();
  });

  it('renders a narrative timeline after fetch', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => makePosts(),
    } as Response);

    render(<FeedPanel />);

    await waitFor(() => {
      expect(screen.getByText('What the sprint has learned so far')).toBeInTheDocument();
    });

    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.getByText('Shared progress: Built the tabs')).toBeInTheDocument();
    expect(screen.getByText('Asked for input: Need help with DB')).toBeInTheDocument();
    expect(screen.getByText('Progress')).toBeInTheDocument();
    expect(screen.getByText('Needs input')).toBeInTheDocument();
    expect(screen.getByText('2h ago')).toBeInTheDocument();
    expect(screen.getByText('1h ago')).toBeInTheDocument();
  });

  it('shows empty state when no posts are returned', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    render(<FeedPanel />);

    await waitFor(() => {
      expect(screen.getByText('No learning updates yet.')).toBeInTheDocument();
    });
  });

  it('requests the feed endpoint once on load', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    render(<FeedPanel />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/feed?limit=100');
    });
  });
});
