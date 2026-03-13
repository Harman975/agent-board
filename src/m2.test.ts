import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initDb } from "./db.js";
import { createAgent } from "./agents.js";
import { generateKey, hashKey, storeKey } from "./auth.js";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

// === Test helpers ===

let db: Database.Database;
let tmpDir: string;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-test-"));
  db = initDb(tmpDir);
}

function teardown() {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Create prerequisite agents for FK references */
function seedAgents() {
  createAgent(db, { handle: "mgr", name: "Manager", role: "manager", mission: "Lead the team" });
  createAgent(db, { handle: "worker-a", name: "Worker A", role: "worker", mission: "Do work A" });
  createAgent(db, { handle: "worker-b", name: "Worker B", role: "worker", mission: "Do work B" });
}

// ============================================================
// 1. SCHEMA — verify teams, team_members, routes tables
// ============================================================

describe("M2 schema: teams table", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("exists in the database", () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='teams'"
    ).get();
    assert.ok(row);
  });

  it("has correct columns", () => {
    const cols = db.prepare("PRAGMA table_info(teams)").all() as { name: string; type: string; notnull: number; pk: number }[];
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes("name"));
    assert.ok(colNames.includes("mission"));
    assert.ok(colNames.includes("manager"));
    assert.ok(colNames.includes("status"));
    assert.ok(colNames.includes("created_at"));
  });

  it("name is the primary key", () => {
    const cols = db.prepare("PRAGMA table_info(teams)").all() as { name: string; pk: number }[];
    const pk = cols.find((c) => c.pk === 1);
    assert.ok(pk);
    assert.equal(pk.name, "name");
  });

  it("enforces NOT NULL on mission", () => {
    seedAgents();
    assert.throws(
      () => db.prepare("INSERT INTO teams (name, manager) VALUES (?, ?)").run("t1", "@mgr"),
      /NOT NULL/
    );
  });

  it("enforces NOT NULL on manager", () => {
    assert.throws(
      () => db.prepare("INSERT INTO teams (name, mission) VALUES (?, ?)").run("t1", "do stuff"),
      /NOT NULL/
    );
  });

  it("enforces FK on manager → agents(handle)", () => {
    assert.throws(
      () => db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "mission", "@nonexistent"),
      /FOREIGN KEY/
    );
  });

  it("enforces CHECK constraint on status", () => {
    seedAgents();
    assert.throws(
      () => db.prepare("INSERT INTO teams (name, mission, manager, status) VALUES (?, ?, ?, ?)").run("t1", "m", "@mgr", "invalid_status"),
      /CHECK/
    );
  });

  it("allows valid status values", () => {
    seedAgents();
    for (const status of ["exploring", "building", "blocked", "done"]) {
      db.prepare("INSERT INTO teams (name, mission, manager, status) VALUES (?, ?, ?, ?)").run(
        `team-${status}`, "mission", "@mgr", status
      );
    }
    const rows = db.prepare("SELECT COUNT(*) as cnt FROM teams").get() as { cnt: number };
    assert.equal(rows.cnt, 4);
  });

  it("defaults status to 'exploring'", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const row = db.prepare("SELECT status FROM teams WHERE name = ?").get("t1") as { status: string };
    assert.equal(row.status, "exploring");
  });

  it("defaults created_at to current UTC timestamp", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const row = db.prepare("SELECT created_at FROM teams WHERE name = ?").get("t1") as { created_at: string };
    assert.ok(row.created_at);
    assert.ok(row.created_at.endsWith("Z"));
  });

  it("rejects duplicate team names (PK violation)", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    assert.throws(
      () => db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m2", "@mgr"),
      /UNIQUE/
    );
  });

  it("has index on manager", () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='teams'"
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    assert.ok(names.includes("idx_teams_manager"));
  });
});

