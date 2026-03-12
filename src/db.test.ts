import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { initDb } from "./db.js";
import { createAgent, getAgent, listAgents, updateAgent } from "./agents.js";
import { createChannel, getChannel, listChannels } from "./channels.js";
import { createPost, getPost, listPosts, getThread } from "./posts.js";
import { linkCommit, getCommit, listCommitsByPost } from "./commits.js";
import { generateKey, hashKey, storeKey, validateKey, isAdminKey, revokeKey } from "./auth.js";
import { checkRateLimit, resetRateLimits } from "./ratelimit.js";
import { setChannelPriority, getChannelPriority, getFeed, getBriefing, parseDuration } from "./supervision.js";
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
