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
  track?: string | null;
  approachGroup?: string | null;
  approachLabel?: string | null;
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
  teamName?: string | null;
  status?: string;
  agents: AgentTile[];
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  mission: string;
  statusLabel: string;
  needsInputCount: number;
  ideaCount: number;
  activeSprintName: string | null;
  activeSprintGoal: string | null;
}

export interface ProjectCollaboratorAgent {
  handle: string;
  name: string;
  role: string;
  focus: string;
  status: string;
  recentActivity: string;
}

export interface ProjectCollaboratorMember {
  handle: string;
  name: string;
  role: string;
  permissions: string;
  recentActivity: string;
}

export interface ProjectCollaboratorsData {
  project: {
    id: string;
    name: string;
    mission: string;
    manager: string | null;
    statusLabel: string;
    activeSprintName: string | null;
  };
  activeAgents: ProjectCollaboratorAgent[];
  members: ProjectCollaboratorMember[];
}

export interface ProjectArchiveRecord {
  name: string;
  goal: string;
  statusLabel: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface ProjectArchiveData {
  project: {
    id: string;
    name: string;
    mission: string;
  };
  stats: {
    successRate: number;
    archivedCount: number;
    completedCount: number;
    failedCount: number;
  };
  featured: ProjectArchiveRecord | null;
  records: ProjectArchiveRecord[];
}

export interface ProjectToolSummary {
  name: string;
  scope: 'project' | 'global';
  status: string;
  note: string;
}

export interface ProjectPreferenceSummary {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface ProjectSettingsData {
  workspace: {
    id: string;
    name: string;
    mission: string;
    manager: string | null;
    statusLabel: string;
    activeSprintGoal: string | null;
    memberCount: number;
  };
  connectedTools: ProjectToolSummary[];
  preferences: ProjectPreferenceSummary[];
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
  track?: string | null;
  approachGroup?: string | null;
  approachLabel?: string | null;
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
  status: 'passed' | 'crashed' | 'running';
  branch: string | null;
  mission: string | null;
  track: string | null;
  approachGroup: string | null;
  approachLabel: string | null;
  testCount: number | null;
  commitCount: number;
  lastDagPushMessage: string | null;
  report?: {
    summary: string;
    hypothesis: string | null;
    reused: string | null;
    whyNotExistingCode: string | null;
    whySurvives: string | null;
    newFiles: string | null;
    architecture: string | null;
    dataFlow: string | null;
    edgeCases: string | null;
    tests: string | null;
  } | null;
}

export interface LandingBriefData {
  sprint: {
    name: string;
    goal: string;
    status: string;
  };
  agents: LandingBriefAgent[];
  summary: {
    passed: number;
    crashed: number;
    running: number;
    totalTests: number;
  };
  conflicts: string[];
  compression?: {
    status: string;
    beforeLines: number;
    afterLines: number;
    ratio: number;
    errorMessage: string | null;
    bypassReason: string | null;
  };
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

export type TabId =
  | 'projects'
  | 'board'
  | 'collaborators'
  | 'archive'
  | 'settings'
  | 'timeline'
  | 'logs'
  | 'architecture';

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
