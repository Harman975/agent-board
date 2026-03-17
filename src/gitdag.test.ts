import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { initDb } from "./db.js";
import { createAgent } from "./agents.js";
import { createChannel } from "./channels.js";
import {
  initDag,
  dagExists,
  pushBundle,
  listDagCommits,
  getDagCommit,
  getLeaves,
  getChildren,
  diffCommits,
  getDagSummary,
} from "./gitdag.js";
import type Database from "better-sqlite3";

// === Test helpers ===

let tmpDir: string;
let db: Database.Database;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dagtest-"));
  // Init a real git repo in tmpDir so worktrees/bundles work
  execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "pipe" });
  // Need at least one commit for bundles to work
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# test");
  execSync("git add . && git commit -m 'init'", { cwd: tmpDir, stdio: "pipe" });

  db = initDb(tmpDir);
  createAgent(db, { handle: "agent-a", name: "Agent A", mission: "Test agent" });
  createAgent(db, { handle: "agent-b", name: "Agent B", mission: "Test agent B" });
  createChannel(db, { name: "work", description: "Work updates" });
}

function teardown() {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Create a commit in a temp clone, bundle it, and return the bundle path.
 * This simulates what an agent would do in their worktree.
 */
function createBundleFromCommit(
  parentDir: string,
  filename: string,
  content: string,
  message: string
): { bundlePath: string; hash: string } {
  // Create a temp clone to make commits in
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "dagclone-"));
  execSync(`git clone "${parentDir}" "${cloneDir}"`, { stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: cloneDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: cloneDir, stdio: "pipe" });

  fs.writeFileSync(path.join(cloneDir, filename), content);
  execSync(`git add . && git commit -m "${message}"`, { cwd: cloneDir, stdio: "pipe" });

  const hash = execSync("git rev-parse HEAD", { cwd: cloneDir, encoding: "utf-8", stdio: "pipe" }).trim();

  const bundlePath = path.join(os.tmpdir(), `test-${Date.now()}.bundle`);
  execSync(`git bundle create "${bundlePath}" HEAD`, { cwd: cloneDir, stdio: "pipe" });

  // Cleanup clone
  fs.rmSync(cloneDir, { recursive: true, force: true });

  return { bundlePath, hash };
}

// === Tests ===

describe("initDag", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("creates a bare git repo in .dag/", () => {
    const dagPath = initDag(tmpDir);
    assert.ok(fs.existsSync(dagPath));
    assert.ok(fs.existsSync(path.join(dagPath, "HEAD")));
  });

  it("is idempotent — second call returns same path", () => {
    const p1 = initDag(tmpDir);
    const p2 = initDag(tmpDir);
    assert.equal(p1, p2);
  });
});

describe("dagExists", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns false before init", () => {
    assert.equal(dagExists(tmpDir), false);
  });

  it("returns true after init", () => {
    initDag(tmpDir);
    assert.equal(dagExists(tmpDir), true);
  });
});

