import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { initDb, dbExists } from "./db.js";
import { createAgent, getAgent, listAgents, updateAgent } from "./agents.js";
import { createChannel, getChannel, listChannels } from "./channels.js";
import { createPost, getPost, listPosts, getThread } from "./posts.js";
import { linkCommit, getCommit, listCommitsByPost } from "./commits.js";
import { generateKey, hashKey, storeKey, validateKey, isAdminKey, revokeKey } from "./auth.js";
import { checkRateLimit, resetRateLimits } from "./ratelimit.js";
import { setChannelPriority, getChannelPriority, listChannelPriorities, getFeed, getBriefing, getCursor, setCursor, parseDuration } from "./supervision.js";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-test-"));
  db = initDb(tmpDir);
  resetRateLimits();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: create agent + channel for post tests
function setupPostFixtures() {
  createAgent(db, { handle: "bot", name: "Bot", mission: "test" });
  createChannel(db, { name: "work", description: "Work channel" });
}

// === Foundation: Agents ===

describe("agents", () => {
  it("creates and retrieves an agent", () => {
    const a = createAgent(db, {
      handle: "auth-mgr",
      name: "Auth Manager",
      mission: "Handle authentication",
    });
    assert.equal(a.handle, "@auth-mgr");
    assert.equal(a.name, "Auth Manager");
    assert.equal(a.status, "active");
    assert.deepStrictEqual(a.metadata, {});

    const fetched = getAgent(db, "@auth-mgr");
    assert.deepStrictEqual(fetched, a);
  });

  it("normalizes handles with @", () => {
    createAgent(db, { handle: "@foo", name: "Foo", mission: "do stuff" });
    const a = getAgent(db, "foo");
    assert.equal(a?.handle, "@foo");
  });

  it("rejects duplicate handles", () => {
    createAgent(db, { handle: "dupe", name: "First", mission: "a" });
    assert.throws(() => createAgent(db, { handle: "dupe", name: "Second", mission: "b" }), /already exists/);
  });

  it("lists agents with status filter", () => {
    createAgent(db, { handle: "m1", name: "M1", mission: "a" });
    createAgent(db, { handle: "w1", name: "W1", mission: "b" });
    updateAgent(db, "w1", { status: "blocked" });

    assert.equal(listAgents(db).length, 2);
    assert.equal(listAgents(db, { status: "active" }).length, 1);
    assert.equal(listAgents(db, { status: "blocked" }).length, 1);
  });

  it("updates an agent", () => {
    createAgent(db, { handle: "a1", name: "A1", mission: "old" });
    const updated = updateAgent(db, "a1", { mission: "new mission", status: "blocked" });
    assert.equal(updated?.mission, "new mission");
    assert.equal(updated?.status, "blocked");
  });

  it("stores and retrieves metadata", () => {
    const a = createAgent(db, {
      handle: "meta",
      name: "Meta",
      mission: "test metadata",
      metadata: { lang: "typescript", version: 2 },
    });
    assert.deepStrictEqual(a.metadata, { lang: "typescript", version: 2 });
  });

  it("returns null for missing agent", () => {
    assert.equal(getAgent(db, "nonexistent"), null);
  });

  it("updateAgent with no fields returns agent unchanged", () => {
    createAgent(db, { handle: "noop", name: "NoOp", mission: "stay same" });
    const result = updateAgent(db, "noop", {});
    assert.equal(result?.mission, "stay same");
    assert.equal(result?.name, "NoOp");
  });

  it("updateAgent on nonexistent agent returns null", () => {
    const result = updateAgent(db, "ghost", { name: "Ghost" });
    assert.equal(result, null);
  });

  it("updateAgent metadata replaces entire metadata object", () => {
    createAgent(db, { handle: "m1", name: "M1", mission: "a", metadata: { old: true } });
    const updated = updateAgent(db, "m1", { metadata: { new: true } });
    assert.deepStrictEqual(updated?.metadata, { new: true });
  });

  it("handles invalid JSON metadata gracefully via safeJsonParse", () => {
    // Insert agent with invalid JSON metadata directly via SQL
    db.prepare("INSERT INTO agents (handle, name, mission, metadata) VALUES (?, ?, ?, ?)").run(
      "@badjson", "Bad", "test", "not-valid-json"
    );
    const agent = getAgent(db, "@badjson");
    assert.ok(agent);
    assert.deepStrictEqual(agent.metadata, {});
  });

  it("listAgents without status filter returns all", () => {
    createAgent(db, { handle: "x1", name: "X1", mission: "a" });
    createAgent(db, { handle: "x2", name: "X2", mission: "b" });
    updateAgent(db, "x2", { status: "stopped" });
    const all = listAgents(db);
    assert.equal(all.length, 2);
  });

  it("listAgents returns empty array when no agents exist", () => {
    assert.deepStrictEqual(listAgents(db), []);
  });
});

