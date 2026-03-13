import type Database from "better-sqlite3";
import type { Agent, AgentRole, AgentRow, AgentStatus } from "./types.js";

function safeJsonParse(json: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function rowToAgent(row: AgentRow): Agent {
  return {
    ...row,
    role: (row.role ?? "solo") as AgentRole,
    status: row.status as AgentStatus,
    metadata: safeJsonParse(row.metadata),
  };
}

export function normalizeHandle(handle: string): string {
  return handle.startsWith("@") ? handle : `@${handle}`;
}

const HANDLE_PATTERN = /^@?[a-zA-Z0-9][a-zA-Z0-9-]*$/;

export function validateHandle(handle: string): void {
  if (!handle || !HANDLE_PATTERN.test(handle)) {
    throw new Error(
      `Invalid handle "${handle}": must be alphanumeric with hyphens only (e.g. @auth-mgr)`
    );
  }
  // Prevent excessively long handles (git branch name limit)
  const clean = handle.replace(/^@/, "");
  if (clean.length > 50) {
    throw new Error(`Handle too long (max 50 characters): "${handle}"`);
  }
}

export function createAgent(
  db: Database.Database,
  opts: {
    handle: string;
    name: string;
    role?: AgentRole;
    mission: string;
    metadata?: Record<string, unknown>;
  }
): Agent {
  validateHandle(opts.handle);
  const handle = normalizeHandle(opts.handle);

  const existing = db.prepare("SELECT handle FROM agents WHERE handle = ?").get(handle);
  if (existing) {
    throw new Error(`Agent ${handle} already exists`);
  }

  db.prepare(`
    INSERT INTO agents (handle, name, role, mission, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(handle, opts.name, opts.role ?? "solo", opts.mission, JSON.stringify(opts.metadata ?? {}));

  return getAgent(db, handle)!;
}

export function getAgent(db: Database.Database, handle: string): Agent | null {
  handle = normalizeHandle(handle);
  const row = db.prepare("SELECT * FROM agents WHERE handle = ?").get(handle) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function listAgents(
  db: Database.Database,
  opts?: { status?: AgentStatus }
): Agent[] {
  let sql = "SELECT * FROM agents WHERE 1=1";
  const params: unknown[] = [];

  if (opts?.status) {
    sql += " AND status = ?";
    params.push(opts.status);
  }

  sql += " ORDER BY created_at ASC";
  const rows = db.prepare(sql).all(...params) as AgentRow[];
  return rows.map(rowToAgent);
}

export function updateAgent(
  db: Database.Database,
  handle: string,
  updates: Partial<Pick<Agent, "name" | "role" | "mission" | "status" | "metadata">>
): Agent | null {
  handle = normalizeHandle(handle);

  const fields: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    params.push(updates.name);
  }
  if (updates.role !== undefined) {
    fields.push("role = ?");
    params.push(updates.role);
  }
  if (updates.mission !== undefined) {
    fields.push("mission = ?");
    params.push(updates.mission);
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    params.push(updates.status);
  }
  if (updates.metadata !== undefined) {
    fields.push("metadata = ?");
    params.push(JSON.stringify(updates.metadata));
  }

  if (fields.length === 0) return getAgent(db, handle);

  params.push(handle);
  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE handle = ?`).run(...params);

  return getAgent(db, handle);
}
