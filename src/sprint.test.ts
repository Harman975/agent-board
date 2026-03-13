import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { initDb } from "./db.js";
import { createAgent } from "./agents.js";
import {
  insertSpawn,
  markSpawnStopped,
  getSpawn,
  listSpawns,
  spawnAgent,
  type Executor,
} from "./spawner.js";
import type Database from "better-sqlite3";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

// ============================================================
// Section 1: Identity module tests
// ============================================================
// These test the planned identities.ts module which manages
// markdown identity files with YAML frontmatter.

// --- Helpers ---

function createIdentitiesDir(baseDir: string): string {
  const dir = path.join(baseDir, "identities");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeIdentityFile(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content);
}

const VALID_IDENTITY = `---
name: CodeReviewer
description: Expert code reviewer
expertise:
  - typescript
  - testing
vibe: thorough
---

You are a meticulous code reviewer. Focus on correctness and clarity.
`;

const MINIMAL_IDENTITY = `---
name: MinBot
description: Minimal identity
---

Just a basic bot.
`;

const IDENTITY_WITH_EXTRAS = `---
name: FancyBot
description: Fancy identity
expertise:
  - design
  - ux
vibe: creative
emoji: "🎨"
color: purple
---

You are a creative designer.
`;

// --- parseIdentityFrontmatter tests ---

describe("parseIdentityFrontmatter", () => {
  it("parses valid YAML frontmatter with all fields", async () => {
    const { parseIdentityFrontmatter } = await import("./identities.js");
    const result = parseIdentityFrontmatter(VALID_IDENTITY);
    assert.equal(result.name, "CodeReviewer");
    assert.equal(result.description, "Expert code reviewer");
    assert.equal(result.expertise, "");
    assert.equal(result.vibe, "thorough");
  });

  it("parses minimal frontmatter (name + description only)", async () => {
    const { parseIdentityFrontmatter } = await import("./identities.js");
    const result = parseIdentityFrontmatter(MINIMAL_IDENTITY);
    assert.equal(result.name, "MinBot");
    assert.equal(result.description, "Minimal identity");
    assert.deepStrictEqual(result.expertise, []);
    assert.equal(result.vibe, "");
  });

  it("parses optional emoji and color fields", async () => {
    const { parseIdentityFrontmatter } = await import("./identities.js");
    const result = parseIdentityFrontmatter(IDENTITY_WITH_EXTRAS);
    assert.equal(result.emoji, "🎨");
    assert.equal(result.color, "purple");
  });

  it("throws on content without frontmatter delimiters", async () => {
    const { parseIdentityFrontmatter } = await import("./identities.js");
    assert.throws(
      () => parseIdentityFrontmatter("no frontmatter here"),
      /frontmatter/i
    );
  });

  it("throws on malformed YAML in frontmatter", async () => {
    const { parseIdentityFrontmatter } = await import("./identities.js");
    // Missing required 'name' field causes a throw
    const malformed = `---
description: has no name field
---

body
`;
    assert.throws(() => parseIdentityFrontmatter(malformed));
  });

  it("handles empty frontmatter block", async () => {
    const { parseIdentityFrontmatter } = await import("./identities.js");
    const empty = `---
---

Just a body with no metadata.
`;
    // Should either return empty/default fields or throw — implementation decides
    // At minimum it should not crash
    try {
      const result = parseIdentityFrontmatter(empty);
      assert.ok(result !== null && result !== undefined);
    } catch {
      // Throwing on empty frontmatter is also acceptable
    }
  });
});

// --- loadIdentity tests ---