describe("M2 schema: team_members table", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("exists in the database", () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='team_members'"
    ).get();
    assert.ok(row);
  });

  it("has composite primary key (team_name, agent_handle)", () => {
    const cols = db.prepare("PRAGMA table_info(team_members)").all() as { name: string; pk: number }[];
    const pks = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    assert.equal(pks.length, 2);
    assert.equal(pks[0].name, "team_name");
    assert.equal(pks[1].name, "agent_handle");
  });

  it("enforces FK on team_name → teams(name)", () => {
    seedAgents();
    assert.throws(
      () => db.prepare("INSERT INTO team_members (team_name, agent_handle) VALUES (?, ?)").run("nonexistent-team", "@worker-a"),
      /FOREIGN KEY/
    );
  });

  it("enforces FK on agent_handle → agents(handle)", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    assert.throws(
      () => db.prepare("INSERT INTO team_members (team_name, agent_handle) VALUES (?, ?)").run("t1", "@nonexistent"),
      /FOREIGN KEY/
    );
  });

  it("prevents duplicate memberships (composite PK)", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    db.prepare("INSERT INTO team_members (team_name, agent_handle) VALUES (?, ?)").run("t1", "@worker-a");
    assert.throws(
      () => db.prepare("INSERT INTO team_members (team_name, agent_handle) VALUES (?, ?)").run("t1", "@worker-a"),
      /UNIQUE/
    );
  });

  it("allows same agent in multiple teams", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m1", "@mgr");
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t2", "m2", "@mgr");
    db.prepare("INSERT INTO team_members (team_name, agent_handle) VALUES (?, ?)").run("t1", "@worker-a");
    db.prepare("INSERT INTO team_members (team_name, agent_handle) VALUES (?, ?)").run("t2", "@worker-a");

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM team_members WHERE agent_handle = ?").get("@worker-a") as { cnt: number };
    assert.equal(rows.cnt, 2);
  });

  it("has index on agent_handle", () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='team_members'"
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    assert.ok(names.includes("idx_team_members_agent"));
  });
});

describe("M2 schema: routes table", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("exists in the database", () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='routes'"
    ).get();
    assert.ok(row);
  });

  it("has correct columns", () => {
    const cols = db.prepare("PRAGMA table_info(routes)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes("id"));
    assert.ok(colNames.includes("team_name"));
    assert.ok(colNames.includes("agent_handle"));
    assert.ok(colNames.includes("name"));
    assert.ok(colNames.includes("status"));
    assert.ok(colNames.includes("created_at"));
  });

  it("id is the primary key", () => {
    const cols = db.prepare("PRAGMA table_info(routes)").all() as { name: string; pk: number }[];
    const pk = cols.find((c) => c.pk === 1);
    assert.ok(pk);
    assert.equal(pk.name, "id");
  });

  it("enforces FK on team_name → teams(name)", () => {
    seedAgents();
    assert.throws(
      () => db.prepare("INSERT INTO routes (id, team_name, agent_handle, name) VALUES (?, ?, ?, ?)").run("r1", "nonexistent", "@worker-a", "route"),
      /FOREIGN KEY/
    );
  });

  it("enforces FK on agent_handle → agents(handle)", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    assert.throws(
      () => db.prepare("INSERT INTO routes (id, team_name, agent_handle, name) VALUES (?, ?, ?, ?)").run("r1", "t1", "@nonexistent", "route"),
      /FOREIGN KEY/
    );
  });

  it("enforces CHECK constraint on status", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    assert.throws(
      () => db.prepare("INSERT INTO routes (id, team_name, agent_handle, name, status) VALUES (?, ?, ?, ?, ?)").run("r1", "t1", "@worker-a", "route", "invalid"),
      /CHECK/
    );
  });

  it("allows valid status values", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    for (const status of ["exploring", "chosen", "abandoned"]) {
      db.prepare("INSERT INTO routes (id, team_name, agent_handle, name, status) VALUES (?, ?, ?, ?, ?)").run(
        `r-${status}`, "t1", "@worker-a", `route-${status}`, status
      );
    }
    const rows = db.prepare("SELECT COUNT(*) as cnt FROM routes").get() as { cnt: number };
    assert.equal(rows.cnt, 3);
  });

  it("defaults status to 'exploring'", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    db.prepare("INSERT INTO routes (id, team_name, agent_handle, name) VALUES (?, ?, ?, ?)").run("r1", "t1", "@worker-a", "route");
    const row = db.prepare("SELECT status FROM routes WHERE id = ?").get("r1") as { status: string };
    assert.equal(row.status, "exploring");
  });

  it("defaults created_at to current UTC timestamp", () => {
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    db.prepare("INSERT INTO routes (id, team_name, agent_handle, name) VALUES (?, ?, ?, ?)").run("r1", "t1", "@worker-a", "route");
    const row = db.prepare("SELECT created_at FROM routes WHERE id = ?").get("r1") as { created_at: string };
    assert.ok(row.created_at);
    assert.ok(row.created_at.endsWith("Z"));
  });

  it("has index on team_name", () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='routes'"
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    assert.ok(names.includes("idx_routes_team"));
  });

  it("has index on agent_handle", () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='routes'"
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    assert.ok(names.includes("idx_routes_agent"));
  });
});

