/**
 * Coverage tests for previously untested exports.
 * Covers: normalizeHandle, validateHandle, getDb, withDb,
 * renderDagCommit, renderOrg, updateSpawn, parseNumstat.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

// Set NO_COLOR to strip ANSI for assertions
process.env.NO_COLOR = "1";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-coverage-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// === agents.ts: normalizeHandle, validateHandle ===

describe("normalizeHandle", () => {
  it("adds @ prefix if missing", async () => {
    const { normalizeHandle } = await import("./agents.js");
    assert.equal(normalizeHandle("admin"), "@admin");
  });

  it("keeps @ prefix if present", async () => {
    const { normalizeHandle } = await import("./agents.js");
    assert.equal(normalizeHandle("@admin"), "@admin");
  });
});

describe("validateHandle", () => {
  it("accepts valid handles", async () => {
    const { validateHandle } = await import("./agents.js");
    assert.doesNotThrow(() => validateHandle("auth-mgr"));
    assert.doesNotThrow(() => validateHandle("@auth-mgr"));
    assert.doesNotThrow(() => validateHandle("agent1"));
  });

  it("rejects empty handle", async () => {
    const { validateHandle } = await import("./agents.js");
    assert.throws(() => validateHandle(""), /Invalid handle/);
  });

  it("rejects handles with special chars", async () => {
    const { validateHandle } = await import("./agents.js");
    assert.throws(() => validateHandle("agent!"), /Invalid handle/);
    assert.throws(() => validateHandle("agent name"), /Invalid handle/);
  });

  it("rejects handles exceeding 50 chars", async () => {
    const { validateHandle } = await import("./agents.js");
    const longHandle = "a".repeat(51);
    assert.throws(() => validateHandle(longHandle), /too long/);
  });
});

// === db.ts: getDb, withDb ===

describe("getDb", () => {
  it("creates and opens a SQLite database", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb(tmpDir);
    assert.ok(db);
    assert.ok(fs.existsSync(path.join(tmpDir, "board.db")));
    db.close();
  });
});

describe("withDb", () => {
  it("runs sync function and closes db", async () => {
    const { initDb, withDb } = await import("./db.js");
    // Initialize the DB first
    const setupDb = initDb(tmpDir);
    setupDb.close();

    const result = withDb((db) => {
      const row = db.prepare("SELECT 1 as val").get() as { val: number };
      return row.val;
    }, tmpDir);
    assert.equal(result, 1);
  });

  it("closes db even if function throws", async () => {
    const { initDb, withDb, getDb } = await import("./db.js");
    const setupDb = initDb(tmpDir);
    setupDb.close();

    assert.throws(() => {
      withDb(() => {
        throw new Error("test error");
      }, tmpDir);
    }, /test error/);

    // DB should still be accessible (wasn't left locked)
    const db = getDb(tmpDir);
    const row = db.prepare("SELECT 1 as val").get() as { val: number };
    assert.equal(row.val, 1);
    db.close();
  });

  it("handles async functions", async () => {
    const { initDb, withDb } = await import("./db.js");
    const setupDb = initDb(tmpDir);
    setupDb.close();

    const result = await withDb(async (db) => {
      return 42;
    }, tmpDir);
    assert.equal(result, 42);
  });
});

// === render.ts: renderDagCommit, renderOrg ===

describe("renderDagCommit", () => {
  it("renders a commit with hash, agent, and message", async () => {
    const { renderDagCommit } = await import("./render.js");
    const commit = {
      hash: "abc12345678",
      parent_hash: "def00000000",
      agent_handle: "@auth-mgr",
      message: "Implement JWT validation",
      created_at: "2025-01-01T00:00:00Z",
    };
    const output = renderDagCommit(commit);
    assert.ok(output.includes("abc12345"));
    assert.ok(output.includes("@auth-mgr"));
    assert.ok(output.includes("Implement JWT validation"));
  });

  it("renders root commit (no parent)", async () => {
    const { renderDagCommit } = await import("./render.js");
    const commit = {
      hash: "abc12345678",
      parent_hash: null,
      agent_handle: "@root",
      message: "Initial commit",
      created_at: "2025-01-01T00:00:00Z",
    };
    const output = renderDagCommit(commit);
    assert.ok(output.includes("(root)"));
  });
});

describe("renderOrg", () => {
  it("renders empty org", async () => {
    const { renderOrg } = await import("./render.js");
    const output = renderOrg([], []);
    assert.ok(output.includes("Organization"));
    assert.ok(output.includes("No teams"));
  });

  it("renders teams with members and routes", async () => {
    const { renderOrg } = await import("./render.js");
    const teams = [{
      name: "auth-team",
      mission: "Handle auth",
      manager: "@mgr",
      status: "exploring" as const,
      created_at: "2025-01-01T00:00:00Z",
      members: [{ team_name: "auth-team", agent_handle: "@worker1" }],
    }];
    const routes = [{
      id: "r1",
      team_name: "auth-team",
      agent_handle: "@worker1",
      name: "JWT approach",
      status: "exploring" as const,
      created_at: "2025-01-01T00:00:00Z",
    }];
    const output = renderOrg(teams, routes);
    assert.ok(output.includes("auth-team"));
    assert.ok(output.includes("@mgr"));
    assert.ok(output.includes("@worker1"));
    assert.ok(output.includes("JWT approach"));
  });
});

// === spawner.ts: updateSpawn ===

describe("updateSpawn", () => {
  it("updates a spawn record", async () => {
    const { initDb } = await import("./db.js");
    const { insertSpawn, updateSpawn, getSpawn } = await import("./spawner.js");
    const { createAgent } = await import("./agents.js");
    const db = initDb(tmpDir);

    createAgent(db, { handle: "bot", name: "Bot", role: "worker", mission: "test" });
    insertSpawn(db, { agent_handle: "@bot", pid: 100, log_path: "/tmp/old.log", worktree_path: "/tmp/old", branch: "agent/bot", exit_code: null });

    updateSpawn(db, {
      agent_handle: "@bot",
      pid: 200,
      log_path: "/tmp/new.log",
      worktree_path: "/tmp/new",
      branch: "agent/bot-v2",
      exit_code: null,
    });

    const spawn = getSpawn(db, "@bot");
    assert.equal(spawn?.pid, 200);
    assert.equal(spawn?.log_path, "/tmp/new.log");
    assert.equal(spawn?.branch, "agent/bot-v2");
    db.close();
  });
});

// === sprint-orchestrator.ts: parseNumstat ===

describe("parseNumstat", () => {
  it("returns null for nonexistent branch", async () => {
    const { parseNumstat } = await import("./sprint-orchestrator.js");
    const result = parseNumstat(tmpDir, "nonexistent-branch");
    assert.equal(result, null);
  });
});