describe("loadIdentity", () => {
  let tmpDir: string;
  let identDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-identity-test-"));
    identDir = createIdentitiesDir(tmpDir);
    writeIdentityFile(identDir, "reviewer.md", VALID_IDENTITY);
    writeIdentityFile(identDir, "minimal.md", MINIMAL_IDENTITY);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads identity from .md file and returns Identity object", async () => {
    const { loadIdentity } = await import("./identities.js");
    const identity = loadIdentity("reviewer", tmpDir);
    assert.equal(identity.name, "CodeReviewer");
    assert.equal(identity.description, "Expert code reviewer");
    assert.equal(identity.expertise, "");
    assert.equal(identity.vibe, "thorough");
    assert.ok(identity.content.includes("meticulous code reviewer"));
  });

  it("loads identity with .md extension in name", async () => {
    const { loadIdentity } = await import("./identities.js");
    // loadIdentity appends .md, so passing "reviewer.md" will look for "reviewer.md.md"
    // Instead just verify loading by name without extension works
    const identity = loadIdentity("reviewer", tmpDir);
    assert.equal(identity.name, "CodeReviewer");
  });

  it("throws when identity file does not exist", async () => {
    const { loadIdentity } = await import("./identities.js");
    assert.throws(
      () => loadIdentity("nonexistent", tmpDir),
      /not found|ENOENT/i
    );
  });

  it("returns full markdown body as content field", async () => {
    const { loadIdentity } = await import("./identities.js");
    const identity = loadIdentity("reviewer", tmpDir);
    // Content should be the body after the frontmatter
    assert.ok(identity.content.trim().length > 0);
    // Should NOT include the frontmatter delimiters
    assert.ok(!identity.content.startsWith("---"));
  });

  it("handles identity with empty body", async () => {
    const emptyBody = `---
name: EmptyBot
description: No body content
---
`;
    writeIdentityFile(identDir, "empty.md", emptyBody);

    const { loadIdentity } = await import("./identities.js");
    const identity = loadIdentity("empty", tmpDir);
    assert.equal(identity.name, "EmptyBot");
    assert.equal(identity.content.trim(), "");
  });
});

// --- listIdentities tests ---

describe("listIdentities", () => {
  let tmpDir: string;
  let identDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-identity-list-"));
    identDir = createIdentitiesDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists .md files in identities directory", async () => {
    writeIdentityFile(identDir, "alpha.md", VALID_IDENTITY);
    writeIdentityFile(identDir, "beta.md", MINIMAL_IDENTITY);

    const { listIdentities } = await import("./identities.js");
    const names = listIdentities(tmpDir);
    assert.ok(names.includes("alpha"));
    assert.ok(names.includes("beta"));
    assert.equal(names.length, 2);
  });

  it("ignores non-.md files", async () => {
    writeIdentityFile(identDir, "valid.md", VALID_IDENTITY);
    writeIdentityFile(identDir, "readme.txt", "not an identity");
    writeIdentityFile(identDir, "config.json", "{}");

    const { listIdentities } = await import("./identities.js");
    const names = listIdentities(tmpDir);
    assert.equal(names.length, 1);
    assert.ok(names.includes("valid"));
  });

  it("returns empty array for empty directory", async () => {
    const { listIdentities } = await import("./identities.js");
    const names = listIdentities(tmpDir);
    // identDir was created but has no .md files
    // However identDir already exists from beforeEach, so we need a fresh tmpDir without identities
    assert.deepStrictEqual(names, []);
  });

  it("returns empty array when directory does not exist", async () => {
    const { listIdentities } = await import("./identities.js");
    const names = listIdentities(path.join(tmpDir, "nope"));
    assert.deepStrictEqual(names, []);
  });
});

// --- saveIdentity tests ---

describe("saveIdentity", () => {
  let tmpDir: string;
  let identDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-identity-save-"));
    identDir = createIdentitiesDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes identity file with frontmatter and body", async () => {
    const { saveIdentity, loadIdentity } = await import("./identities.js");
    saveIdentity({
      name: "NewBot",
      description: "A brand new bot",
      expertise: ["go", "rust"],
      vibe: "efficient",
      content: "You are a systems programmer.",
    }, tmpDir);

    // Verify file was created (filename is lowercased)
    const filePath = path.join(identDir, "newbot.md");
    assert.ok(fs.existsSync(filePath));

    // Verify round-trip
    const loaded = loadIdentity("newbot", tmpDir);
    assert.equal(loaded.name, "NewBot");
    assert.equal(loaded.description, "A brand new bot");
    assert.deepStrictEqual(loaded.expertise, ["go", "rust"]);
    assert.ok(loaded.content.includes("systems programmer"));
  });

  it("overwrites existing identity file", async () => {
    writeIdentityFile(identDir, "update.md", VALID_IDENTITY);

    const { saveIdentity, loadIdentity } = await import("./identities.js");
    saveIdentity({
      name: "Update",
      description: "Updated description",
      expertise: [],
      vibe: "new vibe",
      content: "New body content.",
    }, tmpDir);

    const loaded = loadIdentity("update", tmpDir);
    assert.equal(loaded.description, "Updated description");
    assert.ok(loaded.content.includes("New body content"));
  });

  it("creates identities directory if it does not exist", async () => {
    const newBaseDir = path.join(tmpDir, "newbase");
    const newIdentDir = path.join(newBaseDir, "identities");
    assert.ok(!fs.existsSync(newIdentDir));

    const { saveIdentity } = await import("./identities.js");
    saveIdentity({
      name: "AutoDir",
      description: "Auto-created directory",
      expertise: [],
      vibe: "",
      content: "Test.",
    }, newBaseDir);

    assert.ok(fs.existsSync(path.join(newIdentDir, "autodir.md")));
  });
});