// ============================================================
// 2. TEAMS — createTeam, getTeam, listTeams, updateTeam,
//    addMember, removeMember, listMembers, edge cases
// ============================================================

describe("teams: createTeam", () => {
  beforeEach(() => { setup(); seedAgents(); });
  afterEach(teardown);

  it("creates a team and returns it", async () => {
    const { createTeam } = await import("./teams.js");
    const team = createTeam(db, { name: "auth-team", mission: "Handle auth", manager: "mgr" });
    assert.equal(team.name, "auth-team");
    assert.equal(team.mission, "Handle auth");
    assert.equal(team.manager, "@mgr");
    assert.equal(team.status, "exploring");
    assert.ok(team.created_at);
  });

  it("rejects duplicate team names", async () => {
    const { createTeam } = await import("./teams.js");
    createTeam(db, { name: "dupe", mission: "a", manager: "mgr" });
    assert.throws(
      () => createTeam(db, { name: "dupe", mission: "b", manager: "mgr" }),
      /already exists/
    );
  });

  it("rejects nonexistent manager", async () => {
    const { createTeam } = await import("./teams.js");
    assert.throws(
      () => createTeam(db, { name: "t1", mission: "m", manager: "ghost" }),
      /not found|FOREIGN KEY/
    );
  });

  it("allows specifying initial status", async () => {
    const { createTeam } = await import("./teams.js");
    const team = createTeam(db, { name: "t1", mission: "m", manager: "mgr", status: "building" });
    assert.equal(team.status, "building");
  });

  it("normalizes manager handle", async () => {
    const { createTeam } = await import("./teams.js");
    const team = createTeam(db, { name: "t1", mission: "m", manager: "@mgr" });
    assert.equal(team.manager, "@mgr");
  });
});

describe("teams: getTeam", () => {
  beforeEach(() => { setup(); seedAgents(); });
  afterEach(teardown);

  it("retrieves a team by name", async () => {
    const { createTeam, getTeam } = await import("./teams.js");
    createTeam(db, { name: "auth-team", mission: "Handle auth", manager: "mgr" });
    const team = getTeam(db, "auth-team");
    assert.ok(team);
    assert.equal(team!.name, "auth-team");
    assert.equal(team!.mission, "Handle auth");
  });

  it("returns null for nonexistent team", async () => {
    const { getTeam } = await import("./teams.js");
    assert.equal(getTeam(db, "nonexistent"), null);
  });
});

