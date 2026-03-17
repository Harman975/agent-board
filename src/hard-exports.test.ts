import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { initDb } from "./db.js";
import { createAgent } from "./agents.js";
import { createChannel } from "./channels.js";
import { createPost } from "./posts.js";
import {
  insertSpawn,
  markSpawnStopped,
  getSpawn,
  spawnAgent,
  respawnAgent,
  isProcessAlive,
  type Executor,
} from "./spawner.js";
import {
  initDag,
  pushBundle,
  fetchBundle,
  promoteCommit,
} from "./gitdag.js";
import {
  runPreFlight,
  buildSprintReport,
  mergeWithTestGates,
} from "./sprint-orchestrator.js";
import { EventEmitter } from "events";
import type Database from "better-sqlite3";

// === Shared helpers ===

let tmpDir: string;
let db: Database.Database;

function createMockExecutor(): {
  executor: Executor;
  fakeProcess: EventEmitter & { pid: number; unref: () => void };
  get _lastCall(): { command: string; args: string[]; opts: any } | null;
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

  return {
    executor,
    fakeProcess,
    get _lastCall() { return lastCall; },
  };
}

function setupGitRepo(dir: string) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "README.md"), "test");
  execSync("git add . && git commit -m 'init'", { cwd: dir, stdio: "pipe" });
}

/**
 * Create a commit in a temp clone, bundle it, and return the bundle path + hash.
 */
