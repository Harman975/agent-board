import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { initDb } from "./db.js";
import { createAgent, getAgent, listAgents, updateAgent } from "./agents.js";
import { createPost, getPost, listPosts, getThread } from "./posts.js";
import { linkCommit, getCommit, listCommitsByPost } from "./commits.js";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-test-"));
  db = initDb(tmpDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Agent tests ---

describe("agents", () => {
  it("creates and retrieves an agent", () => {
    const a = createAgent(db, {
      handle: "auth-mgr",
      name: "Auth Manager",
      role: "manager",
      mission: "Handle authentication",
    });
    assert.equal(a.handle, "@auth-mgr");
    assert.equal(a.name, "Auth Manager");
    assert.equal(a.role, "manager");
    assert.equal(a.status, "active");

    const fetched = getAgent(db, "@auth-mgr");
    assert.deepStrictEqual(fetched, a);
  });

  it("normalizes handles with @", () => {
    createAgent(db, { handle: "@foo", name: "Foo", role: "worker", mission: "do stuff" });
    const a = getAgent(db, "foo");
    assert.equal(a?.handle, "@foo");
  });

  it("lists agents with filters", () => {
    createAgent(db, { handle: "m1", name: "M1", role: "manager", mission: "a" });
    createAgent(db, { handle: "w1", name: "W1", role: "worker", mission: "b" });
    createAgent(db, { handle: "w2", name: "W2", role: "worker", mission: "c" });

    assert.equal(listAgents(db).length, 3);
    assert.equal(listAgents(db, { role: "manager" }).length, 1);
    assert.equal(listAgents(db, { role: "worker" }).length, 2);
  });

  it("updates an agent", () => {
    createAgent(db, { handle: "a1", name: "A1", role: "worker", mission: "old" });
    const updated = updateAgent(db, "a1", { mission: "new mission", status: "blocked" });
    assert.equal(updated?.mission, "new mission");
    assert.equal(updated?.status, "blocked");
  });

  it("returns null for missing agent", () => {
    assert.equal(getAgent(db, "nonexistent"), null);
  });
});

// --- Post tests ---

describe("posts", () => {
  beforeEach(() => {
    createAgent(db, { handle: "bot", name: "Bot", role: "worker", mission: "test" });
  });

  it("creates and retrieves a post", () => {
    const p = createPost(db, { author: "bot", content: "hello world" });
    assert.equal(p.author, "@bot");
    assert.equal(p.content, "hello world");
    assert.equal(p.type, "update");
    assert.equal(p.parent_id, null);

    const fetched = getPost(db, p.id);
    assert.deepStrictEqual(fetched, p);
  });

  it("rejects posts from nonexistent agents", () => {
    assert.throws(() => createPost(db, { author: "nobody", content: "hi" }), /not found/);
  });

  it("creates threaded replies", () => {
    const root = createPost(db, { author: "bot", content: "root" });
    const reply = createPost(db, { author: "bot", content: "reply", parent_id: root.id });
    assert.equal(reply.parent_id, root.id);
  });

  it("lists posts with filters", () => {
    createAgent(db, { handle: "other", name: "Other", role: "worker", mission: "x" });
    createPost(db, { author: "bot", content: "a" });
    createPost(db, { author: "bot", content: "b", type: "decision" });
    createPost(db, { author: "other", content: "c" });

    assert.equal(listPosts(db).length, 3);
    assert.equal(listPosts(db, { author: "bot" }).length, 2);
    assert.equal(listPosts(db, { type: "decision" }).length, 1);
  });

  it("lists only top-level posts", () => {
    const root = createPost(db, { author: "bot", content: "root" });
    createPost(db, { author: "bot", content: "reply", parent_id: root.id });

    const topLevel = listPosts(db, { parent_id: null });
    assert.equal(topLevel.length, 1);
    assert.equal(topLevel[0].content, "root");
  });

  it("builds thread tree", () => {
    const root = createPost(db, { author: "bot", content: "root" });
    const r1 = createPost(db, { author: "bot", content: "r1", parent_id: root.id });
    createPost(db, { author: "bot", content: "r1.1", parent_id: r1.id });
    createPost(db, { author: "bot", content: "r2", parent_id: root.id });

    const thread = getThread(db, root.id)!;
    assert.equal(thread.post.content, "root");
    assert.equal(thread.replies.length, 2);
    assert.equal(thread.replies[0].replies.length, 1);
    assert.equal(thread.replies[0].replies[0].post.content, "r1.1");
  });

  it("getThread finds root from reply", () => {
    const root = createPost(db, { author: "bot", content: "root" });
    const reply = createPost(db, { author: "bot", content: "reply", parent_id: root.id });

    const thread = getThread(db, reply.id)!;
    assert.equal(thread.post.content, "root");
    assert.equal(thread.replies.length, 1);
  });
});

// --- Commit tests ---

describe("commits", () => {
  beforeEach(() => {
    createAgent(db, { handle: "bot", name: "Bot", role: "worker", mission: "test" });
  });

  it("links and retrieves a commit", () => {
    const post = createPost(db, { author: "bot", content: "did some work" });
    const commit = linkCommit(db, {
      hash: "abc123",
      post_id: post.id,
      files: ["src/foo.ts", "src/bar.ts"],
    });
    assert.equal(commit.hash, "abc123");
    assert.deepStrictEqual(commit.files, ["src/foo.ts", "src/bar.ts"]);

    const fetched = getCommit(db, "abc123");
    assert.deepStrictEqual(fetched, commit);
  });

  it("lists commits by post", () => {
    const post = createPost(db, { author: "bot", content: "work" });
    linkCommit(db, { hash: "aaa", post_id: post.id, files: ["a.ts"] });
    linkCommit(db, { hash: "bbb", post_id: post.id, files: ["b.ts"] });

    const commits = listCommitsByPost(db, post.id);
    assert.equal(commits.length, 2);
  });

  it("rejects commit for missing post", () => {
    assert.throws(() => linkCommit(db, { hash: "xxx", post_id: "fake-id" }), /not found/);
  });
});