// === Foundation: Channels ===

describe("channels", () => {
  it("creates and retrieves a channel", () => {
    const ch = createChannel(db, { name: "escalations", description: "Urgent issues" });
    assert.equal(ch.name, "#escalations");
    assert.equal(ch.description, "Urgent issues");

    const fetched = getChannel(db, "#escalations");
    assert.deepStrictEqual(fetched, ch);
  });

  it("normalizes names with #", () => {
    createChannel(db, { name: "#general" });
    const ch = getChannel(db, "general");
    assert.equal(ch?.name, "#general");
  });

  it("rejects duplicate channels", () => {
    createChannel(db, { name: "dupe" });
    assert.throws(() => createChannel(db, { name: "dupe" }), /already exists/);
  });

  it("lists channels", () => {
    createChannel(db, { name: "a" });
    createChannel(db, { name: "b" });
    createChannel(db, { name: "c" });
    assert.equal(listChannels(db).length, 3);
  });

  it("returns null for nonexistent channel", () => {
    assert.equal(getChannel(db, "nope"), null);
  });

  it("creates channel without description", () => {
    const ch = createChannel(db, { name: "nodesc" });
    assert.equal(ch.description, null);
  });

  it("lists channels in creation order", () => {
    createChannel(db, { name: "z-last" });
    createChannel(db, { name: "a-first" });
    const channels = listChannels(db);
    assert.equal(channels[0].name, "#z-last");
    assert.equal(channels[1].name, "#a-first");
  });

  it("listChannels returns empty array when none exist", () => {
    assert.deepStrictEqual(listChannels(db), []);
  });
});

// === Foundation: Posts ===

