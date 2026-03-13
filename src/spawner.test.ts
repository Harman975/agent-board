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

// === node_modules symlink ===

describe("spawnAgent node_modules symlink", () => {
  beforeEach(() => {
    createAgent(db, { handle: "symtest", name: "SymTest", mission: "test symlink" });
    // Create a fake node_modules in the project root
    fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "node_modules", ".package-lock.json"), "{}");
  });

  it("symlinks node_modules from project root into worktree", () => {
    const mock = createMockExecutor();
    const result = spawnAgent(db, {
      handle: "@symtest",
      mission: "test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    const symlinkPath = path.join(result.worktreePath, "node_modules");
    assert.ok(fs.existsSync(symlinkPath), "node_modules should exist in worktree");
    const stat = fs.lstatSync(symlinkPath);
    assert.ok(stat.isSymbolicLink(), "node_modules should be a symlink");
    const target = fs.readlinkSync(symlinkPath);
    assert.equal(target, path.join(tmpDir, "node_modules"));
  });

  it("does not create symlink if project has no node_modules", () => {
    // Remove node_modules
    fs.rmSync(path.join(tmpDir, "node_modules"), { recursive: true });

    const mock = createMockExecutor();
    const result = spawnAgent(db, {
      handle: "@symtest",
      mission: "test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    const symlinkPath = path.join(result.worktreePath, "node_modules");
    assert.ok(!fs.existsSync(symlinkPath), "node_modules should not exist without source");
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

// === getSpawn edge cases ===

describe("getSpawn edge cases", () => {
  it("returns null for nonexistent handle", () => {
    assert.equal(getSpawn(db, "@nonexistent"), null);
  });

  it("normalizes handle before lookup", () => {
    createAgent(db, { handle: "findme", name: "FindMe", mission: "test" });
    insertSpawn(db, { agent_handle: "@findme", pid: 111, log_path: null, worktree_path: null, branch: null });
    // Look up without @
    const spawn = getSpawn(db, "findme");
    assert.ok(spawn);
    assert.equal(spawn.agent_handle, "@findme");
  });
});

// === markSpawnStopped edge cases ===

describe("markSpawnStopped edge cases", () => {
  it("normalizes handle", () => {
    createAgent(db, { handle: "norm", name: "Norm", mission: "test" });
    insertSpawn(db, { agent_handle: "@norm", pid: 111, log_path: null, worktree_path: null, branch: null });
    // Call without @
    markSpawnStopped(db, "norm");
    const spawn = getSpawn(db, "@norm");
    assert.ok(spawn?.stopped_at);
  });

  it("is a no-op for already-stopped spawns", () => {
    createAgent(db, { handle: "done", name: "Done", mission: "test" });
    insertSpawn(db, { agent_handle: "@done", pid: 111, log_path: null, worktree_path: null, branch: null });
    markSpawnStopped(db, "@done");
    const first = getSpawn(db, "@done")!;
    // Mark again — should not throw
    markSpawnStopped(db, "@done");
    const second = getSpawn(db, "@done")!;
    assert.equal(first.stopped_at, second.stopped_at);
  });
});

// === listSpawns edge cases ===

describe("listSpawns edge cases", () => {
  it("returns empty array when no spawns", () => {
    assert.deepStrictEqual(listSpawns(db, true), []);
    assert.deepStrictEqual(listSpawns(db, false), []);
  });

  it("default activeOnly=false returns all", () => {
    createAgent(db, { handle: "s1", name: "S1", mission: "test" });
    createAgent(db, { handle: "s2", name: "S2", mission: "test" });
    insertSpawn(db, { agent_handle: "@s1", pid: 111, log_path: null, worktree_path: null, branch: null });
    insertSpawn(db, { agent_handle: "@s2", pid: 222, log_path: null, worktree_path: null, branch: null });
    markSpawnStopped(db, "@s1");

    const all = listSpawns(db);
    assert.equal(all.length, 2);
  });

  it("spawns ordered by started_at DESC", () => {
    createAgent(db, { handle: "first", name: "First", mission: "test" });
    createAgent(db, { handle: "second", name: "Second", mission: "test" });
    // Insert with explicit timestamps to guarantee ordering
    db.prepare("INSERT INTO spawns (agent_handle, pid, started_at) VALUES (?, ?, ?)").run(
      "@first", 111, "2026-01-01T00:00:00Z"
    );
    db.prepare("INSERT INTO spawns (agent_handle, pid, started_at) VALUES (?, ?, ?)").run(
      "@second", 222, "2026-01-02T00:00:00Z"
    );

    const all = listSpawns(db, false);
    // Most recent first
    assert.equal(all[0].agent_handle, "@second");
    assert.equal(all[1].agent_handle, "@first");
  });
});

// === ensureWorkChannels ===

describe("spawnAgent channel creation", () => {
  it("creates #work, #escalations, and #status channels", () => {
    createAgent(db, { handle: "chantest", name: "ChanTest", mission: "test" });
    assert.equal(getChannel(db, "#work"), null);
    assert.equal(getChannel(db, "#escalations"), null);
    assert.equal(getChannel(db, "#status"), null);

    const mock = createMockExecutor();
    spawnAgent(db, {
      handle: "@chantest",
      mission: "test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    assert.ok(getChannel(db, "#work"));
    assert.ok(getChannel(db, "#escalations"));
    assert.ok(getChannel(db, "#status"));
  });

  it("does not fail if channels already exist", () => {
    createAgent(db, { handle: "chantest2", name: "ChanTest2", mission: "test" });
    createChannel(db, { name: "work" });
    createChannel(db, { name: "escalations" });
    createChannel(db, { name: "status" });

    const mock = createMockExecutor();
    // Should not throw
    spawnAgent(db, {
      handle: "@chantest2",
      mission: "test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);
  });
});

// === spawnAgent foreground mode ===

describe("spawnAgent foreground mode", () => {
  it("returns child process in foreground mode", () => {
    createAgent(db, { handle: "fg", name: "FG", mission: "foreground test" });
    const mock = createMockExecutor();
    const result = spawnAgent(db, {
      handle: "@fg",
      mission: "foreground test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
      foreground: true,
    }, mock.executor);

    assert.ok(result.child); // foreground returns child
    assert.equal(mock._lastCall?.opts.stdio, "inherit");
    assert.equal(mock._lastCall?.opts.detached, false);
  });

  it("does not create log file in foreground mode", () => {
    createAgent(db, { handle: "fgnolog", name: "FGNoLog", mission: "no log" });
    const mock = createMockExecutor();
    const result = spawnAgent(db, {
      handle: "@fgnolog",
      mission: "no log",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
      foreground: true,
    }, mock.executor);

    const spawn = getSpawn(db, "@fgnolog");
    assert.equal(spawn?.log_path, null);
  });
});

// === spawnAgent reuses existing worktree ===

describe("spawnAgent worktree reuse", () => {
  it("reuses existing worktree if already present", () => {
    createAgent(db, { handle: "reuse", name: "Reuse", mission: "test" });
    const mock = createMockExecutor();

    // First spawn creates the worktree
    const result1 = spawnAgent(db, {
      handle: "@reuse",
      mission: "test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    // Remove the spawn record so we can spawn again
    db.prepare("DELETE FROM spawns WHERE agent_handle = '@reuse'").run();

    // Second spawn should reuse the worktree
    const result2 = spawnAgent(db, {
      handle: "@reuse",
      mission: "test again",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    assert.equal(result1.worktreePath, result2.worktreePath);
  });
});

// === killAgent edge cases ===

describe("killAgent edge cases", () => {
  it("normalizes handle without @", () => {
    createAgent(db, { handle: "killnorm", name: "KillNorm", mission: "test" });
    insertSpawn(db, { agent_handle: "@killnorm", pid: 999999, log_path: null, worktree_path: null, branch: null });

    // Should not throw — PID doesn't exist, so marks stopped
    killAgent(db, "killnorm", tmpDir);
    const spawn = getSpawn(db, "@killnorm");
    assert.ok(spawn?.stopped_at);
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