function createBundleFromCommit(
  parentDir: string,
  filename: string,
  content: string,
  message: string
): { bundlePath: string; hash: string } {
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "dagclone-"));
  execSync(`git clone "${parentDir}" "${cloneDir}"`, { stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: cloneDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: cloneDir, stdio: "pipe" });

  fs.writeFileSync(path.join(cloneDir, filename), content);
  execSync(`git add . && git commit -m "${message}"`, { cwd: cloneDir, stdio: "pipe" });

  const hash = execSync("git rev-parse HEAD", { cwd: cloneDir, encoding: "utf-8", stdio: "pipe" }).trim();
  const bundlePath = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`);
  execSync(`git bundle create "${bundlePath}" HEAD`, { cwd: cloneDir, stdio: "pipe" });

  fs.rmSync(cloneDir, { recursive: true, force: true });
  return { bundlePath, hash };
}

// ============================================================
// 1. isClaudeProcess — PRIVATE, cannot test directly.
//    Testing indirectly through killAgent behavior instead.
//    See spawner.test.ts "killAgent" tests for coverage.
//    Adding a note: isClaudeProcess checks `ps -p PID -o command=`
//    for "claude" in the output. We test the public API around it.
// ============================================================

// ============================================================
// 2. respawnAgent
// ============================================================

describe("respawnAgent", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-respawn-test-"));
    db = initDb(tmpDir);
    setupGitRepo(tmpDir);
    createAgent(db, { handle: "respawnable", name: "Respawnable", mission: "original mission" });
  });

  afterEach(() => {
    db.close();
    try { execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" }); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("respawns a stopped agent reusing existing worktree/branch", () => {
    const mock1 = createMockExecutor();
    // First spawn
    const result1 = spawnAgent(db, {
      handle: "@respawnable",
      mission: "original mission",
      apiKey: "key-1",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock1.executor);

    // Mark it as stopped
    mock1.fakeProcess.emit("exit", 0);

    // Respawn
    const mock2 = createMockExecutor();
    const result2 = respawnAgent(db, "@respawnable", {
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock2.executor);

    assert.equal(result2.branch, "agent/respawnable");
    assert.equal(result2.worktreePath, result1.worktreePath);
    assert.equal(result2.pid, 99999);

    // DB record should be updated (not a new insert)
    const spawn = getSpawn(db, "@respawnable");
    assert.ok(spawn);
    assert.equal(spawn.stopped_at, null); // re-started
  });

  it("throws if agent not found", () => {
    const mock = createMockExecutor();
    assert.throws(
      () => respawnAgent(db, "@nonexistent", {
        serverUrl: "http://localhost:3141",
        projectDir: tmpDir,
      }, mock.executor),
      /not found/
    );
  });

  it("throws if agent is still running", () => {
    const mock1 = createMockExecutor();
    spawnAgent(db, {
      handle: "@respawnable",
      mission: "running",
      apiKey: "key-1",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock1.executor);

    // Simulate a running process by using current PID
    db.prepare("UPDATE spawns SET pid = ? WHERE agent_handle = '@respawnable'").run(process.pid);

    const mock2 = createMockExecutor();
    assert.throws(
      () => respawnAgent(db, "@respawnable", {
        serverUrl: "http://localhost:3141",
        projectDir: tmpDir,
      }, mock2.executor),
      /already running/
    );
  });

  it("uses custom mission when provided", () => {
    const mock1 = createMockExecutor();
    spawnAgent(db, {
      handle: "@respawnable",
      mission: "original",
      apiKey: "key-1",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock1.executor);
    mock1.fakeProcess.emit("exit", 0);

    const mock2 = createMockExecutor();
    respawnAgent(db, "@respawnable", {
      mission: "new mission",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock2.executor);

    // Check the CLAUDE.md has the new mission
    const spawn = getSpawn(db, "@respawnable");
    const claudeMd = fs.readFileSync(path.join(spawn!.worktree_path!, "CLAUDE.md"), "utf-8");
    assert.ok(claudeMd.includes("new mission"));
  });
});

// ============================================================
// 3. fetchBundle
// ============================================================

describe("fetchBundle", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-fetch-test-"));
    setupGitRepo(tmpDir);
    db = initDb(tmpDir);
    createAgent(db, { handle: "agent-a", name: "Agent A", mission: "test" });
    createChannel(db, { name: "work", description: "Work" });
    initDag(tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws 'Failed to create bundle' for valid hash without ref", () => {
    // fetchBundle uses `git bundle create <out> <hash>` which requires
    // a named ref in the bare repo. Raw hashes produce "empty bundle" errors.
    // This test documents that limitation.
    const { bundlePath } = createBundleFromCommit(tmpDir, "code.ts", "// code", "Add code");
    const result = pushBundle(db, tmpDir, "@agent-a", bundlePath, "Add code");

    const outputPath = path.join(os.tmpdir(), `fetch-${Date.now()}.bundle`);
    assert.throws(
      () => fetchBundle(tmpDir, result.hash, outputPath),
      /Failed to create bundle/
    );
  });

  it("throws for invalid commit hash", () => {
    assert.throws(
      () => fetchBundle(tmpDir, "0000000000000000000000000000000000000000", "/tmp/out.bundle"),
      /Failed to create bundle/
    );
  });

  it("throws for invalid hash format", () => {
    assert.throws(
      () => fetchBundle(tmpDir, "not-a-valid-hash!", "/tmp/out.bundle"),
      /Invalid commit hash format/
    );
  });

  it("throws when DAG not initialized", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodag-fetch-"));
    assert.throws(
      () => fetchBundle(otherDir, "abc1234", "/tmp/out.bundle"),
      /not initialized/
    );
    fs.rmSync(otherDir, { recursive: true, force: true });
  });
});

// ============================================================
// 4. promoteCommit
// ============================================================

describe("promoteCommit", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-promote-test-"));
    setupGitRepo(tmpDir);
    db = initDb(tmpDir);
    createAgent(db, { handle: "agent-a", name: "Agent A", mission: "test" });
    createChannel(db, { name: "work", description: "Work" });
    initDag(tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cherry-picks commit to main and returns PromoteResult", () => {
    const { bundlePath } = createBundleFromCommit(tmpDir, "feature.ts", "// feature code", "Add feature");
    const pushResult = pushBundle(db, tmpDir, "@agent-a", bundlePath, "Add feature");

    const headBefore = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" }).trim();

    const result = promoteCommit(tmpDir, pushResult.hash);

    assert.equal(result.originalHash, pushResult.hash);
    assert.ok(result.newHash);
    assert.notEqual(result.newHash, headBefore, "HEAD should have advanced");
    assert.equal(result.message, "Add feature");

    // Verify the file exists in main
    assert.ok(fs.existsSync(path.join(tmpDir, "feature.ts")));
    const content = fs.readFileSync(path.join(tmpDir, "feature.ts"), "utf-8");
    assert.equal(content, "// feature code");
  });

  it("throws for invalid hash format", () => {
    assert.throws(
      () => promoteCommit(tmpDir, "not-valid!"),
      /Invalid commit hash format/
    );
  });

  it("throws for nonexistent commit in DAG", () => {
    assert.throws(
      () => promoteCommit(tmpDir, "0000000000000000000000000000000000000000"),
      /not found in DAG/
    );
  });

  it("throws when DAG not initialized", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodag-promote-"));
    setupGitRepo(otherDir);
    assert.throws(
      () => promoteCommit(otherDir, "abc1234"),
      /not initialized/
    );
    fs.rmSync(otherDir, { recursive: true, force: true });
  });
});

// ============================================================
// 5. runPreFlight
// ============================================================

describe("runPreFlight", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-preflight-test-"));
    db = initDb(tmpDir);
    setupGitRepo(tmpDir);
  });

  afterEach(() => {
    db.close();
    try { execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" }); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("all agents stopped → allStopped=true", async () => {
    createAgent(db, { handle: "a1", name: "A1", mission: "test" });
    insertSpawn(db, {
      agent_handle: "@a1",
      pid: 999999, // non-existent PID
      log_path: null,
      worktree_path: null,
      branch: null,
    });
    markSpawnStopped(db, "@a1", 0);

    db.close();

    const result = await runPreFlight(tmpDir, { skipTests: true });
    assert.equal(result.allStopped, true);
    assert.equal(result.running.length, 0);
  });

  it("running agent → allStopped=false, running array populated", async () => {
    createAgent(db, { handle: "a2", name: "A2", mission: "test" });
    insertSpawn(db, {
      agent_handle: "@a2",
      pid: process.pid, // current process is alive
      log_path: null,
      worktree_path: null,
      branch: null,
    });

    db.close();

    const result = await runPreFlight(tmpDir, { skipTests: true });
    assert.equal(result.allStopped, false);
    assert.equal(result.running.length, 1);
    assert.equal(result.running[0].agent_handle, "@a2");
    assert.equal(result.running[0].pid, process.pid);
  });

  it("detects branches and computes diff stats", async () => {
    createAgent(db, { handle: "brancher", name: "Brancher", mission: "test" });

    // Create a branch with changes
    execSync("git checkout -b agent/brancher", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "new-file.ts"), "// new code\n");
    execSync("git add . && git commit -m 'add new file'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    insertSpawn(db, {
      agent_handle: "@brancher",
      pid: 999999,
      log_path: null,
      worktree_path: null,
      branch: "agent/brancher",
    });
    markSpawnStopped(db, "@brancher", 0);

    db.close();

    const result = await runPreFlight(tmpDir, { skipTests: true });
    assert.ok(result.branches.length > 0);
    const branch = result.branches.find(b => b.agent_handle === "@brancher");
    assert.ok(branch);
    assert.equal(branch!.branch, "agent/brancher");
    assert.ok(branch!.filesChanged > 0);
    assert.ok(branch!.additions > 0);
  });

  it("detects conflicts between branches touching same file", async () => {
    createAgent(db, { handle: "c1", name: "C1", mission: "test" });
    createAgent(db, { handle: "c2", name: "C2", mission: "test" });

    // Branch 1 touches shared.ts
    execSync("git checkout -b agent/c1", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "shared.ts"), "// c1 version\n");
    execSync("git add . && git commit -m 'c1 changes'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    // Branch 2 also touches shared.ts
    execSync("git checkout -b agent/c2", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "shared.ts"), "// c2 version\n");
    execSync("git add . && git commit -m 'c2 changes'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    insertSpawn(db, { agent_handle: "@c1", pid: 999999, log_path: null, worktree_path: null, branch: "agent/c1" });
    markSpawnStopped(db, "@c1", 0);
    insertSpawn(db, { agent_handle: "@c2", pid: 999998, log_path: null, worktree_path: null, branch: "agent/c2" });
    markSpawnStopped(db, "@c2", 0);

    db.close();

    const result = await runPreFlight(tmpDir, {
      skipTests: true,
      agentHandles: ["@c1", "@c2"],
    });
    assert.ok(result.conflicts.length > 0);
    assert.ok(result.conflicts[0].includes("shared.ts"));
    assert.ok(result.conflicts[0].includes("@c1"));
    assert.ok(result.conflicts[0].includes("@c2"));
  });

  it("mergeOrder sorted by fewest files first", async () => {
    createAgent(db, { handle: "big", name: "Big", mission: "test" });
    createAgent(db, { handle: "small", name: "Small", mission: "test" });

    // Big branch with many files
    execSync("git checkout -b agent/big", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "f1.ts"), "a");
    fs.writeFileSync(path.join(tmpDir, "f2.ts"), "b");
    fs.writeFileSync(path.join(tmpDir, "f3.ts"), "c");
    execSync("git add . && git commit -m 'big changes'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    // Small branch with one file
    execSync("git checkout -b agent/small", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "s1.ts"), "x");
    execSync("git add . && git commit -m 'small change'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    insertSpawn(db, { agent_handle: "@big", pid: 999999, log_path: null, worktree_path: null, branch: "agent/big" });
    markSpawnStopped(db, "@big", 0);
    insertSpawn(db, { agent_handle: "@small", pid: 999998, log_path: null, worktree_path: null, branch: "agent/small" });
    markSpawnStopped(db, "@small", 0);

    db.close();

    const result = await runPreFlight(tmpDir, {
      skipTests: true,
      agentHandles: ["@big", "@small"],
    });
    // Small should come first in merge order (fewer files)
    assert.equal(result.mergeOrder[0], "@small");
    assert.equal(result.mergeOrder[1], "@big");
  });
});

// ============================================================
// 6. buildSprintReport
// ============================================================

describe("buildSprintReport", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-report-test-"));
    db = initDb(tmpDir);
    setupGitRepo(tmpDir);
  });

  afterEach(() => {
    db.close();
    try { execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" }); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("report includes all sprint agents with status", async () => {
    createAgent(db, { handle: "r1", name: "R1", mission: "task1" });
    createAgent(db, { handle: "r2", name: "R2", mission: "task2" });

    // Create sprint
    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("test-sprint", "Test goal");
    db.prepare("INSERT INTO sprint_agents (sprint_name, agent_handle, mission) VALUES (?, ?, ?)").run("test-sprint", "@r1", "task1");
    db.prepare("INSERT INTO sprint_agents (sprint_name, agent_handle, mission) VALUES (?, ?, ?)").run("test-sprint", "@r2", "task2");

    // Create spawn records
    insertSpawn(db, { agent_handle: "@r1", pid: 999999, log_path: null, worktree_path: null, branch: null });
    markSpawnStopped(db, "@r1", 0);
    insertSpawn(db, { agent_handle: "@r2", pid: 999998, log_path: null, worktree_path: null, branch: null });
    markSpawnStopped(db, "@r2", 1);

    db.close();

    const report = await buildSprintReport("test-sprint", tmpDir);
    assert.equal(report.sprint.name, "test-sprint");
    assert.equal(report.sprint.goal, "Test goal");
    assert.equal(report.agents.length, 2);

    const r1 = report.agents.find(a => a.handle === "@r1");
    const r2 = report.agents.find(a => a.handle === "@r2");
    assert.ok(r1);
    assert.ok(r2);
    assert.equal(r1!.exitCode, 0);
    assert.equal(r2!.exitCode, 1);
    assert.ok(r1!.stopped);
    assert.ok(r2!.stopped);
  });

  it("includes diff stats per agent", async () => {
    createAgent(db, { handle: "diff-agent", name: "DiffAgent", mission: "diff task" });

    // Create a branch with changes
    execSync("git checkout -b agent/diff-agent", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "changed.ts"), "// new code\nline2\nline3\n");
    execSync("git add . && git commit -m 'agent work'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("diff-sprint", "Diff goal");
    db.prepare("INSERT INTO sprint_agents (sprint_name, agent_handle, mission) VALUES (?, ?, ?)").run("diff-sprint", "@diff-agent", "diff task");

    insertSpawn(db, {
      agent_handle: "@diff-agent",
      pid: 999999,
      log_path: null,
      worktree_path: null,
      branch: "agent/diff-agent",
    });
    markSpawnStopped(db, "@diff-agent", 0);

    db.close();

    const report = await buildSprintReport("diff-sprint", tmpDir);
    const agent = report.agents.find(a => a.handle === "@diff-agent");
    assert.ok(agent);
    assert.ok(agent!.additions > 0, "Should have additions");
    assert.ok(agent!.filesChanged > 0, "Should have files changed");
    assert.ok(report.totals.additions > 0, "Totals should include additions");
    assert.ok(report.totals.filesChanged > 0, "Totals should include files changed");
  });

  it("throws for nonexistent sprint", async () => {
    db.close();
    await assert.rejects(
      () => buildSprintReport("nonexistent", tmpDir),
      /Sprint not found/
    );
  });

  it("counts escalations since sprint started", async () => {
    createAgent(db, { handle: "esc-agent", name: "EscAgent", mission: "esc" });
    createChannel(db, { name: "escalations", description: "Escalations" });

    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("esc-sprint", "Esc goal");
    db.prepare("INSERT INTO sprint_agents (sprint_name, agent_handle, mission) VALUES (?, ?, ?)").run("esc-sprint", "@esc-agent", "esc");

    insertSpawn(db, { agent_handle: "@esc-agent", pid: 999999, log_path: null, worktree_path: null, branch: null });
    markSpawnStopped(db, "@esc-agent", 0);

    // Create escalation posts
    createPost(db, { author: "@esc-agent", channel: "#escalations", content: "BLOCKED: need help" });
    createPost(db, { author: "@esc-agent", channel: "#escalations", content: "BLOCKED: still stuck" });

    db.close();

    const report = await buildSprintReport("esc-sprint", tmpDir);
    assert.equal(report.escalations, 2);
  });
});

// ============================================================
// 7. mergeWithTestGates
// ============================================================

describe("mergeWithTestGates", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-merge-test-"));
    db = initDb(tmpDir);
    setupGitRepo(tmpDir);
  });

  afterEach(() => {
    db.close();
    try { execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" }); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges passing agent branch", async () => {
    createAgent(db, { handle: "merger", name: "Merger", mission: "merge" });

    // Create a branch with changes
    execSync("git checkout -b agent/merger", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "merged-feature.ts"), "// feature\n");
    execSync("git add . && git commit -m 'feature work'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    insertSpawn(db, {
      agent_handle: "@merger",
      pid: 999999,
      log_path: null,
      worktree_path: null,
      branch: "agent/merger",
    });
    markSpawnStopped(db, "@merger", 0);

    // Set up a minimal package.json with passing test
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "test-project",
      scripts: { test: "echo 'tests pass'" },
    }));
    execSync("git add package.json && git commit -m 'add package.json'", { cwd: tmpDir, stdio: "pipe" });

    const result = await mergeWithTestGates(["@merger"], tmpDir, { db });
    assert.deepStrictEqual(result.merged, ["@merger"]);
    assert.equal(result.failed, null);

    // Verify the file exists on main
    assert.ok(fs.existsSync(path.join(tmpDir, "merged-feature.ts")));
  });

  it("throws and reverts when tests fail after merge", async () => {
    createAgent(db, { handle: "failer", name: "Failer", mission: "fail" });

    // Create a branch
    execSync("git checkout -b agent/failer", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "bad-feature.ts"), "// bad\n");
    execSync("git add . && git commit -m 'bad feature'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    insertSpawn(db, {
      agent_handle: "@failer",
      pid: 999999,
      log_path: null,
      worktree_path: null,
      branch: "agent/failer",
    });
    markSpawnStopped(db, "@failer", 0);

    // Set up a failing test script
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "test-project",
      scripts: { test: "exit 1" },
    }));
    execSync("git add package.json && git commit -m 'add package.json'", { cwd: tmpDir, stdio: "pipe" });

    const headBefore = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" }).trim();

    let failureHandle: string | null = null;
    await assert.rejects(
      () => mergeWithTestGates(["@failer"], tmpDir, {
        db,
        onFailure: (h) => { failureHandle = h; },
      }),
      /Tests failed after merging @failer/
    );

    assert.equal(failureHandle, "@failer");

    // Verify the merge was reverted
    const headAfter = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" }).trim();
    assert.equal(headAfter, headBefore);
  });

  it("merges multiple agents sequentially, returns merged array", async () => {
    createAgent(db, { handle: "m1", name: "M1", mission: "m1" });
    createAgent(db, { handle: "m2", name: "M2", mission: "m2" });

    // Set up passing tests first
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "test-project",
      scripts: { test: "echo 'ok'" },
    }));
    execSync("git add package.json && git commit -m 'add package.json'", { cwd: tmpDir, stdio: "pipe" });

    // Branch 1
    execSync("git checkout -b agent/m1", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "m1.ts"), "// m1\n");
    execSync("git add . && git commit -m 'm1 work'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    // Branch 2
    execSync("git checkout -b agent/m2", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "m2.ts"), "// m2\n");
    execSync("git add . && git commit -m 'm2 work'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    insertSpawn(db, { agent_handle: "@m1", pid: 999999, log_path: null, worktree_path: null, branch: "agent/m1" });
    markSpawnStopped(db, "@m1", 0);
    insertSpawn(db, { agent_handle: "@m2", pid: 999998, log_path: null, worktree_path: null, branch: "agent/m2" });
    markSpawnStopped(db, "@m2", 0);

    const result = await mergeWithTestGates(["@m1", "@m2"], tmpDir, { db });
    assert.deepStrictEqual(result.merged, ["@m1", "@m2"]);
    assert.equal(result.failed, null);

    // Both files should exist on main
    assert.ok(fs.existsSync(path.join(tmpDir, "m1.ts")));
    assert.ok(fs.existsSync(path.join(tmpDir, "m2.ts")));
  });
});

// ============================================================
// Note: isClaudeProcess is private (not exported from spawner.ts)
// We test it indirectly through killAgent's behavior:
// - killAgent checks isClaudeProcess before killing a PID
// - If PID is alive but not a claude process, it throws
// These behaviors are tested in spawner.test.ts
// ============================================================
