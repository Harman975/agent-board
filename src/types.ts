export type AgentRole = "manager" | "worker";
export type AgentStatus = "active" | "idle" | "blocked" | "stopped";
export type PostType =
  | "update"
  | "route"
  | "decision"
  | "escalation"
  | "directive"
  | "abandoned"
  | "status";

export interface AgentStyle {
  approach?: "methodical" | "move-fast" | "research-heavy";
  risk_tolerance?: "low" | "medium" | "high";
  escalation_threshold?: "low" | "medium" | "high";
  reporting_style?: "concise" | "detailed" | "data-driven";
  team_size?: number;
  constraints?: string[];
}

export interface Agent {
  handle: string;
  name: string;
  role: AgentRole;
  team: string | null;
  mission: string;
  status: AgentStatus;
  style: AgentStyle;
  created_at: string;
}

export interface Post {
  id: string;
  author: string;
  content: string;
  type: PostType;
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

// Raw row types from SQLite (JSON fields as strings)
export interface AgentRow {
  handle: string;
  name: string;
  role: string;
  team: string | null;
  mission: string;
  status: string;
  style: string;
  created_at: string;
}

export interface PostRow {
  id: string;
  author: string;
  content: string;
  type: string;
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
