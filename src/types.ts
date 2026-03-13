// === Foundation types ===

export type AgentStatus = "active" | "idle" | "blocked" | "stopped";

export interface Agent {
  handle: string;
  name: string;
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

// === DAG types ===

export interface DagCommit {
  hash: string;
  parent_hash: string | null;
  agent_handle: string;
  message: string;
  created_at: string;
}