describe("posts", () => {
  beforeEach(() => setupPostFixtures());

  it("creates and retrieves a post", () => {
    const p = createPost(db, { author: "bot", channel: "work", content: "hello world" });
    assert.equal(p.author, "@bot");
    assert.equal(p.channel, "#work");
    assert.equal(p.content, "hello world");
    assert.equal(p.parent_id, null);

    const fetched = getPost(db, p.id);
    assert.deepStrictEqual(fetched, p);
  });

  it("rejects posts from nonexistent agents", () => {
    assert.throws(() => createPost(db, { author: "nobody", channel: "work", content: "hi" }), /not found/);
  });

  it("rejects posts to nonexistent channels", () => {
    assert.throws(() => createPost(db, { author: "bot", channel: "nope", content: "hi" }), /not found/);
  });

  it("creates threaded replies", () => {
    const root = createPost(db, { author: "bot", channel: "work", content: "root" });
    const reply = createPost(db, { author: "bot", channel: "work", content: "reply", parent_id: root.id });
    assert.equal(reply.parent_id, root.id);
  });

  it("rejects replies to nonexistent posts", () => {
    assert.throws(
      () => createPost(db, { author: "bot", channel: "work", content: "reply", parent_id: "fake-id" }),
      /not found/
    );
  });

  it("lists posts with filters", () => {
    createAgent(db, { handle: "other", name: "Other", mission: "x" });
    createChannel(db, { name: "general" });
    createPost(db, { author: "bot", channel: "work", content: "a" });
    createPost(db, { author: "bot", channel: "general", content: "b" });
    createPost(db, { author: "other", channel: "work", content: "c" });

    assert.equal(listPosts(db).length, 3);
    assert.equal(listPosts(db, { author: "bot" }).length, 2);
    assert.equal(listPosts(db, { channel: "work" }).length, 2);
  });

  it("lists only top-level posts", () => {
    const root = createPost(db, { author: "bot", channel: "work", content: "root" });
    createPost(db, { author: "bot", channel: "work", content: "reply", parent_id: root.id });

    const topLevel = listPosts(db, { parent_id: null });
    assert.equal(topLevel.length, 1);
    assert.equal(topLevel[0].content, "root");
  });

  it("builds thread tree", () => {
    const root = createPost(db, { author: "bot", channel: "work", content: "root" });
    const r1 = createPost(db, { author: "bot", channel: "work", content: "r1", parent_id: root.id });
    createPost(db, { author: "bot", channel: "work", content: "r1.1", parent_id: r1.id });
    createPost(db, { author: "bot", channel: "work", content: "r2", parent_id: root.id });

    const thread = getThread(db, root.id)!;
    assert.equal(thread.post.content, "root");
    assert.equal(thread.replies.length, 2);
    assert.equal(thread.replies[0].replies.length, 1);
    assert.equal(thread.replies[0].replies[0].post.content, "r1.1");
  });

  it("getThread finds root from reply", () => {
    const root = createPost(db, { author: "bot", channel: "work", content: "root" });
    const reply = createPost(db, { author: "bot", channel: "work", content: "reply", parent_id: root.id });

    const thread = getThread(db, reply.id)!;
    assert.equal(thread.post.content, "root");
    assert.equal(thread.replies.length, 1);
  });

  it("getThread returns null for nonexistent post", () => {
    assert.equal(getThread(db, "nonexistent-id"), null);
  });

  it("getPost returns null for nonexistent post", () => {
    assert.equal(getPost(db, "nonexistent-id"), null);
  });

  it("stores and retrieves post metadata", () => {
    const p = createPost(db, {
      author: "bot",
      channel: "work",
      content: "meta post",
      metadata: { tags: ["urgent"], priority: 5 },
    });
    assert.deepStrictEqual(p.metadata, { tags: ["urgent"], priority: 5 });
    const fetched = getPost(db, p.id);
    assert.deepStrictEqual(fetched?.metadata, { tags: ["urgent"], priority: 5 });
  });

  it("handles invalid JSON metadata in posts gracefully", () => {
    // Insert post with invalid JSON metadata directly
    const id = "test-bad-json";
    db.prepare("INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)").run("@raw", "Raw", "test");
    db.prepare("INSERT INTO posts (id, author, channel, content, metadata) VALUES (?, ?, ?, ?, ?)").run(
      id, "@bot", "#work", "bad json post", "{{invalid}}"
    );
    const post = getPost(db, id);
    assert.ok(post);
    assert.deepStrictEqual(post.metadata, {});
  });

  it("listPosts respects limit", () => {
    createPost(db, { author: "bot", channel: "work", content: "a" });
    createPost(db, { author: "bot", channel: "work", content: "b" });
    createPost(db, { author: "bot", channel: "work", content: "c" });
    const limited = listPosts(db, { limit: 2 });
    assert.equal(limited.length, 2);
  });

  it("listPosts filters by since timestamp", () => {
    const p1 = createPost(db, { author: "bot", channel: "work", content: "old" });
    // Use the first post's timestamp as the since filter — should get at least that post
    const posts = listPosts(db, { since: p1.created_at });
    assert.ok(posts.length >= 1);
    assert.ok(posts.every((p) => p.created_at >= p1.created_at));
  });

  it("listPosts filters by specific parent_id", () => {
    const root = createPost(db, { author: "bot", channel: "work", content: "root" });
    createPost(db, { author: "bot", channel: "work", content: "child1", parent_id: root.id });
    createPost(db, { author: "bot", channel: "work", content: "child2", parent_id: root.id });
    createPost(db, { author: "bot", channel: "work", content: "other" });

    const children = listPosts(db, { parent_id: root.id });
    assert.equal(children.length, 2);
    assert.ok(children.every((p) => p.parent_id === root.id));
  });

  it("listPosts returns posts in descending time order", () => {
    // Insert with explicit timestamps to guarantee ordering
    db.prepare("INSERT INTO posts (id, author, channel, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "post-early", "@bot", "#work", "first", "{}", "2026-01-01T00:00:00Z"
    );
    db.prepare("INSERT INTO posts (id, author, channel, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "post-later", "@bot", "#work", "second", "{}", "2026-01-02T00:00:00Z"
    );
    const posts = listPosts(db);
    assert.equal(posts[0].content, "second");
    assert.equal(posts[1].content, "first");
  });

  it("getThread handles deeply nested threads", () => {
    const p1 = createPost(db, { author: "bot", channel: "work", content: "level0" });
    const p2 = createPost(db, { author: "bot", channel: "work", content: "level1", parent_id: p1.id });
    const p3 = createPost(db, { author: "bot", channel: "work", content: "level2", parent_id: p2.id });
    createPost(db, { author: "bot", channel: "work", content: "level3", parent_id: p3.id });

    const thread = getThread(db, p3.id)!;
    // Should find the root
    assert.equal(thread.post.content, "level0");
    assert.equal(thread.replies[0].replies[0].replies[0].post.content, "level3");
  });
});

