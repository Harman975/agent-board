// === Foundation types ===

export type AgentStatus = "active" | "idle" | "blocked" | "stopped";

export type AgentRole = "manager" | "worker" | "solo";

export interface Agent {
  handle: string;
  name: string;
  role: AgentRole;
  mission: string;
  status: AgentStatus;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Channel {
  name: string;
  description: string | null;
  created_at: string;
}

export interface Post {
  id: string;
  author: string;
  channel: string;
  content: string;
  parent_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Commit {
  hash: string;
  post_id: string;
  files: string[];
  created_at: string;
}

export interface ApiKey {
  key_hash: string;
  agent_handle: string | null;
  created_at: string;
  revoked_at: string | null;
}

// === Supervision types ===

export interface ChannelPriority {
  channel_name: string;
  priority: number;
}

export interface Cursor {
  name: string;
  timestamp: string;
}

// === Raw row types (JSON fields as strings) ===

export interface AgentRow {
  handle: string;
  name: string;
  role: string;
  mission: string;
  status: string;
  metadata: string;
  created_at: string;
}

export interface PostRow {
  id: string;
  author: string;
  channel: string;
  content: string;
  parent_id: string | null;
  metadata: string;
  created_at: string;
}

export interface CommitRow {
  hash: string;
  post_id: string;
  files: string;
  created_at: string;
}

// Post with priority attached (for feed queries)
export interface RankedPost extends Post {
  priority: number;
}

// === M2 Org Structure types ===

export type TeamStatus = "exploring" | "building" | "blocked" | "done";
export type RouteStatus = "exploring" | "chosen" | "abandoned";

export interface Team {
  name: string;
  mission: string;
  manager: string;
  status: TeamStatus;
  created_at: string;
}

export interface TeamMember {
  team_name: string;
  agent_handle: string;
}

export interface Route {
  id: string;
  team_name: string;
  agent_handle: string;
  name: string;
  status: RouteStatus;
  created_at: string;
}

// === Identity types ===

export interface Identity {
  name: string;
  description: string;
  expertise: string[];
  vibe: string;
  content: string; // full markdown body
}

export interface IdentityFrontmatter {
  name: string;
  description: string;
  expertise?: string[];
  vibe?: string;
  emoji?: string;
  color?: string;
}

// === Sprint types ===

export interface SprintValidation {
  allStopped: boolean;
  testsPass: boolean;
  branches: SprintBranch[];
  conflicts: string[]; // files changed by multiple branches
  suggestedOrder: string[]; // agent handles in merge order
}

export interface SprintBranch {
  agent_handle: string;
  branch: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

// === DAG types ===

export interface DagCommit {
  hash: string;
  parent_hash: string | null;
  agent_handle: string;
  message: string;
  created_at: string;
}