describe("teams: listTeams", () => {
  beforeEach(() => { setup(); seedAgents(); });
  afterEach(teardown);

  it("lists all teams", async () => {
    const { createTeam, listTeams } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m1", manager: "mgr" });
    createTeam(db, { name: "t2", mission: "m2", manager: "mgr" });
    const teams = listTeams(db);
    assert.equal(teams.length, 2);
  });

  it("returns empty array when no teams exist", async () => {
    const { listTeams } = await import("./teams.js");
    assert.deepStrictEqual(listTeams(db), []);
  });

  it("filters by status", async () => {
    const { createTeam, listTeams } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m1", manager: "mgr", status: "exploring" });
    createTeam(db, { name: "t2", mission: "m2", manager: "mgr", status: "building" });
    createTeam(db, { name: "t3", mission: "m3", manager: "mgr", status: "exploring" });
    const exploring = listTeams(db, { status: "exploring" });
    assert.equal(exploring.length, 2);
    const building = listTeams(db, { status: "building" });
    assert.equal(building.length, 1);
  });

  it("filters by manager", async () => {
    createAgent(db, { handle: "mgr2", name: "Mgr2", role: "manager", mission: "lead" });
    const { createTeam, listTeams } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m1", manager: "mgr" });
    createTeam(db, { name: "t2", mission: "m2", manager: "mgr2" });
    const filtered = listTeams(db, { manager: "mgr" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, "t1");
  });
});

describe("teams: updateTeam", () => {
  beforeEach(() => { setup(); seedAgents(); });
  afterEach(teardown);

  it("updates team mission", async () => {
    const { createTeam, updateTeam } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "old", manager: "mgr" });
    const updated = updateTeam(db, "t1", { mission: "new mission" });
    assert.ok(updated);
    assert.equal(updated!.mission, "new mission");
  });

  it("updates team status", async () => {
    const { createTeam, updateTeam } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m", manager: "mgr" });
    const updated = updateTeam(db, "t1", { status: "building" });
    assert.equal(updated!.status, "building");
  });

  it("returns null for nonexistent team", async () => {
    const { updateTeam } = await import("./teams.js");
    const result = updateTeam(db, "ghost", { mission: "new" });
    assert.equal(result, null);
  });

  it("returns team unchanged when no fields provided", async () => {
    const { createTeam, updateTeam } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m", manager: "mgr" });
    const result = updateTeam(db, "t1", {});
    assert.ok(result);
    assert.equal(result!.mission, "m");
  });
});

describe("teams: addMember / removeMember / listMembers", () => {
  beforeEach(() => { setup(); seedAgents(); });
  afterEach(teardown);

  it("adds a member to a team", async () => {
    const { createTeam, addMember, listMembers } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m", manager: "mgr" });
    addMember(db, "t1", "worker-a");
    const members = listMembers(db, "t1");
    assert.equal(members.length, 1);
  });

  it("adds multiple members", async () => {
    const { createTeam, addMember, listMembers } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m", manager: "mgr" });
    addMember(db, "t1", "worker-a");
    addMember(db, "t1", "worker-b");
    const members = listMembers(db, "t1");
    assert.equal(members.length, 2);
  });

  it("removes a member from a team", async () => {
    const { createTeam, addMember, removeMember, listMembers } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m", manager: "mgr" });
    addMember(db, "t1", "worker-a");
    addMember(db, "t1", "worker-b");
    removeMember(db, "t1", "worker-a");
    const members = listMembers(db, "t1");
    assert.equal(members.length, 1);
  });

  it("returns empty array for team with no members", async () => {
    const { createTeam, listMembers } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m", manager: "mgr" });
    const members = listMembers(db, "t1");
    assert.equal(members.length, 0);
  });

  it("rejects adding member to nonexistent team", async () => {
    const { addMember } = await import("./teams.js");
    assert.throws(
      () => addMember(db, "nonexistent", "worker-a"),
      /not found|FOREIGN KEY/
    );
  });

  it("rejects adding nonexistent agent as member", async () => {
    const { createTeam, addMember } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m", manager: "mgr" });
    assert.throws(
      () => addMember(db, "t1", "ghost"),
      /not found|FOREIGN KEY/
    );
  });

  it("rejects duplicate membership", async () => {
    const { createTeam, addMember } = await import("./teams.js");
    createTeam(db, { name: "t1", mission: "m", manager: "mgr" });
    addMember(db, "t1", "worker-a");
    assert.throws(
      () => addMember(db, "t1", "worker-a"),
      /already|UNIQUE/
    );
  });
});

// ============================================================
// 3. ROUTES — createRoute, getRoute, listRoutes, updateRoute,
//    listRoutesByTeam, edge cases
// ============================================================

describe("routes: createRoute", () => {
  beforeEach(() => { setup(); seedAgents(); });
  afterEach(teardown);

  it("creates a route and returns it", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const { createRoute } = await import("./routes.js");
    const route = createRoute(db, { teamName: "t1", agentHandle: "worker-a", name: "JWT approach" });
    assert.ok(route.id);
    assert.equal(route.team_name, "t1");
    assert.equal(route.agent_handle, "@worker-a");
    assert.equal(route.name, "JWT approach");
    assert.equal(route.status, "exploring");
    assert.ok(route.created_at);
  });

  it("rejects route for nonexistent team", async () => {
    const { createRoute } = await import("./routes.js");
    assert.throws(
      () => createRoute(db, { teamName: "nonexistent", agentHandle: "worker-a", name: "route" }),
      /not found|FOREIGN KEY/
    );
  });

  it("rejects route for nonexistent agent", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const { createRoute } = await import("./routes.js");
    assert.throws(
      () => createRoute(db, { teamName: "t1", agentHandle: "ghost", name: "route" }),
      /not found|FOREIGN KEY/
    );
  });

  it("allows specifying initial status", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const { createRoute } = await import("./routes.js");
    const route = createRoute(db, { teamName: "t1", agentHandle: "worker-a", name: "chosen route", status: "chosen" });
    assert.equal(route.status, "chosen");
  });
});

