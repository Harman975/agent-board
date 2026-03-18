/**
 * Coverage tests for exports not covered by other test files.
 * Covers: renderDagCommit, renderOrg, updateSpawn, loadCustomPresets, parseNumstat.
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

// === boardrc.ts: loadCustomPresets ===

describe("loadCustomPresets", () => {
  it("returns empty when presets/ dir does not exist", async () => {
    const { loadCustomPresets } = await import("./boardrc.js");
    const result = loadCustomPresets(tmpDir);
    assert.deepEqual(result, {});
  });

  it("loads valid YAML preset files", async () => {
    const { loadCustomPresets } = await import("./boardrc.js");
    const presetsDir = path.join(tmpDir, "presets");
    fs.mkdirSync(presetsDir);
    fs.writeFileSync(
      path.join(presetsDir, "perf.yml"),
      `name: perf
description: Maximize performance
eval: npm run bench
metric: grep 'ops/sec' eval.log
direction: higher
guard: npm test
`
    );
    const result = loadCustomPresets(tmpDir);
    assert.ok(result.perf);
    assert.equal(result.perf.description, "Maximize performance");
    assert.equal(result.perf.direction, "higher");
    assert.equal(result.perf.eval, "npm run bench");
  });

  it("loads .yaml extension files", async () => {
    const { loadCustomPresets } = await import("./boardrc.js");
    const presetsDir = path.join(tmpDir, "presets");
    fs.mkdirSync(presetsDir);
    fs.writeFileSync(
      path.join(presetsDir, "size.yaml"),
      `name: size
description: Minimize bundle size
eval: npm run build
metric: "du -sb dist | awk '{print $1}'"
direction: lower
guard: npm test
`
    );
    const result = loadCustomPresets(tmpDir);
    assert.ok(result.size);
    assert.equal(result.size.direction, "lower");
  });

  it("skips files with missing required fields", async () => {
    const { loadCustomPresets } = await import("./boardrc.js");
    const presetsDir = path.join(tmpDir, "presets");
    fs.mkdirSync(presetsDir);
    fs.writeFileSync(
      path.join(presetsDir, "incomplete.yml"),
      `name: incomplete
description: Missing fields
`
    );
    const result = loadCustomPresets(tmpDir);
    assert.deepEqual(result, {});
  });

  it("skips files with invalid direction", async () => {
    const { loadCustomPresets } = await import("./boardrc.js");
    const presetsDir = path.join(tmpDir, "presets");
    fs.mkdirSync(presetsDir);
    fs.writeFileSync(
      path.join(presetsDir, "bad.yml"),
      `name: bad
description: Bad direction
eval: echo
metric: echo
direction: sideways
guard: echo
`
    );
    const result = loadCustomPresets(tmpDir);
    assert.deepEqual(result, {});
  });

  it("skips non-YAML files", async () => {
    const { loadCustomPresets } = await import("./boardrc.js");
    const presetsDir = path.join(tmpDir, "presets");
    fs.mkdirSync(presetsDir);
    fs.writeFileSync(path.join(presetsDir, "readme.txt"), "not yaml");
    const result = loadCustomPresets(tmpDir);
    assert.deepEqual(result, {});
  });

  it("handles malformed YAML gracefully", async () => {
    const { loadCustomPresets } = await import("./boardrc.js");
    const presetsDir = path.join(tmpDir, "presets");
    fs.mkdirSync(presetsDir);
    fs.writeFileSync(path.join(presetsDir, "bad.yml"), "\x00\x00\x00");
    // Should not throw
    const result = loadCustomPresets(tmpDir);
    assert.deepEqual(result, {});
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
