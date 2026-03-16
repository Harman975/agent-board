import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LogsPanel } from '../components/LogsPanel';
import { AgentTile } from '../types';

const agents: AgentTile[] = [
  {
    handle: '@frontend',
    bucket: 'in_progress',
    mission: 'Build frontend',
    branch: null,
    lastPost: null,
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    alive: true,
    exitCode: null,
  },
  {
    handle: '@backend',
    bucket: 'done',
    mission: 'Build backend',
    branch: null,
    lastPost: null,
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    alive: false,
    exitCode: 0,
  },
];

// Mock WebSocket
class MockWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('WebSocket', MockWebSocket);
});

describe('LogsPanel', () => {
  it('shows placeholder when no agent selected', () => {
    render(<LogsPanel agents={agents} />);
    expect(screen.getByText('Select an agent to view logs')).toBeInTheDocument();
  });

  it('renders agent options in dropdown', () => {
    render(<LogsPanel agents={agents} />);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3); // placeholder + 2 agents
    expect(options[1]).toHaveTextContent('@frontend');
    expect(options[2]).toHaveTextContent('@backend');
  });

  it('fetches logs when agent is selected', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ handle: '@frontend', log: ['line 1', 'line 2'] }),
    } as Response);

    render(<LogsPanel agents={agents} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '@frontend' } });

    await waitFor(() => {
      expect(screen.getByText('line 1')).toBeInTheDocument();
      expect(screen.getByText('line 2')).toBeInTheDocument();
    });
  });

  it('has terminal-style log area', () => {
    render(<LogsPanel agents={agents} />);
    expect(screen.getByRole('log')).toBeInTheDocument();
  });
});