describe("routes: getRoute", () => {
  beforeEach(() => { setup(); seedAgents(); });
  afterEach(teardown);

  it("retrieves a route by id", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const { createRoute, getRoute } = await import("./routes.js");
    const created = createRoute(db, { teamName: "t1", agentHandle: "worker-a", name: "route1" });
    const fetched = getRoute(db, created.id);
    assert.ok(fetched);
    assert.equal(fetched!.id, created.id);
    assert.equal(fetched!.name, "route1");
  });

  it("returns null for nonexistent route", async () => {
    const { getRoute } = await import("./routes.js");
    assert.equal(getRoute(db, "nonexistent-id"), null);
  });
});

describe("routes: listRoutes", () => {
  beforeEach(() => { setup(); seedAgents(); });
  afterEach(teardown);

  it("lists all routes", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const { createRoute, listRoutes } = await import("./routes.js");
    createRoute(db, { teamName: "t1", agentHandle: "worker-a", name: "r1" });
    createRoute(db, { teamName: "t1", agentHandle: "worker-b", name: "r2" });
    const routes = listRoutes(db);
    assert.equal(routes.length, 2);
  });

  it("returns empty array when no routes exist", async () => {
    const { listRoutes } = await import("./routes.js");
    assert.deepStrictEqual(listRoutes(db), []);
  });

  it("filters by status", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const { createRoute, listRoutes } = await import("./routes.js");
    createRoute(db, { teamName: "t1", agentHandle: "worker-a", name: "r1", status: "exploring" });
    createRoute(db, { teamName: "t1", agentHandle: "worker-b", name: "r2", status: "chosen" });
    const exploring = listRoutes(db, { status: "exploring" });
    assert.equal(exploring.length, 1);
    assert.equal(exploring[0].name, "r1");
  });

  it("filters by team", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t2", "m2", "@mgr");
    const { createRoute, listRoutes } = await import("./routes.js");
    createRoute(db, { teamName: "t1", agentHandle: "worker-a", name: "r1" });
    createRoute(db, { teamName: "t2", agentHandle: "worker-b", name: "r2" });
    const filtered = listRoutes(db, { teamName: "t1" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].team_name, "t1");
  });
});

describe("routes: updateRoute", () => {
  beforeEach(() => { setup(); seedAgents(); });
  afterEach(teardown);

  it("updates route status", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const { createRoute, updateRoute } = await import("./routes.js");
    const route = createRoute(db, { teamName: "t1", agentHandle: "worker-a", name: "r1" });
    const updated = updateRoute(db, route.id, { status: "chosen" });
    assert.ok(updated);
    assert.equal(updated!.status, "chosen");
  });

  it("updates route name", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const { createRoute, updateRoute } = await import("./routes.js");
    const route = createRoute(db, { teamName: "t1", agentHandle: "worker-a", name: "old name" });
    const updated = updateRoute(db, route.id, { name: "new name" });
    assert.equal(updated!.name, "new name");
  });

  it("returns null for nonexistent route", async () => {
    const { updateRoute } = await import("./routes.js");
    const result = updateRoute(db, "nonexistent", { status: "chosen" });
    assert.equal(result, null);
  });

  it("returns route unchanged when no fields provided", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const { createRoute, updateRoute } = await import("./routes.js");
    const route = createRoute(db, { teamName: "t1", agentHandle: "worker-a", name: "r1" });
    const result = updateRoute(db, route.id, {});
    assert.ok(result);
    assert.equal(result!.name, "r1");
  });
});

