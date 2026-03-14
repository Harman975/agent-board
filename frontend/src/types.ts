export type BucketState =
  | 'planning'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done';

export interface AgentTile {
  handle: string;
  bucket: BucketState;
  mission: string;
  branch: string | null;
  lastPost: string | null;
  additions: number;
  deletions: number;
  filesChanged: number;
  alive: boolean;
  exitCode: number | null;
}

export interface SprintState {
  name: string;
  goal: string;
  agents: AgentTile[];
  createdAt: string;
}

export type WSEventType =
  | 'bucket_changed'
  | 'post_created'
  | 'spawn_stopped'
  | 'initial_state';

export interface WSEvent {
  type: WSEventType;
  data: Record<string, unknown>;
}

export function applyWSEvent(
  state: SprintState | null,
  event: WSEvent
): SprintState | null {
  switch (event.type) {
    case 'initial_state':
      return event.data as unknown as SprintState;

    case 'bucket_changed': {
      if (!state) return state;
      const { handle, bucket } = event.data as {
        handle: string;
        bucket: BucketState;
      };
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.handle === handle ? { ...a, bucket } : a
        ),
      };
    }

    case 'post_created': {
      if (!state) return state;
      const { handle, content } = event.data as {
        handle: string;
        content: string;
      };
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.handle === handle ? { ...a, lastPost: content } : a
        ),
      };
    }

    case 'spawn_stopped': {
      if (!state) return state;
      const { handle, exitCode } = event.data as {
        handle: string;
        exitCode: number;
      };
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.handle === handle
            ? { ...a, alive: false, exitCode }
            : a
        ),
      };
    }

    default:
      return state;
  }
}
