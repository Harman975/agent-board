import { describe, expect, it } from 'vitest';
import { buildBoardModel } from '../presentation';
import { LandingBriefData, SprintState } from '../types';

const sprint: SprintState = {
  name: 'Compiler Sprint',
  goal: 'Choose the clearest parser direction',
  status: 'running',
  createdAt: '2026-03-20T09:00:00Z',
  agents: [
    {
      handle: '@exploring',
      bucket: 'in_progress',
      mission: 'Try a Pratt parser for the first expression pass.',
      track: 'compiler',
      approachGroup: 'pratt-parser',
      approachLabel: 'pratt-parser',
      branch: 'agent/exploring',
      lastPost: 'Tokenizer handles precedence markers cleanly.',
      additions: 12,
      deletions: 2,
      filesChanged: 2,
      alive: true,
      exitCode: null,
    },
    {
      handle: '@blocked',
      bucket: 'blocked',
      mission: 'Compare middleware state and session state for auth.',
      track: 'auth',
      approachGroup: 'state-decision',
      approachLabel: 'state-decision',
      branch: 'agent/blocked',
      lastPost: 'Should auth state live in middleware or the session flow?',
      additions: 4,
      deletions: 1,
      filesChanged: 1,
      alive: true,
      exitCode: null,
    },
    {
      handle: '@ready',
      bucket: 'review',
      mission: 'This route reuses the current callback flow, but keeps the retained change smaller than the service split.',
      track: 'auth',
      approachGroup: 'callback-extension',
      approachLabel: 'callback-extension',
      branch: 'agent/ready',
      lastPost: '9 checks passed on the callback path.',
      additions: 14,
      deletions: 3,
      filesChanged: 2,
      alive: false,
      exitCode: 0,
    },
    {
      handle: '@winner',
      bucket: 'review',
      mission: 'Try the survivor route.',
      track: 'auth',
      approachGroup: 'winning-route',
      approachLabel: 'winning-route',
      branch: 'agent/winner',
      lastPost: '10 checks passed with the token exchange step.',
      additions: 22,
      deletions: 7,
      filesChanged: 3,
      alive: false,
      exitCode: 0,
    },
    {
      handle: '@discarded',
      bucket: 'review',
      mission: 'Try the heavier service split.',
      track: 'auth',
      approachGroup: 'service-split',
      approachLabel: 'service-split',
      branch: 'agent/discarded',
      lastPost: '8 checks ran before the route became unstable.',
      additions: 26,
      deletions: 5,
      filesChanged: 4,
      alive: false,
      exitCode: 1,
    },
  ],
};

const brief: LandingBriefData = {
  sprint: {
    name: 'Compiler Sprint',
    goal: 'Choose the clearest parser direction',
    status: 'ready',
  },
  summary: {
    passed: 1,
    crashed: 1,
    running: 0,
    totalTests: 18,
  },
  conflicts: [],
  compression: {
    status: 'ready',
    beforeLines: 120,
    afterLines: 72,
    ratio: 0.4,
    errorMessage: null,
    bypassReason: null,
  },
  agents: [
    {
      handle: '@winner',
      status: 'passed',
      branch: 'agent/winner',
      mission: 'Try the survivor route.',
      track: 'auth',
      approachGroup: 'winning-route',
      approachLabel: 'winning-route',
      testCount: 10,
      commitCount: 3,
      lastDagPushMessage: 'refine callback flow',
      report: {
        summary: 'This route keeps the callback flow small.',
        hypothesis: 'The callback path can handle the exchange step.',
        reused: 'The current callback and session checks.',
        whyNotExistingCode: 'The current flow stops before the token exchange completes.',
        whySurvives: 'It reuses the current callback flow and adds only the missing exchange step.',
        newFiles: null,
        architecture: null,
        dataFlow: null,
        edgeCases: null,
        tests: '10 checks passed with the new exchange step.',
      },
    },
    {
      handle: '@discarded',
      status: 'crashed',
      branch: 'agent/discarded',
      mission: 'Try the heavier service split.',
      track: 'auth',
      approachGroup: 'service-split',
      approachLabel: 'service-split',
      testCount: 8,
      commitCount: 2,
      lastDagPushMessage: 'prototype service split',
      report: {
        summary: 'This route centralizes auth before requests reach the handler.',
        hypothesis: 'A service split can simplify the handler layer.',
        reused: null,
        whyNotExistingCode: null,
        whySurvives: null,
        newFiles: null,
        architecture: null,
        dataFlow: null,
        edgeCases: null,
        tests: '8 checks ran before the route became unstable.',
      },
    },
  ],
};

describe('buildBoardModel', () => {
  it('synthesizes a compact card line for every bucket', () => {
    const board = buildBoardModel(sprint, brief);
    const tiles = new Map(board.columns.flatMap((column) => column.tiles.map((tile) => [tile.id, tile])));

    const exploring = tiles.get('pratt-parser');
    const blocked = tiles.get('state-decision');
    const ready = tiles.get('callback-extension');
    const winner = tiles.get('winning-route');
    const discarded = tiles.get('service-split');

    expect(exploring?.cardLine).toBe('Testing a Pratt parser for the first expression pass.');
    expect(blocked?.cardLine).toBe('Decide whether auth state should live in middleware or the session flow.');
    expect(ready?.cardLine).toBe('Reuses the current callback flow.');
    expect(winner?.cardLine).toMatch(/^Chosen because /);
    expect(discarded?.cardLine).toMatch(/^Dropped because /);

    for (const tile of [exploring, blocked, ready, winner, discarded]) {
      expect(tile?.cardLine.length ?? 0).toBeLessThanOrEqual(85);
    }
  });

  it('builds bucket-specific drawer sections and strips raw board labels', () => {
    const board = buildBoardModel(sprint, brief);
    const tiles = new Map(board.columns.flatMap((column) => column.tiles.map((tile) => [tile.id, tile])));

    const blocked = tiles.get('state-decision');
    const winner = tiles.get('winning-route');
    const discarded = tiles.get('service-split');

    expect(blocked?.drawerSections.map((section) => section.title)).toEqual([
      'Decision to make',
      'Why this choice matters',
      'What resumes after the decision',
    ]);
    expect(winner?.drawerSections.map((section) => section.title)).toContain('What it reuses');
    expect(discarded?.drawerSections.map((section) => section.title)).toEqual([
      'Why it was left behind',
      'What we learned',
      'What would need to change',
    ]);
    expect(winner?.drawerOverview).not.toContain('This route');
  });
});