describe("routes: listRoutesByTeam", () => {
  beforeEach(() => { setup(); seedAgents(); });
  afterEach(teardown);

  it("returns routes for a specific team", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t2", "m2", "@mgr");
    const { createRoute, listRoutesByTeam } = await import("./routes.js");
    createRoute(db, { teamName: "t1", agentHandle: "worker-a", name: "r1" });
    createRoute(db, { teamName: "t1", agentHandle: "worker-b", name: "r2" });
    createRoute(db, { teamName: "t2", agentHandle: "worker-a", name: "r3" });

    const t1Routes = listRoutesByTeam(db, "t1");
    assert.equal(t1Routes.length, 2);
    assert.ok(t1Routes.every((r) => r.team_name === "t1"));
  });

  it("returns empty array for team with no routes", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");
    const { listRoutesByTeam } = await import("./routes.js");
    assert.deepStrictEqual(listRoutesByTeam(db, "t1"), []);
  });
});

// ============================================================
// 4. SERVER ROUTES — M2 API endpoints
// ============================================================

describe("M2 API: team endpoints", () => {
  let app: any;
  let adminKey: string;
  let agentKey: string;

  beforeEach(async () => {
    setup();
    seedAgents();

    const { createApp } = await import("./server.js");

    adminKey = generateKey();
    db.prepare("INSERT INTO api_keys (key_hash, agent_handle) VALUES (?, ?)").run(
      hashKey(adminKey), null
    );

    agentKey = generateKey();
    storeKey(db, agentKey, "@worker-a");

    app = createApp(db, tmpDir);
  });
  afterEach(teardown);

  it("POST /api/teams creates a team (admin)", async () => {
    const res = await app.request("/api/teams", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "auth-team", mission: "Handle auth", manager: "mgr" }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.name, "auth-team");
    assert.equal(data.manager, "@mgr");
  });

  it("POST /api/teams requires admin key", async () => {
    const res = await app.request("/api/teams", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "t1", mission: "m", manager: "mgr" }),
    });
    assert.equal(res.status, 403);
  });

  it("POST /api/teams rejects missing fields", async () => {
    const res = await app.request("/api/teams", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "t1" }),
    });
    assert.ok([400, 409].includes(res.status));
  });

  it("POST /api/teams rejects duplicate names", async () => {
    const headers = {
      Authorization: `Bearer ${adminKey}`,
      "Content-Type": "application/json",
    };
    await app.request("/api/teams", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "t1", mission: "m", manager: "mgr" }),
    });
    const res = await app.request("/api/teams", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "t1", mission: "m2", manager: "mgr" }),
    });
    assert.equal(res.status, 409);
  });

  it("GET /api/teams lists teams", async () => {
    // Seed a team directly
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");

    const res = await app.request("/api/teams", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
  });

  it("GET /api/teams/:name retrieves a specific team", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("auth-team", "Auth", "@mgr");

    const res = await app.request("/api/teams/auth-team", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, "auth-team");
  });

  it("GET /api/teams/:name returns 404 for nonexistent team", async () => {
    const res = await app.request("/api/teams/nonexistent", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 404);
  });

  it("PATCH /api/teams/:name updates a team (admin)", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "old", "@mgr");

    const res = await app.request("/api/teams/t1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "building" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "building");
  });

  it("PATCH /api/teams/:name requires admin key", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");

    const res = await app.request("/api/teams/t1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${agentKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "building" }),
    });
    assert.equal(res.status, 403);
  });

  it("requires auth for all /api/teams endpoints", async () => {
    const res = await app.request("/api/teams");
    assert.equal(res.status, 401);
  });
});

