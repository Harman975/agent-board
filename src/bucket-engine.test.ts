import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import type Database from "better-sqlite3";
import { initDb } from "./db.js";
import { createAgent } from "./agents.js";
import { createChannel } from "./channels.js";
import { createPost } from "./posts.js";
import { insertSpawn } from "./spawner.js";
import {
  inferBucket,
  inferAllBuckets,
  BoardEventEmitter,
  type GitOps,
  type BucketState,
} from "./bucket-engine.js";

// === Helpers ===

function mockGitOps(overrides: Partial<GitOps> = {}): GitOps {
  return {
    hasBranchCommits: () => false,
    isBranchMerged: () => false,
    ...overrides,
  };
}

function setupAgent(db: Database.Database, handle: string) {
  createAgent(db, { handle, name: handle.replace("@", ""), mission: "test" });
}

function setupChannels(db: Database.Database) {
  createChannel(db, { name: "escalations" });
  createChannel(db, { name: "work" });
  createChannel(db, { name: "status" });
}

function insertSpawnRecord(
  db: Database.Database,
  handle: string,
  overrides: {
    pid?: number;
    branch?: string;
    stopped_at?: string | null;
    exit_code?: number | null;
    started_at?: string;
  } = {}
) {
  const h = handle.startsWith("@") ? handle : `@${handle}`;
  insertSpawn(db, {
    agent_handle: h,
    pid: overrides.pid ?? 99999,
    log_path: null,
    worktree_path: "/tmp/fake",
    branch: overrides.branch ?? "agent/test",
    exit_code: overrides.exit_code ?? null,
  });
  // Update stopped_at and started_at if needed
  if (overrides.stopped_at !== undefined) {
    db.prepare("UPDATE spawns SET stopped_at = ? WHERE agent_handle = ?").run(
      overrides.stopped_at,
      h
    );
  }
  if (overrides.exit_code !== undefined) {
    db.prepare("UPDATE spawns SET exit_code = ? WHERE agent_handle = ?").run(
      overrides.exit_code,
      h
    );
  }
  if (overrides.started_at !== undefined) {
    db.prepare("UPDATE spawns SET started_at = ? WHERE agent_handle = ?").run(
      overrides.started_at,
      h
    );
  }
}