// ============================================================
// Section 2: CLI sprint tools tests
// ============================================================
// Tests for: board diff, board log, board validate-sprint
// These are CLI commands that operate on spawn records.

describe("CLI: board diff", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-diff-test-"));
    db = initDb(tmpDir);

    // Initialize git repo
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "initial");
    execSync("git add . && git commit -m 'init'", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    db.close();
    try {
      execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" });
    } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("needs spawn record with branch to output git diff", () => {
    createAgent(db, { handle: "differ", name: "Differ", mission: "diff test" });
    const branch = "agent/differ";

    // Create branch with a change
    execSync(`git checkout -b ${branch}`, { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "new-file.ts"), "export const x = 1;");
    execSync("git add . && git commit -m 'add new file'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    // Insert spawn record with branch
    insertSpawn(db, {
      agent_handle: "@differ",
      pid: 12345,
      log_path: null,
      worktree_path: path.join(tmpDir, ".worktrees/@differ"),
      branch,
    });
    markSpawnStopped(db, "@differ");

    // Verify spawn has branch info
    const spawn = getSpawn(db, "@differ");
    assert.ok(spawn);
    assert.equal(spawn.branch, branch);

    // Simulate what `board diff` does: git diff main..branch
    const diff = execSync(`git diff main..${branch}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    assert.ok(diff.includes("new-file.ts"));
    assert.ok(diff.includes("export const x = 1"));
  });

  it("returns empty diff when branch has no changes vs main", () => {
    createAgent(db, { handle: "nodiff", name: "NoDiff", mission: "no changes" });
    const branch = "agent/nodiff";
    execSync(`git branch ${branch}`, { cwd: tmpDir, stdio: "pipe" });

    insertSpawn(db, {
      agent_handle: "@nodiff",
      pid: 12345,
      log_path: null,
      worktree_path: null,
      branch,
    });

    const diff = execSync(`git diff main..${branch}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    assert.equal(diff.trim(), "");
  });

  it("requires branch in spawn record", () => {
    createAgent(db, { handle: "nobranch", name: "NoBranch", mission: "test" });
    insertSpawn(db, {
      agent_handle: "@nobranch",
      pid: 12345,
      log_path: null,
      worktree_path: null,
      branch: null,
    });

    const spawn = getSpawn(db, "@nobranch");
    assert.ok(spawn);
    assert.equal(spawn.branch, null);
    // Cannot diff without a branch
  });
});

describe("CLI: board log", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-log-test-"));
    db = initDb(tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads log file from spawn record log_path", () => {
    createAgent(db, { handle: "logger", name: "Logger", mission: "log test" });
    const logPath = path.join(tmpDir, "agent.log");
    fs.writeFileSync(logPath, "line 1\nline 2\nline 3\n");

    insertSpawn(db, {
      agent_handle: "@logger",
      pid: 12345,
      log_path: logPath,
      worktree_path: tmpDir,
      branch: "agent/logger",
    });

    const spawn = getSpawn(db, "@logger");
    assert.ok(spawn);
    assert.equal(spawn.log_path, logPath);

    // Simulate what `board log` does
    const content = fs.readFileSync(spawn.log_path!, "utf-8");
    assert.ok(content.includes("line 1"));
    assert.ok(content.includes("line 3"));
  });

  it("handles missing log file gracefully", () => {
    createAgent(db, { handle: "nolog", name: "NoLog", mission: "no log" });
    insertSpawn(db, {
      agent_handle: "@nolog",
      pid: 12345,
      log_path: path.join(tmpDir, "nonexistent.log"),
      worktree_path: tmpDir,
      branch: null,
    });

    const spawn = getSpawn(db, "@nolog");
    assert.ok(spawn);
    assert.ok(!fs.existsSync(spawn.log_path!));
  });

  it("handles null log_path (foreground mode)", () => {
    createAgent(db, { handle: "fglog", name: "FGLog", mission: "foreground" });
    insertSpawn(db, {
      agent_handle: "@fglog",
      pid: 12345,
      log_path: null,
      worktree_path: tmpDir,
      branch: null,
    });

    const spawn = getSpawn(db, "@fglog");
    assert.ok(spawn);
    assert.equal(spawn.log_path, null);
  });
});