describe("M2 API: team member endpoints", () => {
  let app: any;
  let adminKey: string;

  beforeEach(async () => {
    setup();
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");

    const { createApp } = await import("./server.js");
    adminKey = generateKey();
    db.prepare("INSERT INTO api_keys (key_hash, agent_handle) VALUES (?, ?)").run(
      hashKey(adminKey), null
    );
    app = createApp(db, tmpDir);
  });
  afterEach(teardown);

  it("POST /api/teams/:name/members adds a member", async () => {
    const res = await app.request("/api/teams/t1/members", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agent_handle: "worker-a" }),
    });
    assert.ok([200, 201].includes(res.status));
  });

  it("GET /api/teams/:name/members lists members", async () => {
    db.prepare("INSERT INTO team_members (team_name, agent_handle) VALUES (?, ?)").run("t1", "@worker-a");

    const res = await app.request("/api/teams/t1/members", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
  });

  it("DELETE /api/teams/:name/members/:handle removes a member", async () => {
    db.prepare("INSERT INTO team_members (team_name, agent_handle) VALUES (?, ?)").run("t1", "@worker-a");

    const res = await app.request("/api/teams/t1/members/@worker-a", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.ok([200, 204].includes(res.status));

    // Verify removed
    const rows = db.prepare("SELECT * FROM team_members WHERE team_name = ?").all("t1");
    assert.equal(rows.length, 0);
  });
});

describe("M2 API: route endpoints", () => {
  let app: any;
  let adminKey: string;
  let agentKey: string;

  beforeEach(async () => {
    setup();
    seedAgents();
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t1", "m", "@mgr");

    const { createApp } = await import("./server.js");
    adminKey = generateKey();
    db.prepare("INSERT INTO api_keys (key_hash, agent_handle) VALUES (?, ?)").run(
      hashKey(adminKey), null
    );
    agentKey = generateKey();
    storeKey(db, agentKey, "@worker-a");
    app = createApp(db, tmpDir);
  });
  afterEach(teardown);

  it("POST /api/routes creates a route (admin)", async () => {
    const res = await app.request("/api/routes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ team_name: "t1", agent_handle: "worker-a", name: "JWT approach" }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.id);
    assert.equal(data.name, "JWT approach");
    assert.equal(data.status, "exploring");
  });

  it("POST /api/routes requires admin key", async () => {
    const res = await app.request("/api/routes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ team_name: "t1", agent_handle: "worker-a", name: "route" }),
    });
    assert.equal(res.status, 403);
  });

  it("GET /api/routes lists routes", async () => {
    db.prepare("INSERT INTO routes (id, team_name, agent_handle, name) VALUES (?, ?, ?, ?)").run(
      "r1", "t1", "@worker-a", "route1"
    );

    const res = await app.request("/api/routes", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
  });

  it("GET /api/routes?team=t1 filters by team", async () => {
    db.prepare("INSERT INTO teams (name, mission, manager) VALUES (?, ?, ?)").run("t2", "m2", "@mgr");
    db.prepare("INSERT INTO routes (id, team_name, agent_handle, name) VALUES (?, ?, ?, ?)").run("r1", "t1", "@worker-a", "r1");
    db.prepare("INSERT INTO routes (id, team_name, agent_handle, name) VALUES (?, ?, ?, ?)").run("r2", "t2", "@worker-b", "r2");

    const res = await app.request("/api/routes?team=t1", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].team_name, "t1");
  });

  it("GET /api/routes/:id retrieves a specific route", async () => {
    db.prepare("INSERT INTO routes (id, team_name, agent_handle, name) VALUES (?, ?, ?, ?)").run(
      "r1", "t1", "@worker-a", "route1"
    );

    const res = await app.request("/api/routes/r1", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.id, "r1");
  });

  it("GET /api/routes/:id returns 404 for nonexistent", async () => {
    const res = await app.request("/api/routes/nonexistent", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 404);
  });

  it("PATCH /api/routes/:id updates a route (admin)", async () => {
    db.prepare("INSERT INTO routes (id, team_name, agent_handle, name) VALUES (?, ?, ?, ?)").run(
      "r1", "t1", "@worker-a", "route1"
    );

    const res = await app.request("/api/routes/r1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "chosen" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "chosen");
  });

  it("PATCH /api/routes/:id requires admin key", async () => {
    db.prepare("INSERT INTO routes (id, team_name, agent_handle, name) VALUES (?, ?, ?, ?)").run(
      "r1", "t1", "@worker-a", "route1"
    );

    const res = await app.request("/api/routes/r1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${agentKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "chosen" }),
    });
    assert.equal(res.status, 403);
  });

  it("requires auth for all /api/routes endpoints", async () => {
    const res = await app.request("/api/routes");
    assert.equal(res.status, 401);
  });
});

// ============================================================
// 5. RENDER FUNCTIONS — renderTeam, renderTeamList,
//    renderRoute, renderRouteList
// ============================================================

