import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { AgentTile } from '../types';

function makeAgent(overrides: Partial<AgentTile> = {}): AgentTile {
  return {
    handle: '@test',
    bucket: 'planning',
    mission: 'Test a simpler route for the product.',
    track: 'clarity',
    branch: null,
    lastPost: null,
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    alive: true,
    exitCode: null,
    ...overrides,
  };
}

describe('KanbanBoard', () => {
  it('shows an empty-state message before a sprint starts', () => {
    render(<KanbanBoard agents={[]} />);
    expect(screen.getByText('No routes in play yet')).toBeInTheDocument();
    expect(screen.getByText('Once a sprint starts, the active routes will appear here in plain English.')).toBeInTheDocument();
  });

  it('renders option cards in plain English', () => {
    const agents: AgentTile[] = [
      makeAgent({
        handle: '@a',
        bucket: 'review',
        track: 'auth',
        approachGroup: 'oauth-flow',
        approachLabel: 'token-exchange',
        mission: 'Reuse the callback path and add token exchange.',
        lastPost: 'The current callback can carry most of the work.',
      }),
      makeAgent({
        handle: '@b',
        bucket: 'review',
        track: 'auth',
        approachGroup: 'oauth-flow',
        approachLabel: 'token-exchange',
        mission: 'Keep the callback route and validate the session edge cases.',
      }),
      makeAgent({
        handle: '@c',
        bucket: 'blocked',
        track: 'auth',
        approachGroup: 'middleware-flow',
        approachLabel: 'middleware-first',
        mission: 'Move validation into middleware before requests reach the route.',
      }),
    ];

    render(<KanbanBoard agents={agents} />);

    expect(screen.getByText('Token Exchange')).toBeInTheDocument();
    expect(screen.getByText('Middleware First')).toBeInTheDocument();
    expect(screen.getAllByText('Ready to compare').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Needs input').length).toBeGreaterThan(0);
    expect(screen.getByText('2 agents are carrying this route together.')).toBeInTheDocument();
    expect(screen.getByText('Latest signal')).toBeInTheDocument();
    expect(screen.getByText('The current callback can carry most of the work.')).toBeInTheDocument();
  });

  it('keeps the route description separate from the latest note', () => {
    const agents: AgentTile[] = [
      makeAgent({
        handle: '@route',
        bucket: 'in_progress',
        approachGroup: 'dashboard',
        approachLabel: 'plain-language',
        mission: 'Describe the work in plain English instead of raw system terms.',
        lastPost: 'The header now reads like a decision brief.',
      }),
    ];

    render(<KanbanBoard agents={agents} />);

    expect(screen.getByText('Describe the work in plain English instead of raw system terms.')).toBeInTheDocument();
    expect(screen.getByText('Latest signal')).toBeInTheDocument();
    expect(screen.getByText('The header now reads like a decision brief.')).toBeInTheDocument();
  });
});
