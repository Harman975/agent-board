import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { initDb } from "./db.js";
import { createAgent } from "./agents.js";
import { createChannel, getChannel } from "./channels.js";
import { listPosts } from "./posts.js";
import {
  insertSpawn,
  markSpawnStopped,
  getSpawn,
  listSpawns,
  spawnAgent,
  killAgent,
  isProcessAlive,
  type Executor,
  type SpawnRecord,
} from "./spawner.js";
import type Database from "better-sqlite3";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-spawner-test-"));
  db = initDb(tmpDir);

  // Initialize git repo in tmpDir for worktree tests
  execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "pipe" });
  // Need at least one commit for worktrees to work
  fs.writeFileSync(path.join(tmpDir, "README.md"), "test");
  execSync("git add . && git commit -m 'init'", { cwd: tmpDir, stdio: "pipe" });
});

afterEach(() => {
  db.close();
  // Clean up worktrees before removing dir
  try {
    execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" });
  } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Mock executor that returns a fake ChildProcess
function createMockExecutor(): {
  executor: Executor;
  lastCall: { command: string; args: string[]; opts: any } | null;
  fakeProcess: EventEmitter & { pid: number; unref: () => void };
} {
  const fakeProcess = Object.assign(new EventEmitter(), {
    pid: 99999,
    unref: () => {},
  });
  let lastCall: { command: string; args: string[]; opts: any } | null = null;

  const executor: Executor = (command, args, opts) => {
    lastCall = { command, args, opts };
    return fakeProcess as any;
  };

  return { executor, lastCall: null, fakeProcess, get _lastCall() { return lastCall; } };
}

// === Spawns table CRUD ===

describe("spawns table", () => {
  beforeEach(() => {
    createAgent(db, { handle: "bot", name: "Bot", mission: "test" });
  });

  it("inserts spawn record", () => {
    insertSpawn(db, {
      agent_handle: "@bot",
      pid: 12345,
      log_path: "/tmp/agent.log",
      worktree_path: "/tmp/worktree",
      branch: "agent/bot",
    });
    const spawn = getSpawn(db, "@bot");
    assert.ok(spawn);
    assert.equal(spawn.pid, 12345);
    assert.equal(spawn.branch, "agent/bot");
    assert.equal(spawn.stopped_at, null);
  });

  it("marks spawn as stopped", () => {
    insertSpawn(db, { agent_handle: "@bot", pid: 12345, log_path: null, worktree_path: null, branch: null });
    markSpawnStopped(db, "@bot");
    const spawn = getSpawn(db, "@bot");
    assert.ok(spawn?.stopped_at);
  });

  it("lists active spawns", () => {
    createAgent(db, { handle: "bot2", name: "Bot2", mission: "test2" });
    insertSpawn(db, { agent_handle: "@bot", pid: 111, log_path: null, worktree_path: null, branch: null });
    insertSpawn(db, { agent_handle: "@bot2", pid: 222, log_path: null, worktree_path: null, branch: null });
    markSpawnStopped(db, "@bot");

    const active = listSpawns(db, true);
    assert.equal(active.length, 1);
    assert.equal(active[0].agent_handle, "@bot2");

    const all = listSpawns(db, false);
    assert.equal(all.length, 2);
  });

  it("FK constraint rejects invalid handle", () => {
    assert.throws(
      () => insertSpawn(db, { agent_handle: "@nonexistent", pid: 111, log_path: null, worktree_path: null, branch: null }),
      /FOREIGN KEY/
    );
  });
});

// === Worktree + CLAUDE.md ===

describe("spawnAgent worktree", () => {
  beforeEach(() => {
    createAgent(db, { handle: "worker", name: "Worker", mission: "work" });
  });

  it("creates git worktree for agent", () => {
    const mock = createMockExecutor();
    const result = spawnAgent(db, {
      handle: "@worker",
      mission: "test mission",
      apiKey: "test-key-123",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    assert.ok(fs.existsSync(result.worktreePath));
    assert.equal(result.branch, "agent/worker");
    assert.ok(result.worktreePath.includes(".worktrees/@worker"));
  });

  it("writes CLAUDE.md with API key and mission", () => {
    const mock = createMockExecutor();
    const result = spawnAgent(db, {
      handle: "@worker",
      mission: "build authentication",
      apiKey: "secret-key-xyz",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    const claudeMd = fs.readFileSync(path.join(result.worktreePath, "CLAUDE.md"), "utf-8");
    assert.ok(claudeMd.includes("secret-key-xyz"));
    assert.ok(claudeMd.includes("build authentication"));
    assert.ok(claudeMd.includes("http://localhost:3141"));
    assert.ok(claudeMd.includes("DO NOT COMMIT"));
    assert.ok(claudeMd.includes("curl"));
  });
});

// === Subprocess spawn ===

describe("spawnAgent subprocess", () => {
  beforeEach(() => {
    createAgent(db, { handle: "runner", name: "Runner", mission: "run" });
  });

  it("calls executor with correct args", () => {
    const mock = createMockExecutor();
    spawnAgent(db, {
      handle: "@runner",
      mission: "test",
      apiKey: "key-123",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    const call = mock._lastCall;
    assert.ok(call);
    assert.equal(call.command, "claude");
    assert.ok(call.args.includes("--dangerously-skip-permissions"));
    assert.ok(call.opts.cwd.includes(".worktrees/@runner"));
    assert.equal(call.opts.env.BOARD_URL, "http://localhost:3141");
    assert.equal(call.opts.env.BOARD_KEY, "key-123");
    assert.equal(call.opts.env.BOARD_AGENT, "@runner");
  });

  it("records spawn in DB", () => {
    const mock = createMockExecutor();
    spawnAgent(db, {
      handle: "@runner",
      mission: "test",
      apiKey: "key-123",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    const spawn = getSpawn(db, "@runner");
    assert.ok(spawn);
    assert.equal(spawn.pid, 99999);
    assert.equal(spawn.agent_handle, "@runner");
    assert.equal(spawn.stopped_at, null);
  });
});

// === Auto-status posts ===

describe("auto-status posts", () => {
  beforeEach(() => {
    createAgent(db, { handle: "poster", name: "Poster", mission: "post" });
  });

  it("posts 'starting' to #status on spawn", () => {
    const mock = createMockExecutor();
    spawnAgent(db, {
      handle: "@poster",
      mission: "build feature X",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    const posts = listPosts(db, { author: "@poster", channel: "#status" });
    assert.equal(posts.length, 1);
    assert.ok(posts[0].content.includes("Starting"));
    assert.ok(posts[0].content.includes("build feature X"));
  });

  it("creates #status channel if missing", () => {
    // Verify #status doesn't exist before spawn
    assert.equal(getChannel(db, "#status"), null);

    const mock = createMockExecutor();
    spawnAgent(db, {
      handle: "@poster",
      mission: "test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    // Now #status should exist
    assert.ok(getChannel(db, "#status"));
  });

  it("posts 'finished' on clean exit", () => {
    const mock = createMockExecutor();
    spawnAgent(db, {
      handle: "@poster",
      mission: "test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    // Simulate clean exit
    mock.fakeProcess.emit("exit", 0);

    const posts = listPosts(db, { author: "@poster", channel: "#status" });
    // Should have "Starting" and "Finished"
    assert.equal(posts.length, 2);
    assert.ok(posts.some((p) => p.content === "Finished"));
  });

  it("posts 'crashed' on error exit", () => {
    const mock = createMockExecutor();
    spawnAgent(db, {
      handle: "@poster",
      mission: "test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    // Simulate crash
    mock.fakeProcess.emit("exit", 1);

    const posts = listPosts(db, { author: "@poster", channel: "#status" });
    assert.equal(posts.length, 2);
    assert.ok(posts.some((p) => p.content.includes("Crashed")));
    assert.ok(posts.some((p) => p.content.includes("exit code 1")));
  });

  it("marks spawn as stopped on exit", () => {
    const mock = createMockExecutor();
    spawnAgent(db, {
      handle: "@poster",
      mission: "test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    mock.fakeProcess.emit("exit", 0);

    const spawn = getSpawn(db, "@poster");
    assert.ok(spawn?.stopped_at);
  });
});

// === Kill ===

describe("killAgent", () => {
  it("handles already-dead process", () => {
    createAgent(db, { handle: "dead", name: "Dead", mission: "die" });
    insertSpawn(db, {
      agent_handle: "@dead",
      pid: 1, // PID 1 exists but isn't claude
      log_path: null,
      worktree_path: null,
      branch: null,
    });

    // Use a PID that definitely doesn't exist
    db.prepare("UPDATE spawns SET pid = 999999 WHERE agent_handle = '@dead'").run();

    // Should not throw — just marks stopped
    killAgent(db, "@dead", tmpDir);
    const spawn = getSpawn(db, "@dead");
    assert.ok(spawn?.stopped_at);
  });

  it("throws for missing spawn record", () => {
    createAgent(db, { handle: "ghost", name: "Ghost", mission: "haunt" });
    assert.throws(() => killAgent(db, "@ghost", tmpDir), /No spawn record/);
  });

  it("throws for already stopped spawn", () => {
    createAgent(db, { handle: "stopped", name: "Stopped", mission: "stop" });
    insertSpawn(db, { agent_handle: "@stopped", pid: 111, log_path: null, worktree_path: null, branch: null });
    markSpawnStopped(db, "@stopped");

    assert.throws(() => killAgent(db, "@stopped", tmpDir), /already stopped/);
  });
});

// === PID checks ===

describe("isProcessAlive", () => {
  it("returns true for current process", () => {
    assert.ok(isProcessAlive(process.pid));
  });

  it("returns false for non-existent PID", () => {
    assert.ok(!isProcessAlive(999999));
  });
});
