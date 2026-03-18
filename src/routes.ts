import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { Route, RouteStatus } from "./types.js";
import { normalizeHandle, validateHandle } from "./agents.js";

export function createRoute(
  db: Database.Database,
  opts: { team_name: string; agent_handle: string; name: string }
): Route {
  validateHandle(opts.agent_handle);
  const handle = normalizeHandle(opts.agent_handle);
  const id = randomUUID();

  const team = db.prepare("SELECT name FROM teams WHERE name = ?").get(opts.team_name);
  if (!team) {
    throw new Error(`Team "${opts.team_name}" does not exist`);
  }

  if (!opts.name || opts.name.trim().length === 0) {
    throw new Error("Route name cannot be empty");
  }

  db.prepare(`
    INSERT INTO routes (id, team_name, agent_handle, name)
    VALUES (?, ?, ?, ?)
  `).run(id, opts.team_name, handle, opts.name);

  return getRoute(db, id)!;
}

function getRoute(db: Database.Database, id: string): Route | null {
  const row = db.prepare("SELECT * FROM routes WHERE id = ?").get(id) as Route | undefined;
  return row ?? null;
}

export function listRoutes(
  db: Database.Database,
  opts?: { status?: RouteStatus; agent_handle?: string; team_name?: string }
): Route[] {
  let sql = "SELECT * FROM routes WHERE 1=1";
  const params: unknown[] = [];

  if (opts?.status) {
    sql += " AND status = ?";
    params.push(opts.status);
  }
  if (opts?.agent_handle) {
    sql += " AND agent_handle = ?";
    params.push(normalizeHandle(opts.agent_handle));
  }
  if (opts?.team_name) {
    sql += " AND team_name = ?";
    params.push(opts.team_name);
  }

  sql += " ORDER BY created_at ASC";
  return db.prepare(sql).all(...params) as Route[];
}

export function updateRoute(
  db: Database.Database,
  id: string,
  updates: Partial<Pick<Route, "name" | "status">>
): Route | null {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    params.push(updates.name);
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    params.push(updates.status);
  }

  if (fields.length === 0) return getRoute(db, id);

  params.push(id);
  db.prepare(`UPDATE routes SET ${fields.join(", ")} WHERE id = ?`).run(...params);

  return getRoute(db, id);
}