// === Tests ===

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bucket-test-"));
  db = initDb(tmpDir);
  setupChannels(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("inferBucket", () => {
  it("returns planning when no spawn record exists", () => {
    setupAgent(db, "alpha");
    const state = inferBucket({ db, agentHandle: "alpha", gitOps: mockGitOps() });
    assert.equal(state, "planning");
  });

  it("returns blocked when agent has recent escalation", () => {
    setupAgent(db, "alpha");
    insertSpawnRecord(db, "alpha", { pid: process.pid });
    createPost(db, { author: "@alpha", channel: "#escalations", content: "BLOCKED: need help" });
    const state = inferBucket({ db, agentHandle: "alpha", gitOps: mockGitOps() });
    assert.equal(state, "blocked");
  });

  it("returns blocked when exit code is non-zero", () => {
    setupAgent(db, "alpha");
    insertSpawnRecord(db, "alpha", {
      pid: 1, // dead PID
      stopped_at: new Date().toISOString(),
      exit_code: 1,
    });
    const state = inferBucket({ db, agentHandle: "alpha", gitOps: mockGitOps() });
    assert.equal(state, "blocked");
  });

  it("returns done when branch is merged", () => {
    setupAgent(db, "alpha");
    insertSpawnRecord(db, "alpha", {
      pid: 1,
      branch: "agent/alpha",
      stopped_at: new Date().toISOString(),
      exit_code: 0,
    });
    const gitOps = mockGitOps({ isBranchMerged: () => true });
    const state = inferBucket({ db, agentHandle: "alpha", gitOps });
    assert.equal(state, "done");
  });

  it("returns review when stopped with exit 0 and branch has commits", () => {
    setupAgent(db, "alpha");
    insertSpawnRecord(db, "alpha", {
      pid: 1,
      branch: "agent/alpha",
      stopped_at: new Date().toISOString(),
      exit_code: 0,
    });
    const gitOps = mockGitOps({ hasBranchCommits: () => true });
    const state = inferBucket({ db, agentHandle: "alpha", gitOps });
    assert.equal(state, "review");
  });

  it("returns in_progress when alive and has commits", () => {
    setupAgent(db, "alpha");
    // Use current process PID so isProcessAlive returns true
    insertSpawnRecord(db, "alpha", { pid: process.pid, branch: "agent/alpha" });
    const gitOps = mockGitOps({ hasBranchCommits: () => true });
    const state = inferBucket({ db, agentHandle: "alpha", gitOps });
    assert.equal(state, "in_progress");
  });

  it("returns planning when alive, no commits, and recent activity", () => {
    setupAgent(db, "alpha");
    insertSpawnRecord(db, "alpha", { pid: process.pid, branch: "agent/alpha" });
    // started_at is set to now by default → recent
    const state = inferBucket({ db, agentHandle: "alpha", gitOps: mockGitOps() });
    assert.equal(state, "planning");
  });

  it("returns blocked (zombie) when alive, no commits, no recent activity", () => {
    setupAgent(db, "alpha");
    const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min ago
    insertSpawnRecord(db, "alpha", {
      pid: process.pid,
      branch: "agent/alpha",
      started_at: oldTime,
    });
    // No posts at all → last activity falls back to started_at which is old
    const state = inferBucket({ db, agentHandle: "alpha", gitOps: mockGitOps() });
    assert.equal(state, "blocked");
  });

  it("normalizes handle with or without @", () => {
    setupAgent(db, "alpha");
    insertSpawnRecord(db, "alpha");
    const s1 = inferBucket({ db, agentHandle: "alpha", gitOps: mockGitOps() });
    const s2 = inferBucket({ db, agentHandle: "@alpha", gitOps: mockGitOps() });
    assert.equal(s1, s2);
  });

  it("returns planning as default for stopped process with no special conditions", () => {
    setupAgent(db, "alpha");
    insertSpawnRecord(db, "alpha", {
      pid: 1,
      stopped_at: new Date().toISOString(),
      exit_code: 0,
    });
    // No commits, not merged → falls through to planning
    const state = inferBucket({ db, agentHandle: "alpha", gitOps: mockGitOps() });
    assert.equal(state, "planning");
  });
});

describe("inferAllBuckets", () => {
  it("returns bucket state for all agents in a sprint", () => {
    setupAgent(db, "alpha");
    setupAgent(db, "beta");
    setupAgent(db, "gamma");

    // Create sprint
    db.prepare("INSERT INTO sprints (name, goal, status) VALUES (?, ?, ?)").run(
      "sprint-1",
      "test goal",
      "running"
    );
    db.prepare("INSERT INTO sprint_agents (sprint_name, agent_handle) VALUES (?, ?)").run(
      "sprint-1",
      "@alpha"
    );
    db.prepare("INSERT INTO sprint_agents (sprint_name, agent_handle) VALUES (?, ?)").run(
      "sprint-1",
      "@beta"
    );
    db.prepare("INSERT INTO sprint_agents (sprint_name, agent_handle) VALUES (?, ?)").run(
      "sprint-1",
      "@gamma"
    );

    // alpha: no spawn → planning
    // beta: alive with commits → in_progress
    insertSpawnRecord(db, "beta", { pid: process.pid, branch: "agent/beta" });
    // gamma: stopped with exit 1 → blocked
    insertSpawnRecord(db, "gamma", {
      pid: 1,
      stopped_at: new Date().toISOString(),
      exit_code: 1,
    });

    const gitOps = mockGitOps({
      hasBranchCommits: (_dir, branch) => branch === "agent/beta",
    });

    const buckets = inferAllBuckets({ db, sprintName: "sprint-1", gitOps });

    assert.equal(buckets.size, 3);
    assert.equal(buckets.get("@alpha"), "planning");
    assert.equal(buckets.get("@beta"), "in_progress");
    assert.equal(buckets.get("@gamma"), "blocked");
  });

  it("returns empty map for sprint with no agents", () => {
    db.prepare("INSERT INTO sprints (name, goal, status) VALUES (?, ?, ?)").run(
      "empty-sprint",
      "nothing",
      "running"
    );
    const buckets = inferAllBuckets({ db, sprintName: "empty-sprint", gitOps: mockGitOps() });
    assert.equal(buckets.size, 0);
  });
});

describe("BoardEventEmitter", () => {
  it("emits and receives post_created events", () => {
    const emitter = new BoardEventEmitter();
    let received: { author: string; channel: string; content: string } | null = null;
    emitter.on("post_created", (data) => {
      received = data;
    });
    emitter.emit("post_created", { author: "@alpha", channel: "#work", content: "hello" });
    assert.deepStrictEqual(received, { author: "@alpha", channel: "#work", content: "hello" });
  });

  it("emits and receives spawn_stopped events", () => {
    const emitter = new BoardEventEmitter();
    let received: { agent_handle: string; exit_code: number | null } | null = null;
    emitter.on("spawn_stopped", (data) => {
      received = data;
    });
    emitter.emit("spawn_stopped", { agent_handle: "@alpha", exit_code: 0 });
    assert.deepStrictEqual(received, { agent_handle: "@alpha", exit_code: 0 });
  });

  it("emits and receives bucket_changed events", () => {
    const emitter = new BoardEventEmitter();
    let received: { agent_handle: string; from: BucketState; to: BucketState } | null = null;
    emitter.on("bucket_changed", (data) => {
      received = data;
    });
    emitter.emit("bucket_changed", {
      agent_handle: "@alpha",
      from: "planning",
      to: "in_progress",
    });
    assert.deepStrictEqual(received, {
      agent_handle: "@alpha",
      from: "planning",
      to: "in_progress",
    });
  });

  it("supports multiple listeners on same event", () => {
    const emitter = new BoardEventEmitter();
    const calls: string[] = [];
    emitter.on("post_created", () => calls.push("a"));
    emitter.on("post_created", () => calls.push("b"));
    emitter.emit("post_created", { author: "@x", channel: "#y", content: "z" });
    assert.deepStrictEqual(calls, ["a", "b"]);
  });

  it("handles null exit_code in spawn_stopped", () => {
    const emitter = new BoardEventEmitter();
    let received: { agent_handle: string; exit_code: number | null } | null = null;
    emitter.on("spawn_stopped", (data) => {
      received = data;
    });
    emitter.emit("spawn_stopped", { agent_handle: "@beta", exit_code: null });
    assert.equal(received!.exit_code, null);
  });
});

describe("zombie detection", () => {
  it("alive process with old start and no posts is blocked", () => {
    setupAgent(db, "zombie");
    const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
    insertSpawnRecord(db, "zombie", {
      pid: process.pid,
      branch: "agent/zombie",
      started_at: oldTime,
    });
    const state = inferBucket({ db, agentHandle: "zombie", gitOps: mockGitOps() });
    assert.equal(state, "blocked");
  });

  it("alive process with old start but recent post is not zombie", () => {
    setupAgent(db, "active");
    const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    insertSpawnRecord(db, "active", {
      pid: process.pid,
      branch: "agent/active",
      started_at: oldTime,
    });
    // Recent post → last activity is recent
    createPost(db, { author: "@active", channel: "#work", content: "still working" });
    const state = inferBucket({ db, agentHandle: "active", gitOps: mockGitOps() });
    assert.equal(state, "planning");
  });
});