describe("pushBundle", () => {
  beforeEach(() => {
    setup();
    initDag(tmpDir);
  });
  afterEach(teardown);

  it("unbundles and records commit in dag_commits", () => {
    const { bundlePath } = createBundleFromCommit(tmpDir, "auth.ts", "// auth", "Add auth module");
    const result = pushBundle(db, tmpDir, "@agent-a", bundlePath, "Add auth module");

    assert.ok(result.hash);
    assert.equal(result.agentHandle, "@agent-a");
    assert.equal(result.message, "Add auth module");

    // Verify it's in the DB
    const commit = getDagCommit(db, result.hash);
    assert.ok(commit);
    assert.equal(commit!.agent_handle, "@agent-a");
    assert.equal(commit!.message, "Add auth module");
  });

  it("throws for nonexistent bundle file", () => {
    assert.throws(
      () => pushBundle(db, tmpDir, "@agent-a", "/nonexistent.bundle", "msg"),
      /not found/
    );
  });

  it("throws when DAG is not initialized", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodag-"));
    assert.throws(
      () => pushBundle(db, otherDir, "@agent-a", "/foo.bundle", "msg"),
      /not initialized/
    );
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it("validates agent handle to prevent injection", () => {
    assert.throws(
      () => pushBundle(db, tmpDir, "'; rm -rf /", "/foo.bundle", "msg"),
      /Invalid handle/
    );
  });

  it("INSERT OR IGNORE prevents duplicate hash errors", () => {
    const { bundlePath } = createBundleFromCommit(tmpDir, "dup.ts", "// dup", "Dup commit");
    const r1 = pushBundle(db, tmpDir, "@agent-a", bundlePath, "First push");

    // Push the same bundle again — should not throw
    const { bundlePath: bp2 } = createBundleFromCommit(tmpDir, "dup.ts", "// dup", "Dup commit");
    // The same commit hash will be in the bundle, so INSERT OR IGNORE handles it
    pushBundle(db, tmpDir, "@agent-a", bp2, "Second push");

    // Original record preserved
    const commit = getDagCommit(db, r1.hash);
    assert.equal(commit!.message, "First push");
  });
});

describe("listDagCommits", () => {
  beforeEach(() => {
    setup();
    initDag(tmpDir);
  });
  afterEach(teardown);

  it("returns all commits", () => {
    const { bundlePath: b1 } = createBundleFromCommit(tmpDir, "a.ts", "// a", "First");
    pushBundle(db, tmpDir, "@agent-a", b1, "First");

    const { bundlePath: b2 } = createBundleFromCommit(tmpDir, "b.ts", "// b", "Second");
    pushBundle(db, tmpDir, "@agent-b", b2, "Second");

    const commits = listDagCommits(db);
    assert.equal(commits.length, 2);
    const messages = commits.map((c) => c.message).sort();
    assert.deepEqual(messages, ["First", "Second"]);
  });

  it("filters by agent handle", () => {
    const { bundlePath: b1 } = createBundleFromCommit(tmpDir, "a.ts", "// a", "A's work");
    pushBundle(db, tmpDir, "@agent-a", b1, "A's work");

    const { bundlePath: b2 } = createBundleFromCommit(tmpDir, "b.ts", "// b", "B's work");
    pushBundle(db, tmpDir, "@agent-b", b2, "B's work");

    const filtered = listDagCommits(db, { agentHandle: "agent-a" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].agent_handle, "@agent-a");
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      const { bundlePath } = createBundleFromCommit(tmpDir, `f${i}.ts`, `// ${i}`, `Commit ${i}`);
      pushBundle(db, tmpDir, "@agent-a", bundlePath, `Commit ${i}`);
    }

    const limited = listDagCommits(db, { limit: 3 });
    assert.equal(limited.length, 3);
  });

  it("returns empty array when no commits", () => {
    const commits = listDagCommits(db);
    assert.equal(commits.length, 0);
  });
});

describe("getLeaves", () => {
  beforeEach(() => {
    setup();
    initDag(tmpDir);
  });
  afterEach(teardown);

  it("returns commits with no children", () => {
    const { bundlePath } = createBundleFromCommit(tmpDir, "leaf.ts", "// leaf", "Leaf commit");
    const result = pushBundle(db, tmpDir, "@agent-a", bundlePath, "Leaf commit");

    const leaves = getLeaves(db);
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0].hash, result.hash);
  });

  it("filters by agent handle", () => {
    const { bundlePath: b1 } = createBundleFromCommit(tmpDir, "a.ts", "// a", "A leaf");
    pushBundle(db, tmpDir, "@agent-a", b1, "A leaf");

    const { bundlePath: b2 } = createBundleFromCommit(tmpDir, "b.ts", "// b", "B leaf");
    pushBundle(db, tmpDir, "@agent-b", b2, "B leaf");

    const leaves = getLeaves(db, { agentHandle: "agent-a" });
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0].agent_handle, "@agent-a");
  });

  it("returns empty when DAG is empty", () => {
    const leaves = getLeaves(db);
    assert.equal(leaves.length, 0);
  });
});

describe("getChildren", () => {
  beforeEach(() => {
    setup();
    initDag(tmpDir);
  });
  afterEach(teardown);

  it("returns empty array for leaf commit", () => {
    const { bundlePath } = createBundleFromCommit(tmpDir, "leaf.ts", "// leaf", "Leaf");
    const result = pushBundle(db, tmpDir, "@agent-a", bundlePath, "Leaf");

    const children = getChildren(db, result.hash);
    assert.equal(children.length, 0);
  });

  it("returns empty array for nonexistent hash", () => {
    const children = getChildren(db, "0000000000000000000000000000000000000000");
    assert.equal(children.length, 0);
  });
});

