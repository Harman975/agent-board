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

export interface FeedPost {
  id: string;
  author: string;
  channel: string;
  content: string;
  created_at: string;
  parent_id: string | null;
}

export interface SprintTask {
  agent: string;
  handle: string;
  mission: string;
  scope: string;
}

export interface SprintSuggestion {
  goal: string;
  tasks: SprintTask[];
}

export interface SprintStartResult {
  sprintName: string;
  agents: { handle: string; pid: number; branch: string }[];
}

export interface LandingBriefAgent {
  handle: string;
  status: 'passed' | 'failed' | 'running';
  branch: string;
  testsPassed: number;
  testsFailed: number;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface LandingBriefData {
  agents: LandingBriefAgent[];
}

export type WSEventType =
  | 'bucket_changed'
  | 'post_created'
  | 'spawn_stopped'
  | 'initial_state'
  | 'log_line';

export interface WSEvent {
  type: WSEventType;
  data: Record<string, unknown>;
}

export type TabId = 'kanban' | 'feed' | 'logs' | 'architecture';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ImportGraphNode {
  id: string;
  file: string;
  size: number;
  agent?: string;
}

export interface ImportGraphEdge {
  source: string;
  target: string;
}

export interface ImportGraphData {
  nodes: ImportGraphNode[];
  edges: ImportGraphEdge[];
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

    case 'log_line':
      // Log lines are handled by the LogsPanel directly via WS subscription
      return state;

    default:
      return state;
  }
}
