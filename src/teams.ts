import type Database from "better-sqlite3";
import type { Team, TeamMember, TeamStatus } from "./types.js";
import { normalizeHandle, validateHandle } from "./agents.js";

// === Team CRUD ===

export function createTeam(
  db: Database.Database,
  opts: { name: string; mission: string; manager: string }
): Team {
  const manager = normalizeHandle(opts.manager);
  validateHandle(opts.manager);

  if (!opts.name || opts.name.trim().length === 0) {
    throw new Error("Team name cannot be empty");
  }

  const existing = db.prepare("SELECT name FROM teams WHERE name = ?").get(opts.name);
  if (existing) {
    throw new Error(`Team "${opts.name}" already exists`);
  }

  db.prepare(`
    INSERT INTO teams (name, mission, manager)
    VALUES (?, ?, ?)
  `).run(opts.name, opts.mission, manager);

  return getTeam(db, opts.name)!;
}

export function getTeam(db: Database.Database, name: string): Team | null {
  const row = db.prepare("SELECT * FROM teams WHERE name = ?").get(name) as Team | undefined;
  return row ?? null;
}

export function listTeams(
  db: Database.Database,
  opts?: { status?: TeamStatus; manager?: string }
): Team[] {
  let sql = "SELECT * FROM teams WHERE 1=1";
  const params: unknown[] = [];

  if (opts?.status) {
    sql += " AND status = ?";
    params.push(opts.status);
  }
  if (opts?.manager) {
    sql += " AND manager = ?";
    params.push(normalizeHandle(opts.manager));
  }

  sql += " ORDER BY created_at ASC";
  return db.prepare(sql).all(...params) as Team[];
}

export function updateTeam(
  db: Database.Database,
  name: string,
  updates: Partial<Pick<Team, "mission" | "manager" | "status">>
): Team | null {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (updates.mission !== undefined) {
    fields.push("mission = ?");
    params.push(updates.mission);
  }
  if (updates.manager !== undefined) {
    validateHandle(updates.manager);
    fields.push("manager = ?");
    params.push(normalizeHandle(updates.manager));
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    params.push(updates.status);
  }

  if (fields.length === 0) return getTeam(db, name);

  params.push(name);
  db.prepare(`UPDATE teams SET ${fields.join(", ")} WHERE name = ?`).run(...params);

  return getTeam(db, name);
}

// === Team Member management ===

export function addMember(
  db: Database.Database,
  teamName: string,
  agentHandle: string
): TeamMember {
  validateHandle(agentHandle);
  const handle = normalizeHandle(agentHandle);

  const team = getTeam(db, teamName);
  if (!team) {
    throw new Error(`Team "${teamName}" does not exist`);
  }

  const existing = db
    .prepare("SELECT * FROM team_members WHERE team_name = ? AND agent_handle = ?")
    .get(teamName, handle);
  if (existing) {
    throw new Error(`Agent ${handle} is already a member of team "${teamName}"`);
  }

  db.prepare(`
    INSERT INTO team_members (team_name, agent_handle)
    VALUES (?, ?)
  `).run(teamName, handle);

  return { team_name: teamName, agent_handle: handle };
}

export function removeMember(
  db: Database.Database,
  teamName: string,
  agentHandle: string
): boolean {
  const handle = normalizeHandle(agentHandle);
  const result = db
    .prepare("DELETE FROM team_members WHERE team_name = ? AND agent_handle = ?")
    .run(teamName, handle);
  return result.changes > 0;
}

export function listMembers(
  db: Database.Database,
  teamName: string
): TeamMember[] {
  return db
    .prepare("SELECT * FROM team_members WHERE team_name = ? ORDER BY agent_handle ASC")
    .all(teamName) as TeamMember[];
}