describe("diffCommits", () => {
  beforeEach(() => {
    setup();
    initDag(tmpDir);
  });
  afterEach(teardown);

  it("throws for invalid hash format", () => {
    assert.throws(
      () => diffCommits(tmpDir, "not-a-hash", "also-not"),
      /Invalid commit hash/
    );
  });

  it("throws when DAG not initialized", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodag2-"));
    assert.throws(
      () => diffCommits(otherDir, "abc1234", "def5678"),
      /not initialized/
    );
    fs.rmSync(otherDir, { recursive: true, force: true });
  });
});

describe("getDagSummary", () => {
  beforeEach(() => {
    setup();
    initDag(tmpDir);
  });
  afterEach(teardown);

  it("returns zeros for empty DAG", () => {
    const summary = getDagSummary(db);
    assert.equal(summary.totalCommits, 0);
    assert.equal(summary.leafCount, 0);
    assert.equal(summary.agentActivity.length, 0);
    assert.equal(summary.recentLeaves.length, 0);
  });

  it("reports correct activity per agent", () => {
    const { bundlePath: b1 } = createBundleFromCommit(tmpDir, "a.ts", "// a", "A work");
    pushBundle(db, tmpDir, "@agent-a", b1, "A work");

    const { bundlePath: b2 } = createBundleFromCommit(tmpDir, "b.ts", "// b", "B work");
    pushBundle(db, tmpDir, "@agent-b", b2, "B work");

    const summary = getDagSummary(db);
    assert.equal(summary.totalCommits, 2);
    assert.equal(summary.agentActivity.length, 2);
  });

  it("limits recent leaves to 5", () => {
    for (let i = 0; i < 7; i++) {
      const { bundlePath } = createBundleFromCommit(tmpDir, `f${i}.ts`, `// ${i}`, `Commit ${i}`);
      pushBundle(db, tmpDir, "@agent-a", bundlePath, `Commit ${i}`);
    }

    const summary = getDagSummary(db);
    assert.ok(summary.recentLeaves.length <= 5);
  });
});

// === Render tests ===

describe("renderDagLog", () => {
  it("renders empty message for no commits", async () => {
    // Import render with NO_COLOR to strip ANSI
    process.env.NO_COLOR = "1";
    const { renderDagLog } = await import("./render.js");
    const output = renderDagLog([]);
    assert.ok(output.includes("No DAG commits"));
    delete process.env.NO_COLOR;
  });
});

describe("renderDagTree", () => {
  it("renders empty message for no commits", async () => {
    process.env.NO_COLOR = "1";
    const { renderDagTree } = await import("./render.js");
    const output = renderDagTree([], new Set());
    assert.ok(output.includes("No DAG commits"));
    delete process.env.NO_COLOR;
  });

  it("marks leaf commits with ★", async () => {
    process.env.NO_COLOR = "1";
    const { renderDagTree } = await import("./render.js");
    const commits = [
      { hash: "abc12345" + "0".repeat(32), parent_hash: null, agent_handle: "@test", message: "Root", created_at: new Date().toISOString() },
    ];
    const leaves = new Set(["abc12345" + "0".repeat(32)]);
    const output = renderDagTree(commits, leaves);
    assert.ok(output.includes("leaf"));
    delete process.env.NO_COLOR;
  });
});

describe("renderPromoteSummary", () => {
  it("renders promote result", async () => {
    process.env.NO_COLOR = "1";
    const { renderPromoteSummary } = await import("./render.js");
    const output = renderPromoteSummary({
      originalHash: "abc12345" + "0".repeat(32),
      newHash: "def67890" + "0".repeat(32),
      message: "Add auth",
    });
    assert.ok(output.includes("Promoted to main"));
    assert.ok(output.includes("abc12345"));
    assert.ok(output.includes("def67890"));
    assert.ok(output.includes("Add auth"));
    delete process.env.NO_COLOR;
  });
});

describe("renderDagSummary", () => {
  it("renders summary with activity", async () => {
    process.env.NO_COLOR = "1";
    const { renderDagSummary } = await import("./render.js");
    const output = renderDagSummary({
      totalCommits: 10,
      leafCount: 3,
      agentActivity: [{ handle: "@auth-mgr", commits: 5 }],
      recentLeaves: [],
    });
    assert.ok(output.includes("DAG Summary"));
    assert.ok(output.includes("10"));
    assert.ok(output.includes("3"));
    assert.ok(output.includes("@auth-mgr"));
    assert.ok(output.includes("5 commits"));
    delete process.env.NO_COLOR;
  });
});