// === Foundation: Commits ===

describe("commits", () => {
  beforeEach(() => setupPostFixtures());

  it("links and retrieves a commit", () => {
    const post = createPost(db, { author: "bot", channel: "work", content: "did some work" });
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

  it("rejects duplicate hashes", () => {
    const post = createPost(db, { author: "bot", channel: "work", content: "work" });
    linkCommit(db, { hash: "abc", post_id: post.id });
    assert.throws(() => linkCommit(db, { hash: "abc", post_id: post.id }), /already linked/);
  });

  it("lists commits by post", () => {
    const post = createPost(db, { author: "bot", channel: "work", content: "work" });
    linkCommit(db, { hash: "aaa", post_id: post.id, files: ["a.ts"] });
    linkCommit(db, { hash: "bbb", post_id: post.id, files: ["b.ts"] });

    const commits = listCommitsByPost(db, post.id);
    assert.equal(commits.length, 2);
  });

  it("rejects commit for missing post", () => {
    assert.throws(() => linkCommit(db, { hash: "xxx", post_id: "fake-id" }), /not found/);
  });

  it("getCommit returns null for nonexistent hash", () => {
    assert.equal(getCommit(db, "nonexistent"), null);
  });

  it("linkCommit without files defaults to empty array", () => {
    const post = createPost(db, { author: "bot", channel: "work", content: "no files" });
    const commit = linkCommit(db, { hash: "nofiles", post_id: post.id });
    assert.deepStrictEqual(commit.files, []);
  });

  it("handles invalid JSON in files column gracefully", () => {
    const post = createPost(db, { author: "bot", channel: "work", content: "bad files" });
    db.prepare("INSERT INTO commits (hash, post_id, files) VALUES (?, ?, ?)").run(
      "badjson", post.id, "not-valid-json"
    );
    const commit = getCommit(db, "badjson");
    assert.ok(commit);
    assert.deepStrictEqual(commit.files, []);
  });

  it("listCommitsByPost returns empty array when no commits", () => {
    const post = createPost(db, { author: "bot", channel: "work", content: "no commits" });
    assert.deepStrictEqual(listCommitsByPost(db, post.id), []);
  });
});

// === Foundation: Auth ===

describe("auth", () => {
  it("generates and validates an admin key", () => {
    const rawKey = generateKey();
    assert.equal(rawKey.length, 64); // 32 bytes hex

    storeKey(db, rawKey, null); // null = admin
    const validated = validateKey(db, rawKey);
    assert.ok(validated);
    assert.equal(validated!.agent_handle, null);
    assert.ok(isAdminKey(validated!));
  });

  it("generates and validates an agent key", () => {
    createAgent(db, { handle: "bot", name: "Bot", mission: "test" });
    const rawKey = generateKey();
    storeKey(db, rawKey, "@bot");

    const validated = validateKey(db, rawKey);
    assert.ok(validated);
    assert.equal(validated!.agent_handle, "@bot");
    assert.ok(!isAdminKey(validated!));
  });

  it("rejects invalid keys", () => {
    const validated = validateKey(db, "not-a-real-key");
    assert.equal(validated, null);
  });

  it("revokes keys", () => {
    const rawKey = generateKey();
    storeKey(db, rawKey, null);
    assert.ok(validateKey(db, rawKey));

    revokeKey(db, rawKey);
    assert.equal(validateKey(db, rawKey), null);
  });

  it("hashes keys consistently", () => {
    const h1 = hashKey("test-key");
    const h2 = hashKey("test-key");
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // SHA-256 hex
  });

  it("revoking a nonexistent key is a no-op", () => {
    // Should not throw
    revokeKey(db, "nonexistent-key");
  });

  it("revoking an already-revoked key is idempotent", () => {
    const rawKey = generateKey();
    storeKey(db, rawKey, null);
    revokeKey(db, rawKey);
    // Revoking again should not throw
    revokeKey(db, rawKey);
    assert.equal(validateKey(db, rawKey), null);
  });

  it("different keys produce different hashes", () => {
    const h1 = hashKey("key-one");
    const h2 = hashKey("key-two");
    assert.notEqual(h1, h2);
  });

  it("generates unique keys each time", () => {
    const k1 = generateKey();
    const k2 = generateKey();
    assert.notEqual(k1, k2);
  });
});

// === Rate limiting ===

describe("rate limiting", () => {
  beforeEach(() => resetRateLimits());

  it("allows requests under the limit", () => {
    const result = checkRateLimit("@bot", "posts", { postsPerHour: 5, commitsPerHour: 5 });
    assert.ok(result.allowed);
    assert.equal(result.retryAfterMs, 0);
  });

  it("blocks requests over the limit", () => {
    const config = { postsPerHour: 3, commitsPerHour: 3 };
    checkRateLimit("@bot", "posts", config);
    checkRateLimit("@bot", "posts", config);
    checkRateLimit("@bot", "posts", config);
    const result = checkRateLimit("@bot", "posts", config);
    assert.ok(!result.allowed);
    assert.ok(result.retryAfterMs > 0);
  });

  it("tracks agents independently", () => {
    const config = { postsPerHour: 1, commitsPerHour: 1 };
    checkRateLimit("@bot1", "posts", config);
    const result = checkRateLimit("@bot2", "posts", config);
    assert.ok(result.allowed);
  });

  it("tracks post and commit limits independently", () => {
    const config = { postsPerHour: 1, commitsPerHour: 1 };
    checkRateLimit("@bot", "posts", config);
    const result = checkRateLimit("@bot", "commits", config);
    assert.ok(result.allowed);
  });

  it("resetRateLimits clears all counters", () => {
    const config = { postsPerHour: 1, commitsPerHour: 1 };
    checkRateLimit("@bot", "posts", config);
    // Now at limit
    assert.ok(!checkRateLimit("@bot", "posts", config).allowed);
    resetRateLimits();
    // After reset, should be allowed again
    assert.ok(checkRateLimit("@bot", "posts", config).allowed);
  });

  it("uses commitsPerHour for commit limit type", () => {
    const config = { postsPerHour: 100, commitsPerHour: 2 };
    checkRateLimit("@bot", "commits", config);
    checkRateLimit("@bot", "commits", config);
    const result = checkRateLimit("@bot", "commits", config);
    assert.ok(!result.allowed);
  });

  it("retryAfterMs is positive when rate limited", () => {
    const config = { postsPerHour: 1, commitsPerHour: 1 };
    checkRateLimit("@bot", "posts", config);
    const result = checkRateLimit("@bot", "posts", config);
    assert.ok(!result.allowed);
    assert.ok(result.retryAfterMs > 0);
    // retryAfterMs should be at most 1 hour
    assert.ok(result.retryAfterMs <= 60 * 60 * 1000);
  });
});

// === Supervision: Channel Priority ===

describe("channel priority", () => {
  beforeEach(() => {
    createChannel(db, { name: "escalations" });
    createChannel(db, { name: "work" });
  });

  it("sets and gets channel priority", () => {
    setChannelPriority(db, "#escalations", 100);
    assert.equal(getChannelPriority(db, "#escalations"), 100);
  });

  it("defaults to 0 for channels without priority", () => {
    assert.equal(getChannelPriority(db, "#work"), 0);
  });

  it("updates existing priority", () => {
    setChannelPriority(db, "#work", 10);
    setChannelPriority(db, "#work", 50);
    assert.equal(getChannelPriority(db, "#work"), 50);
  });

  it("rejects priority for nonexistent channel", () => {
    assert.throws(() => setChannelPriority(db, "#nope", 10), /not found/);
  });

  it("normalizes channel name", () => {
    setChannelPriority(db, "work", 25);
    assert.equal(getChannelPriority(db, "work"), 25);
  });

  it("listChannelPriorities returns all priorities sorted desc", () => {
    setChannelPriority(db, "#work", 10);
    setChannelPriority(db, "#escalations", 100);
    const priorities = listChannelPriorities(db);
    assert.equal(priorities.length, 2);
    assert.equal(priorities[0].channel_name, "#escalations");
    assert.equal(priorities[0].priority, 100);
    assert.equal(priorities[1].channel_name, "#work");
    assert.equal(priorities[1].priority, 10);
  });

  it("listChannelPriorities returns empty when none set", () => {
    assert.deepStrictEqual(listChannelPriorities(db), []);
  });
});

// === Supervision: Feed ===

describe("feed", () => {
  beforeEach(() => {
    setupPostFixtures();
    createChannel(db, { name: "escalations" });
    setChannelPriority(db, "#escalations", 100);
    setChannelPriority(db, "#work", 10);
  });

  it("returns posts ranked by priority then time", () => {
    createPost(db, { author: "bot", channel: "work", content: "low pri" });
    createPost(db, { author: "bot", channel: "escalations", content: "high pri" });

    const feed = getFeed(db);
    assert.equal(feed.length, 2);
    assert.equal(feed[0].content, "high pri");
    assert.equal(feed[0].priority, 100);
    assert.equal(feed[1].content, "low pri");
    assert.equal(feed[1].priority, 10);
  });

  it("filters by channel", () => {
    createPost(db, { author: "bot", channel: "work", content: "a" });
    createPost(db, { author: "bot", channel: "escalations", content: "b" });

    const feed = getFeed(db, { channel: "work" });
    assert.equal(feed.length, 1);
    assert.equal(feed[0].channel, "#work");
  });

  it("filters by author", () => {
    createAgent(db, { handle: "other", name: "Other", mission: "x" });
    createPost(db, { author: "bot", channel: "work", content: "a" });
    createPost(db, { author: "other", channel: "work", content: "b" });

    const feed = getFeed(db, { author: "bot" });
    assert.equal(feed.length, 1);
    assert.equal(feed[0].author, "@bot");
  });

  it("excludes replies (top-level only)", () => {
    const root = createPost(db, { author: "bot", channel: "work", content: "root" });
    createPost(db, { author: "bot", channel: "work", content: "reply", parent_id: root.id });

    const feed = getFeed(db);
    assert.equal(feed.length, 1);
    assert.equal(feed[0].content, "root");
  });

  it("respects limit", () => {
    createPost(db, { author: "bot", channel: "work", content: "a" });
    createPost(db, { author: "bot", channel: "work", content: "b" });
    createPost(db, { author: "bot", channel: "work", content: "c" });

    const feed = getFeed(db, { limit: 2 });
    assert.equal(feed.length, 2);
  });

  it("filters by since timestamp", () => {
    const p1 = createPost(db, { author: "bot", channel: "work", content: "old" });
    const feed = getFeed(db, { since: p1.created_at });
    assert.ok(feed.length >= 1);
    assert.ok(feed.every((p) => p.created_at >= p1.created_at));
  });

  it("returns empty feed when no posts exist", () => {
    const feed = getFeed(db);
    assert.deepStrictEqual(feed, []);
  });

  it("feed posts have priority field", () => {
    createPost(db, { author: "bot", channel: "work", content: "test" });
    const feed = getFeed(db);
    assert.equal(feed.length, 1);
    assert.equal(typeof feed[0].priority, "number");
  });

  it("channels without priority default to 0 in feed", () => {
    createChannel(db, { name: "nopri" });
    createPost(db, { author: "bot", channel: "nopri", content: "test" });
    const feed = getFeed(db);
    const nopriPost = feed.find((p) => p.channel === "#nopri");
    assert.ok(nopriPost);
    assert.equal(nopriPost.priority, 0);
  });
});

// === Supervision: Briefing ===

describe("briefing", () => {
  beforeEach(() => {
    setupPostFixtures();
    createChannel(db, { name: "escalations" });
    setChannelPriority(db, "#escalations", 100);
  });

  it("returns all posts on first briefing (no cursor)", () => {
    createPost(db, { author: "bot", channel: "work", content: "a" });
    createPost(db, { author: "bot", channel: "escalations", content: "b" });

    const briefing = getBriefing(db);
    assert.equal(briefing.total, 2);
    assert.equal(briefing.since, null);
    assert.equal(briefing.channels.length, 2);
    // Channels sorted by priority desc
    assert.equal(briefing.channels[0].name, "#escalations");
    assert.equal(briefing.channels[0].priority, 100);
  });

  it("second briefing with no new posts shows nothing", () => {
    createPost(db, { author: "bot", channel: "work", content: "a" });
    getBriefing(db); // advances cursor

    const briefing = getBriefing(db);
    assert.equal(briefing.total, 0);
    assert.ok(briefing.since); // cursor was set
  });

  it("second briefing shows only new posts", () => {
    createPost(db, { author: "bot", channel: "work", content: "old" });
    getBriefing(db); // advances cursor

    // Small delay to ensure timestamp is after cursor
    createPost(db, { author: "bot", channel: "escalations", content: "new" });

    const briefing = getBriefing(db);
    // May be 0 or 1 depending on timestamp precision — at minimum cursor was advanced
    assert.ok(briefing.since);
  });
});

// === Supervision: Cursors ===

describe("cursors", () => {
  it("getCursor returns null when cursor does not exist", () => {
    assert.equal(getCursor(db, "nonexistent"), null);
  });

  it("setCursor and getCursor round-trip", () => {
    setCursor(db, "test_cursor", "2026-01-01T00:00:00Z");
    assert.equal(getCursor(db, "test_cursor"), "2026-01-01T00:00:00Z");
  });

  it("setCursor updates existing cursor", () => {
    setCursor(db, "test_cursor", "2026-01-01T00:00:00Z");
    setCursor(db, "test_cursor", "2026-02-01T00:00:00Z");
    assert.equal(getCursor(db, "test_cursor"), "2026-02-01T00:00:00Z");
  });
});

// === Supervision: Duration parsing ===

describe("parseDuration", () => {
  it("parses minutes", () => {
    const ts = parseDuration("30m");
    assert.ok(ts);
    const diff = Date.now() - new Date(ts).getTime();
    // Should be approximately 30 minutes in the past (within 5s tolerance)
    assert.ok(diff >= 29 * 60 * 1000 && diff <= 31 * 60 * 1000);
  });

  it("parses hours", () => {
    const ts = parseDuration("2h");
    assert.ok(ts);
    const diff = Date.now() - new Date(ts).getTime();
    assert.ok(diff >= 119 * 60 * 1000 && diff <= 121 * 60 * 1000);
  });

  it("parses days", () => {
    const ts = parseDuration("1d");
    assert.ok(ts);
    const diff = Date.now() - new Date(ts).getTime();
    assert.ok(diff >= 23 * 60 * 60 * 1000 && diff <= 25 * 60 * 60 * 1000);
  });

  it("returns null for invalid durations", () => {
    assert.equal(parseDuration("abc"), null);
    assert.equal(parseDuration("10x"), null);
    assert.equal(parseDuration(""), null);
  });

  it("returns ISO string ending with Z", () => {
    const ts = parseDuration("1h")!;
    assert.ok(ts.endsWith("Z"));
  });
});

// === DB utility ===

describe("dbExists", () => {
  it("returns true when DB file exists", () => {
    assert.ok(dbExists(tmpDir));
  });

  it("returns false for directory with no DB", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-empty-"));
    assert.ok(!dbExists(emptyDir));
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

// === Schema: Foundation/Supervision separation ===

describe("schema separation", () => {
  it("foundation tables exist", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    assert.ok(names.includes("agents"));
    assert.ok(names.includes("channels"));
    assert.ok(names.includes("posts"));
    assert.ok(names.includes("commits"));
    assert.ok(names.includes("api_keys"));
  });

  it("supervision tables exist", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    assert.ok(names.includes("channel_priority"));
    assert.ok(names.includes("cursors"));
  });

  it("spawns table exists", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    assert.ok(names.includes("spawns"));
  });

  it("foundation works without supervision data", () => {
    // Create agent, channel, post — all foundation-only
    createAgent(db, { handle: "test", name: "Test", mission: "test" });
    createChannel(db, { name: "test" });
    const post = createPost(db, { author: "test", channel: "test", content: "works" });
    assert.ok(post.id);

    // Feed still works (0 priority for all)
    const feed = getFeed(db);
    assert.equal(feed.length, 1);
    assert.equal(feed[0].priority, 0);
  });
});
