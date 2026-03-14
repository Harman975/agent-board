import { describe, it, expect } from 'vitest';
import { applyWSEvent, SprintState, WSEvent } from '../types';

const baseSprint: SprintState = {
  name: 'Test Sprint',
  goal: 'Test goal',
  agents: [
    {
      handle: '@agent1',
      bucket: 'planning',
      mission: 'Do stuff',
      branch: null,
      lastPost: null,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      alive: true,
      exitCode: null,
    },
    {
      handle: '@agent2',
      bucket: 'in_progress',
      mission: 'Do other stuff',
      branch: 'feat/x',
      lastPost: null,
      additions: 10,
      deletions: 5,
      filesChanged: 3,
      alive: true,
      exitCode: null,
    },
  ],
  createdAt: '2026-03-14T00:00:00Z',
};

describe('applyWSEvent', () => {
  it('sets full state on initial_state', () => {
    const event: WSEvent = {
      type: 'initial_state',
      data: baseSprint as unknown as Record<string, unknown>,
    };
    const result = applyWSEvent(null, event);
    expect(result).toEqual(baseSprint);
  });

  it('updates bucket on bucket_changed', () => {
    const event: WSEvent = {
      type: 'bucket_changed',
      data: { handle: '@agent1', bucket: 'in_progress' },
    };
    const result = applyWSEvent(baseSprint, event);
    expect(result?.agents[0].bucket).toBe('in_progress');
    expect(result?.agents[1].bucket).toBe('in_progress');
  });

  it('updates lastPost on post_created', () => {
    const event: WSEvent = {
      type: 'post_created',
      data: { handle: '@agent1', content: 'Hello world' },
    };
    const result = applyWSEvent(baseSprint, event);
    expect(result?.agents[0].lastPost).toBe('Hello world');
    expect(result?.agents[1].lastPost).toBeNull();
  });

  it('marks agent as dead on spawn_stopped', () => {
    const event: WSEvent = {
      type: 'spawn_stopped',
      data: { handle: '@agent2', exitCode: 0 },
    };
    const result = applyWSEvent(baseSprint, event);
    expect(result?.agents[1].alive).toBe(false);
    expect(result?.agents[1].exitCode).toBe(0);
    expect(result?.agents[0].alive).toBe(true);
  });

  it('returns null state unchanged for events when state is null', () => {
    const event: WSEvent = {
      type: 'bucket_changed',
      data: { handle: '@agent1', bucket: 'done' },
    };
    expect(applyWSEvent(null, event)).toBeNull();
  });

  it('returns state unchanged for unknown event types', () => {
    const event = {
      type: 'unknown' as WSEvent['type'],
      data: {},
    };
    expect(applyWSEvent(baseSprint, event)).toBe(baseSprint);
  });
});