// === Server route tests ===

describe("DAG API routes", () => {
  let app: any;
  let adminKey: string;
  let agentKey: string;

  beforeEach(async () => {
    setup();
    initDag(tmpDir);

    // Import and setup server
    const { createApp } = await import("./server.js");
    const { generateKey, storeKey, hashKey } = await import("./auth.js");

    // Create admin key
    adminKey = generateKey();
    db.prepare("INSERT INTO api_keys (key_hash, agent_handle) VALUES (?, ?)").run(
      hashKey(adminKey), null
    );

    // Create agent key
    agentKey = generateKey();
    storeKey(db, agentKey, "@agent-a");

    app = createApp(db, tmpDir);
  });
  afterEach(teardown);

  it("GET /api/git/commits returns empty array", async () => {
    const res = await app.request("/api/git/commits", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, []);
  });

  it("GET /api/git/leaves returns empty array", async () => {
    const res = await app.request("/api/git/leaves", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, []);
  });

  it("GET /api/git/commits/:hash/children returns empty array", async () => {
    const res = await app.request("/api/git/commits/0000000000000000000000000000000000000000/children", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, []);
  });

  it("GET /api/git/diff/:a/:b returns 400 for bad hashes", async () => {
    const res = await app.request("/api/git/diff/bad-hash/also-bad", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/git/promote requires admin key", async () => {
    const res = await app.request("/api/git/promote", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hash: "abc1234" }),
    });
    assert.equal(res.status, 403);
  });

  it("POST /api/git/promote requires hash", async () => {
    const res = await app.request("/api/git/promote", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it("GET /data/dag returns summary", async () => {
    const res = await app.request("/data/dag");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.totalCommits, 0);
    assert.equal(data.leafCount, 0);
  });

  it("POST /api/git/push requires bundle file", async () => {
    const formData = new FormData();
    formData.set("message", "test");

    const res = await app.request("/api/git/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${agentKey}` },
      body: formData,
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("bundle"));
  });

  it("POST /api/git/push requires message", async () => {
    const formData = new FormData();
    formData.set("bundle", new Blob(["fake"]), "work.bundle");

    const res = await app.request("/api/git/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${agentKey}` },
      body: formData,
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("message"));
  });
});

describe("dag_commits table", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("exists in schema", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='dag_commits'"
    ).all();
    assert.equal(tables.length, 1);
  });

  it("has indexes on parent_hash and agent_handle", () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dag_commits'"
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    assert.ok(names.includes("idx_dag_parent"));
    assert.ok(names.includes("idx_dag_agent"));
  });

  it("enforces FK to agents table", () => {
    assert.throws(
      () =>
        db.prepare(
          "INSERT INTO dag_commits (hash, parent_hash, agent_handle, message) VALUES (?, ?, ?, ?)"
        ).run("abc123", null, "@nonexistent", "test"),
      /FOREIGN KEY/
    );
  });
});

describe("handle validation in DAG", () => {
  beforeEach(() => {
    setup();
    initDag(tmpDir);
  });
  afterEach(teardown);

  it("rejects handles with shell metacharacters", () => {
    assert.throws(
      () => pushBundle(db, tmpDir, "$(whoami)", "/foo.bundle", "msg"),
      /Invalid handle/
    );
  });

  it("rejects handles with spaces", () => {
    assert.throws(
      () => pushBundle(db, tmpDir, "my agent", "/foo.bundle", "msg"),
      /Invalid handle/
    );
  });

  it("rejects handles with backticks", () => {
    assert.throws(
      () => pushBundle(db, tmpDir, "`rm -rf /`", "/foo.bundle", "msg"),
      /Invalid handle/
    );
  });

  it("accepts valid handles", () => {
    // This will fail for other reasons (no bundle file), but shouldn't fail on handle validation
    assert.throws(
      () => pushBundle(db, tmpDir, "@valid-handle", "/nonexistent.bundle", "msg"),
      /not found/ // Bundle not found, not handle error
    );
  });
});