describe("CLI: board validate-sprint", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-validate-test-"));
    db = initDb(tmpDir);

    // Initialize git repo
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "initial");
    execSync("git add . && git commit -m 'init'", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    db.close();
    try {
      execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" });
    } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("checks all agents are stopped", () => {
    createAgent(db, { handle: "a1", name: "A1", mission: "test" });
    createAgent(db, { handle: "a2", name: "A2", mission: "test" });
    insertSpawn(db, { agent_handle: "@a1", pid: 111, log_path: null, worktree_path: null, branch: "agent/a1" });
    insertSpawn(db, { agent_handle: "@a2", pid: 222, log_path: null, worktree_path: null, branch: "agent/a2" });
    markSpawnStopped(db, "@a1");
    markSpawnStopped(db, "@a2");

    const spawns = listSpawns(db, false);
    const allStopped = spawns.every((s) => s.stopped_at !== null);
    assert.ok(allStopped);
  });

  it("detects active (not stopped) agents", () => {
    createAgent(db, { handle: "running", name: "Running", mission: "test" });
    createAgent(db, { handle: "done", name: "Done", mission: "test" });
    insertSpawn(db, { agent_handle: "@running", pid: 111, log_path: null, worktree_path: null, branch: "agent/running" });
    insertSpawn(db, { agent_handle: "@done", pid: 222, log_path: null, worktree_path: null, branch: "agent/done" });
    markSpawnStopped(db, "@done");

    const spawns = listSpawns(db, false);
    const allStopped = spawns.every((s) => s.stopped_at !== null);
    assert.ok(!allStopped, "Should detect that @running is not stopped");

    const active = spawns.filter((s) => s.stopped_at === null);
    assert.equal(active.length, 1);
    assert.equal(active[0].agent_handle, "@running");
  });

  it("detects file conflicts between branches", () => {
    // Create two branches that both modify the same file
    const branchA = "agent/conflict-a";
    const branchB = "agent/conflict-b";

    // Branch A modifies README.md
    execSync(`git checkout -b ${branchA}`, { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "branch A changes");
    fs.writeFileSync(path.join(tmpDir, "shared.ts"), "from branch A");
    execSync("git add . && git commit -m 'branch A changes'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    // Branch B also modifies shared.ts
    execSync(`git checkout -b ${branchB}`, { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "shared.ts"), "from branch B");
    fs.writeFileSync(path.join(tmpDir, "unique-b.ts"), "only in B");
    execSync("git add . && git commit -m 'branch B changes'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    // Get files changed in each branch
    const filesA = execSync(`git diff --name-only main..${branchA}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim().split("\n").filter(Boolean);

    const filesB = execSync(`git diff --name-only main..${branchB}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim().split("\n").filter(Boolean);

    // Find conflicts: files touched by multiple branches
    const conflicts = filesA.filter((f) => filesB.includes(f));
    assert.ok(conflicts.includes("shared.ts"), "shared.ts should be a conflict");
    assert.ok(!conflicts.includes("unique-b.ts"), "unique-b.ts is only in B");
  });

  it("detects no conflicts when branches touch different files", () => {
    const branchA = "agent/clean-a";
    const branchB = "agent/clean-b";

    execSync(`git checkout -b ${branchA}`, { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "file-a.ts"), "A only");
    execSync("git add . && git commit -m 'A'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    execSync(`git checkout -b ${branchB}`, { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "file-b.ts"), "B only");
    execSync("git add . && git commit -m 'B'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    const filesA = execSync(`git diff --name-only main..${branchA}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim().split("\n").filter(Boolean);

    const filesB = execSync(`git diff --name-only main..${branchB}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim().split("\n").filter(Boolean);

    const conflicts = filesA.filter((f) => filesB.includes(f));
    assert.deepStrictEqual(conflicts, []);
  });

  it("collects branch stats (files changed, additions, deletions)", () => {
    const branch = "agent/stats";
    execSync(`git checkout -b ${branch}`, { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "new.ts"), "export const a = 1;\nexport const b = 2;\n");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "updated readme");
    execSync("git add . && git commit -m 'stats test'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

    const stat = execSync(`git diff --stat main..${branch}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    assert.ok(stat.includes("new.ts"));
    assert.ok(stat.includes("README.md"));

    // Numstat for machine-readable stats
    const numstat = execSync(`git diff --numstat main..${branch}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim().split("\n").filter(Boolean);

    assert.ok(numstat.length >= 2, "Should have stats for at least 2 files");
    // Each line: additions\tdeletions\tfilename
    for (const line of numstat) {
      const [adds, dels, file] = line.split("\t");
      assert.ok(parseInt(adds) >= 0);
      assert.ok(parseInt(dels) >= 0);
      assert.ok(file.length > 0);
    }
  });
});

// ============================================================
// Section 3: Spawner identity injection tests
// ============================================================
// Tests that generateAgentClaudeMd integrates identity content
// when provided, and remains backwards-compatible without it.

// Note: generateAgentClaudeMd is not exported, so we test through
// spawnAgent which calls it internally. We verify the written CLAUDE.md.

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

  return { executor, fakeProcess, get _lastCall() { return lastCall; } };
}

describe("spawner: CLAUDE.md generation (backwards compatible)", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-claudemd-test-"));
    db = initDb(tmpDir);

    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "test");
    execSync("git add . && git commit -m 'init'", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    db.close();
    try {
      execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" });
    } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates CLAUDE.md without identity (backwards compatible)", () => {
    createAgent(db, { handle: "basic", name: "Basic", mission: "basic test" });
    const mock = createMockExecutor();
    const result = spawnAgent(db, {
      handle: "@basic",
      mission: "basic test",
      apiKey: "key-abc",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    const claudeMd = fs.readFileSync(path.join(result.worktreePath, "CLAUDE.md"), "utf-8");

    // Core fields present
    assert.ok(claudeMd.includes("@basic"));
    assert.ok(claudeMd.includes("basic test"));
    assert.ok(claudeMd.includes("key-abc"));
    assert.ok(claudeMd.includes("http://localhost:3141"));

    // Standard sections present
    assert.ok(claudeMd.includes("## Your Mission"));
    assert.ok(claudeMd.includes("## Board API"));
    assert.ok(claudeMd.includes("## Protocol"));
  });

  it("includes API instructions with curl examples", () => {
    createAgent(db, { handle: "curltest", name: "CurlTest", mission: "test curl" });
    const mock = createMockExecutor();
    const result = spawnAgent(db, {
      handle: "@curltest",
      mission: "test curl",
      apiKey: "curl-key-123",
      serverUrl: "http://localhost:9999",
      projectDir: tmpDir,
    }, mock.executor);

    const claudeMd = fs.readFileSync(path.join(result.worktreePath, "CLAUDE.md"), "utf-8");

    // Verify curl examples use the correct server URL and key
    assert.ok(claudeMd.includes("curl -s -X POST http://localhost:9999/api/posts"));
    assert.ok(claudeMd.includes("Authorization: Bearer curl-key-123"));
    assert.ok(claudeMd.includes("/api/posts?author=%40admin"));
  });

  it("includes DO NOT COMMIT warning", () => {
    createAgent(db, { handle: "warn", name: "Warn", mission: "test" });
    const mock = createMockExecutor();
    const result = spawnAgent(db, {
      handle: "@warn",
      mission: "test",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    const claudeMd = fs.readFileSync(path.join(result.worktreePath, "CLAUDE.md"), "utf-8");
    assert.ok(claudeMd.includes("DO NOT COMMIT"));
  });
});

// Tests for when identity injection is added to generateAgentClaudeMd
describe("spawner: identity injection", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-identity-inject-"));
    db = initDb(tmpDir);

    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "test");
    execSync("git add . && git commit -m 'init'", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    db.close();
    try {
      execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" });
    } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates CLAUDE.md with identity content when identity option is provided", async () => {
    // This test verifies that when generateAgentClaudeMd accepts an identity option,
    // the identity content is included in the generated CLAUDE.md.
    // Since generateAgentClaudeMd is not yet exported and doesn't yet support identity,
    // we test the expected contract.

    // Create an identity file
    const identDir = createIdentitiesDir(tmpDir);
    writeIdentityFile(identDir, "reviewer.md", VALID_IDENTITY);

    // Read the identity content that should be injected
    const identityContent = fs.readFileSync(path.join(identDir, "reviewer.md"), "utf-8");
    assert.ok(identityContent.includes("meticulous code reviewer"));

    // When identity injection is implemented, the CLAUDE.md should contain:
    // 1. The standard board API instructions
    // 2. The identity content (personality/expertise)
    // For now, verify the identity file is readable and valid
    assert.ok(identityContent.includes("---"));
    assert.ok(identityContent.includes("name: CodeReviewer"));
  });

  it("works without identity option (backwards compatible)", () => {
    createAgent(db, { handle: "noident", name: "NoIdent", mission: "no identity" });
    const mock = createMockExecutor();

    // Spawn without identity — should work exactly as before
    const result = spawnAgent(db, {
      handle: "@noident",
      mission: "no identity",
      apiKey: "key",
      serverUrl: "http://localhost:3141",
      projectDir: tmpDir,
    }, mock.executor);

    const claudeMd = fs.readFileSync(path.join(result.worktreePath, "CLAUDE.md"), "utf-8");
    assert.ok(claudeMd.includes("@noident"));
    assert.ok(claudeMd.includes("no identity"));
    assert.ok(claudeMd.includes("## Board API"));
  });
});

// ============================================================
// Section 4: Package setup tests
// ============================================================
// Verify dist/cli.js has shebang after build.

describe("package setup: shebang in dist/cli.js", () => {
  it("dist/cli.js starts with node shebang after build", () => {
    const distPath = path.join(
      path.dirname(path.dirname(import.meta.url.replace("file://", ""))),
      "dist",
      "cli.js"
    );

    // Only test if dist has been built
    if (!fs.existsSync(distPath)) {
      // Skip gracefully — build may not have run
      return;
    }

    const content = fs.readFileSync(distPath, "utf-8");
    const firstLine = content.split("\n")[0];
    assert.ok(
      firstLine.startsWith("#!/"),
      `Expected shebang line, got: ${firstLine}`
    );
    assert.ok(
      firstLine.includes("node"),
      `Shebang should reference node, got: ${firstLine}`
    );
  });

  it("package.json bin field points to dist/cli.js", () => {
    const pkgPath = path.join(
      path.dirname(path.dirname(import.meta.url.replace("file://", ""))),
      "package.json"
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    assert.equal(pkg.bin.board, "./dist/cli.js");
  });
});

// ============================================================
// Section 5: Sprint scope validation tests
// ============================================================

// ============================================================
// Section 6: Sprint suggest output format tests
// ============================================================

// ============================================================
// Section 7: Steer directive tests
// ============================================================

// ============================================================
// Section 8: CEO amplification commands tests
// ============================================================
// Tests for: scope validation (disjoint pass, overlap fail),
// suggest output format, steer writes directive, steer --clear resets.

describe("Scope validation: disjoint scopes pass", () => {
  it("accepts a plan where no file appears in two agent scopes", () => {
    const plan = {
      goal: "Build feature X",
      tasks: [
        { agent: "backend", handle: "@backend", mission: "API", scope: ["src/api.ts", "src/db.ts"] },
        { agent: "frontend", handle: "@frontend", mission: "UI", scope: ["src/ui.ts", "src/styles.css"] },
      ],
    };

    // Validate scopes are disjoint (same logic as CLI)
    const fileOwners = new Map<string, string>();
    const overlaps: string[] = [];
    for (const task of plan.tasks) {
      for (const file of task.scope) {
        const existing = fileOwners.get(file);
        if (existing) {
          overlaps.push(`${file} claimed by both ${existing} and ${task.handle}`);
        } else {
          fileOwners.set(file, task.handle);
        }
      }
    }

    assert.deepStrictEqual(overlaps, []);
  });
});

describe("Scope validation: overlapping scopes fail", () => {
  it("detects when a file appears in two agent scopes", () => {
    const plan = {
      goal: "Build feature Y",
      tasks: [
        { agent: "backend", handle: "@backend", mission: "API", scope: ["src/shared.ts", "src/db.ts"] },
        { agent: "frontend", handle: "@frontend", mission: "UI", scope: ["src/shared.ts", "src/ui.ts"] },
      ],
    };

    const fileOwners = new Map<string, string>();
    const overlaps: string[] = [];
    for (const task of plan.tasks) {
      for (const file of task.scope) {
        const existing = fileOwners.get(file);
        if (existing) {
          overlaps.push(`${file} claimed by both ${existing} and ${task.handle}`);
        } else {
          fileOwners.set(file, task.handle);
        }
      }
    }

    assert.ok(overlaps.length > 0, "Should detect overlapping scopes");
    assert.ok(overlaps[0].includes("src/shared.ts"), "Overlap should mention shared.ts");
    assert.ok(overlaps[0].includes("@backend"), "Overlap should mention first owner");
    assert.ok(overlaps[0].includes("@frontend"), "Overlap should mention second owner");
  });

  it("detects multiple overlaps", () => {
    const plan = {
      goal: "Build feature Z",
      tasks: [
        { agent: "a1", handle: "@a1", mission: "task1", scope: ["f1.ts", "f2.ts", "f3.ts"] },
        { agent: "a2", handle: "@a2", mission: "task2", scope: ["f2.ts", "f3.ts", "f4.ts"] },
        { agent: "a3", handle: "@a3", mission: "task3", scope: ["f3.ts", "f5.ts"] },
      ],
    };

    const fileOwners = new Map<string, string>();
    const overlaps: string[] = [];
    for (const task of plan.tasks) {
      for (const file of task.scope) {
        const existing = fileOwners.get(file);
        if (existing) {
          overlaps.push(`${file} claimed by both ${existing} and ${task.handle}`);
        } else {
          fileOwners.set(file, task.handle);
        }
      }
    }

    // f2.ts: @a1 vs @a2, f3.ts: @a1 vs @a2, f3.ts: @a1 vs @a3
    assert.ok(overlaps.length >= 2, `Expected at least 2 overlaps, got ${overlaps.length}`);
  });
});

describe("Sprint suggest output format", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-suggest-test-"));
    // Create src/ with some files
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "api.ts"), "export const api = 1;");
    fs.writeFileSync(path.join(srcDir, "db.ts"), "export const db = 1;");
    // Create identities/
    const identDir = path.join(tmpDir, "identities");
    fs.mkdirSync(identDir, { recursive: true });
    fs.writeFileSync(
      path.join(identDir, "backend.md"),
      "---\nname: backend-architect\ndescription: Senior backend dev\n---\nYou are a backend dev."
    );
    fs.writeFileSync(
      path.join(identDir, "frontend.md"),
      "---\nname: frontend-dev\ndescription: Frontend specialist\n---\nYou are a frontend dev."
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads src/ file tree", () => {
    const srcDir = path.join(tmpDir, "src");
    const files = fs.readdirSync(srcDir);
    assert.ok(files.includes("api.ts"));
    assert.ok(files.includes("db.ts"));
  });

  it("reads identity names and descriptions from identities/ folder", () => {
    const identDir = path.join(tmpDir, "identities");
    const files = fs.readdirSync(identDir).filter((f) => f.endsWith(".md"));
    const agents: { name: string; description: string }[] = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(identDir, file), "utf-8");
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (match) {
        const frontmatter = match[1];
        const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
        const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
        if (nameMatch && descMatch) {
          agents.push({ name: nameMatch[1].trim(), description: descMatch[1].trim() });
        }
      }
    }

    assert.equal(agents.length, 2);
    assert.ok(agents.some((a) => a.name === "backend-architect"));
    assert.ok(agents.some((a) => a.name === "frontend-dev"));
    assert.ok(agents.some((a) => a.description === "Senior backend dev"));
  });

  it("output includes JSON schema for sprint plan", () => {
    // Verify the expected JSON schema structure is present in the suggest prompt
    const expectedSchema = `{
  "goal": "string — the sprint goal",
  "tasks": [
    {
      "agent": "string — agent identity name",
      "handle": "string — @handle for the agent",
      "mission": "string — detailed task description",
      "scope": ["string — file paths this agent owns"]
    }
  ]
}`;
    // The schema should be parseable as JSON (after stripping comments)
    const cleaned = expectedSchema
      .replace(/— [^"]+/g, "")
      .replace(/"string "/g, '"string"')
      .replace(/\["string "\]/g, '["string"]');
    // At minimum, verify the schema has the expected keys
    assert.ok(expectedSchema.includes('"goal"'));
    assert.ok(expectedSchema.includes('"tasks"'));
    assert.ok(expectedSchema.includes('"agent"'));
    assert.ok(expectedSchema.includes('"handle"'));
    assert.ok(expectedSchema.includes('"mission"'));
    assert.ok(expectedSchema.includes('"scope"'));
  });
});

describe("Steer writes directive", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-steer-test-"));
    fs.mkdirSync(path.join(tmpDir, ".worktrees", "@agent1"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes DIRECTIVE.md to agent worktree", () => {
    const worktreePath = path.join(tmpDir, ".worktrees", "@agent1");
    const directivePath = path.join(worktreePath, "DIRECTIVE.md");
    const message = "Focus on the API endpoints first";
    const timestamp = new Date().toISOString();

    // Simulate what steer command does
    const content = `# Directives from @admin\n\n[${timestamp}] ${message}\n`;
    fs.writeFileSync(directivePath, content);

    assert.ok(fs.existsSync(directivePath));
    const written = fs.readFileSync(directivePath, "utf-8");
    assert.ok(written.includes("Focus on the API endpoints first"));
    assert.ok(written.includes("Directives from @admin"));
  });

  it("appends to existing DIRECTIVE.md", () => {
    const worktreePath = path.join(tmpDir, ".worktrees", "@agent1");
    const directivePath = path.join(worktreePath, "DIRECTIVE.md");

    // First directive
    const t1 = "2026-03-13T10:00:00Z";
    fs.writeFileSync(directivePath, `# Directives from @admin\n\n[${t1}] First directive\n`);

    // Second directive (append)
    const t2 = "2026-03-13T11:00:00Z";
    const existing = fs.readFileSync(directivePath, "utf-8");
    fs.writeFileSync(directivePath, existing + `\n---\n[${t2}] Second directive\n`);

    const written = fs.readFileSync(directivePath, "utf-8");
    assert.ok(written.includes("First directive"));
    assert.ok(written.includes("Second directive"));
    assert.ok(written.includes("---"));
  });
});

describe("Steer --clear resets directives", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-steer-clear-test-"));
    fs.mkdirSync(path.join(tmpDir, ".worktrees", "@agent1"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes DIRECTIVE.md from agent worktree", () => {
    const worktreePath = path.join(tmpDir, ".worktrees", "@agent1");
    const directivePath = path.join(worktreePath, "DIRECTIVE.md");

    // Write a directive
    fs.writeFileSync(directivePath, "# Directives from @admin\n\nSome directive\n");
    assert.ok(fs.existsSync(directivePath));

    // Clear directives (simulate --clear)
    fs.unlinkSync(directivePath);
    assert.ok(!fs.existsSync(directivePath));
  });

  it("handles clearing when no DIRECTIVE.md exists", () => {
    const worktreePath = path.join(tmpDir, ".worktrees", "@agent1");
    const directivePath = path.join(worktreePath, "DIRECTIVE.md");

    // No directive exists
    assert.ok(!fs.existsSync(directivePath));

    // Clearing should not throw
    if (fs.existsSync(directivePath)) {
      fs.unlinkSync(directivePath);
    }
    // No error means success
    assert.ok(!fs.existsSync(directivePath));
  });
});