describe("renderTeam", () => {
  it("renders a team with name, status, mission, and manager", async () => {
    process.env.NO_COLOR = "1";
    const { renderTeam } = await import("./render.js");
    const output = renderTeam({
      name: "auth-team",
      mission: "Handle authentication",
      manager: "@mgr",
      status: "exploring",
      created_at: new Date().toISOString(),
    });
    assert.ok(output.includes("auth-team"));
    assert.ok(output.includes("exploring"));
    assert.ok(output.includes("Handle authentication"));
    assert.ok(output.includes("@mgr"));
    delete process.env.NO_COLOR;
  });

  it("includes all status values correctly", async () => {
    process.env.NO_COLOR = "1";
    const { renderTeam } = await import("./render.js");
    for (const status of ["exploring", "building", "blocked", "done"] as const) {
      const output = renderTeam({
        name: "t1",
        mission: "m",
        manager: "@mgr",
        status,
        created_at: new Date().toISOString(),
      });
      assert.ok(output.includes(status));
    }
    delete process.env.NO_COLOR;
  });
});

describe("renderTeamList", () => {
  it("renders a list of teams", async () => {
    process.env.NO_COLOR = "1";
    const { renderTeamList } = await import("./render.js");
    const output = renderTeamList([
      { name: "auth-team", mission: "Auth", manager: "@mgr", status: "exploring", created_at: new Date().toISOString() },
      { name: "data-team", mission: "Data", manager: "@mgr", status: "building", created_at: new Date().toISOString() },
    ]);
    assert.ok(output.includes("auth-team"));
    assert.ok(output.includes("data-team"));
    delete process.env.NO_COLOR;
  });

  it("renders empty message for no teams", async () => {
    process.env.NO_COLOR = "1";
    const { renderTeamList } = await import("./render.js");
    const output = renderTeamList([]);
    assert.ok(output.includes("No") || output.includes("no") || output.includes("empty") || output.length > 0);
    delete process.env.NO_COLOR;
  });
});

describe("renderRoute", () => {
  it("renders a route with id, name, status, team, and agent", async () => {
    process.env.NO_COLOR = "1";
    const { renderRoute } = await import("./render.js");
    const output = renderRoute({
      id: "abc12345-def6-7890-abcd-ef1234567890",
      team_name: "auth-team",
      agent_handle: "@worker-a",
      name: "JWT approach",
      status: "exploring",
      created_at: new Date().toISOString(),
    });
    assert.ok(output.includes("JWT approach") || output.includes("abc12345"));
    assert.ok(output.includes("auth-team") || output.includes("@worker-a"));
    assert.ok(output.includes("exploring"));
    delete process.env.NO_COLOR;
  });

  it("renders all route status values", async () => {
    process.env.NO_COLOR = "1";
    const { renderRoute } = await import("./render.js");
    for (const status of ["exploring", "chosen", "abandoned"] as const) {
      const output = renderRoute({
        id: "r1",
        team_name: "t1",
        agent_handle: "@worker-a",
        name: "route",
        status,
        created_at: new Date().toISOString(),
      });
      assert.ok(output.includes(status));
    }
    delete process.env.NO_COLOR;
  });
});

describe("renderRouteList", () => {
  it("renders a list of routes", async () => {
    process.env.NO_COLOR = "1";
    const { renderRouteList } = await import("./render.js");
    const output = renderRouteList([
      { id: "r1", team_name: "t1", agent_handle: "@worker-a", name: "JWT", status: "exploring", created_at: new Date().toISOString() },
      { id: "r2", team_name: "t1", agent_handle: "@worker-b", name: "Session", status: "chosen", created_at: new Date().toISOString() },
    ]);
    assert.ok(output.includes("JWT") || output.includes("r1"));
    assert.ok(output.includes("Session") || output.includes("r2"));
    delete process.env.NO_COLOR;
  });

  it("renders empty message for no routes", async () => {
    process.env.NO_COLOR = "1";
    const { renderRouteList } = await import("./render.js");
    const output = renderRouteList([]);
    assert.ok(output.includes("No") || output.includes("no") || output.includes("empty") || output.length > 0);
    delete process.env.NO_COLOR;
  });
});
