import type Database from "better-sqlite3";
import type { Agent, AgentRole, AgentRow, AgentStatus, AgentStyle } from "./types.js";

function rowToAgent(row: AgentRow): Agent {
  return {
    ...row,
    role: row.role as AgentRole,
    status: row.status as AgentStatus,
    style: JSON.parse(row.style) as AgentStyle,
  };
}

function normalizeHandle(handle: string): string {
  return handle.startsWith("@") ? handle : `@${handle}`;
}

export function createAgent(
  db: Database.Database,
  opts: {
    handle: string;
    name: string;
    role: AgentRole;
    mission: string;
    team?: string;
    style?: AgentStyle;
  }
): Agent {
  const handle = normalizeHandle(opts.handle);

  const stmt = db.prepare(`
    INSERT INTO agents (handle, name, role, team, mission, style)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    handle,
    opts.name,
    opts.role,
    opts.team ?? null,
    opts.mission,
    JSON.stringify(opts.style ?? {})
  );

  return getAgent(db, handle)!;
}

export function getAgent(db: Database.Database, handle: string): Agent | null {
  handle = normalizeHandle(handle);
  const row = db.prepare("SELECT * FROM agents WHERE handle = ?").get(handle) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function listAgents(
  db: Database.Database,
  opts?: { role?: AgentRole; status?: AgentStatus; team?: string }
): Agent[] {
  let sql = "SELECT * FROM agents WHERE 1=1";
  const params: unknown[] = [];

  if (opts?.role) {
    sql += " AND role = ?";
    params.push(opts.role);
  }
  if (opts?.status) {
    sql += " AND status = ?";
    params.push(opts.status);
  }
  if (opts?.team) {
    sql += " AND team = ?";
    params.push(opts.team);
  }

  sql += " ORDER BY created_at ASC";

  const rows = db.prepare(sql).all(...params) as AgentRow[];
  return rows.map(rowToAgent);
}

export function updateAgent(
  db: Database.Database,
  handle: string,
  updates: Partial<Pick<Agent, "name" | "mission" | "status" | "team" | "style">>
): Agent | null {
  handle = normalizeHandle(handle);

  const fields: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    params.push(updates.name);
  }
  if (updates.mission !== undefined) {
    fields.push("mission = ?");
    params.push(updates.mission);
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    params.push(updates.status);
  }
  if (updates.team !== undefined) {
    fields.push("team = ?");
    params.push(updates.team);
  }
  if (updates.style !== undefined) {
    fields.push("style = ?");
    params.push(JSON.stringify(updates.style));
  }

  if (fields.length === 0) return getAgent(db, handle);

  params.push(handle);
  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE handle = ?`).run(...params);

  return getAgent(db, handle);
}
