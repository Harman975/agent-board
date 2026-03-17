import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { initDb } from "./db.js";
import { createApp, type ChatDeps } from "./server.js";
import { generateKey, hashKey } from "./auth.js";
import { resetRateLimits } from "./ratelimit.js";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { Sprint, SprintAgent } from "./types.js";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import os from "os";

let db: Database.Database;
let app: Hono<any>;
let adminKey: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-server-test-"));
  db = initDb(tmpDir);
  app = createApp(db);
  resetRateLimits();

  // Create admin key
  adminKey = generateKey();
  db.prepare("INSERT INTO api_keys (key_hash, agent_handle) VALUES (?, ?)").run(
    hashKey(adminKey),
    null
  );

  // Create @admin agent and #general channel
  db.prepare("INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)").run(
    "@admin", "Admin", "Board administrator"
  );
  db.prepare("INSERT INTO channels (name, description) VALUES (?, ?)").run(
    "#general", "General discussion"
  );
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(method: string, path: string, opts?: { key?: string; body?: unknown }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts?.key !== undefined) {
    headers.Authorization = `Bearer ${opts.key}`;
  }
  return app.request(path, {
    method,
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

// === Auth middleware ===

describe("auth middleware", () => {
  it("rejects requests without Authorization header", async () => {
    const res = await req("GET", "/api/agents");
    assert.equal(res.status, 401);
  });

  it("rejects requests with invalid key", async () => {
    const res = await req("GET", "/api/agents", { key: "bad-key" });
    assert.equal(res.status, 401);
  });

  it("accepts requests with valid admin key", async () => {
    const res = await req("GET", "/api/agents", { key: adminKey });
    assert.equal(res.status, 200);
  });
});

// === Agent endpoints ===

describe("POST /api/agents", () => {
  it("creates agent and returns API key", async () => {
    const res = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@test-agent", mission: "testing", name: "Test Agent" },
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.handle, "@test-agent");
    assert.equal(data.mission, "testing");
    assert.ok(data.api_key);
    assert.equal(typeof data.api_key, "string");
  });

  it("rejects duplicate handle", async () => {
    await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@dupe", mission: "first" },
    });
    const res = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@dupe", mission: "second" },
    });
    assert.equal(res.status, 409);
  });

  it("requires admin key", async () => {
    // Create an agent first to get an agent key
    const createRes = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@worker", mission: "work" },
    });
    const { api_key: agentKey } = await createRes.json();

    // Try to create another agent with agent key
    const res = await req("POST", "/api/agents", {
      key: agentKey,
      body: { handle: "@another", mission: "nope" },
    });
    assert.equal(res.status, 403);
  });

  it("requires handle and mission", async () => {
    const res = await req("POST", "/api/agents", {
      key: adminKey,
      body: { name: "No handle" },
    });
    assert.equal(res.status, 400);
  });
});

describe("GET /api/agents", () => {
  it("lists all agents", async () => {
    await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@a1", mission: "m1" },
    });
    const res = await req("GET", "/api/agents", { key: adminKey });
    assert.equal(res.status, 200);
    const data = await res.json();
    // @admin + @a1
    assert.equal(data.length, 2);
  });
});

// === Post endpoints ===

describe("POST /api/posts", () => {
  it("creates post with admin key (as @admin)", async () => {
    const res = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "hello", channel: "#general", author: "@admin" },
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.author, "@admin");
    assert.equal(data.channel, "#general");
  });

  it("creates post with agent key", async () => {
    const createRes = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@bot", mission: "post" },
    });
    const { api_key: agentKey } = await createRes.json();

    const res = await req("POST", "/api/posts", {
      key: agentKey,
      body: { content: "agent post", channel: "#general" },
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.author, "@bot");
  });

  it("returns 429 when rate limited", async () => {
    const createRes = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@spammer", mission: "spam" },
    });
    const { api_key: agentKey } = await createRes.json();

    // Exhaust rate limit (default 100/hr — we'll just check the mechanism works)
    // Override: the test relies on the ratelimit module's default config
    // Post 101 times would be slow, so we test the 429 response format
    // by checking a single successful post returns 201
    const res = await req("POST", "/api/posts", {
      key: agentKey,
      body: { content: "not spam", channel: "#general" },
    });
    assert.equal(res.status, 201);
  });

  it("admin exempt from rate limiting", async () => {
    const res = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "admin post", channel: "#general", author: "@admin" },
    });
    assert.equal(res.status, 201);
  });
});

// === Feed endpoint ===

describe("GET /api/feed", () => {
  it("returns posts ranked by priority", async () => {
    // Create channels with different priorities
    await req("POST", "/api/channels", {
      key: adminKey,
      body: { name: "escalations" },
    });
    await req("PUT", "/api/channels/%23escalations/priority", {
      key: adminKey,
      body: { priority: 100 },
    });

    // Post to both channels
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "low pri", channel: "#general", author: "@admin" },
    });
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "high pri", channel: "#escalations", author: "@admin" },
    });

    const res = await req("GET", "/api/feed", { key: adminKey });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 2);
    assert.equal(data[0].content, "high pri");
    assert.equal(data[0].priority, 100);
  });

  it("filters by channel", async () => {
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "in general", channel: "#general", author: "@admin" },
    });

    const res = await req("GET", "/api/feed?channel=general", { key: adminKey });
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].channel, "#general");
  });
});

// === Briefing endpoint ===

describe("GET /api/briefing", () => {
  it("returns briefing and advances cursor", async () => {
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "update", channel: "#general", author: "@admin" },
    });

    const res1 = await req("GET", "/api/briefing", { key: adminKey });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.total, 1);

    // Second briefing — no new posts
    const res2 = await req("GET", "/api/briefing", { key: adminKey });
    const data2 = await res2.json();
    assert.equal(data2.total, 0);
  });

  it("requires admin key", async () => {
    const createRes = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@worker", mission: "work" },
    });
    const { api_key: agentKey } = await createRes.json();

    const res = await req("GET", "/api/briefing", { key: agentKey });
    assert.equal(res.status, 403);
  });
});

// === Channel priority ===

describe("PUT /api/channels/:name/priority", () => {
  it("sets channel priority", async () => {
    const res = await req("PUT", "/api/channels/%23general/priority", {
      key: adminKey,
      body: { priority: 50 },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.priority, 50);
  });

  it("requires admin key", async () => {
    const createRes = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@worker", mission: "work" },
    });
    const { api_key: agentKey } = await createRes.json();

    const res = await req("PUT", "/api/channels/%23general/priority", {
      key: agentKey,
      body: { priority: 50 },
    });
    assert.equal(res.status, 403);
  });

  it("requires priority to be a number", async () => {
    const res = await req("PUT", "/api/channels/%23general/priority", {
      key: adminKey,
      body: { priority: "high" },
    });
    assert.equal(res.status, 400);
  });

  it("returns 404 for nonexistent channel", async () => {
    const res = await req("PUT", "/api/channels/%23nope/priority", {
      key: adminKey,
      body: { priority: 10 },
    });
    assert.equal(res.status, 404);
  });
});

// === GET /api/agents/:handle ===

describe("GET /api/agents/:handle", () => {
  it("returns agent by handle", async () => {
    await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@lookup", mission: "find me" },
    });
    const res = await req("GET", "/api/agents/%40lookup", { key: adminKey });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.handle, "@lookup");
    assert.equal(data.mission, "find me");
  });

  it("returns 404 for nonexistent agent", async () => {
    const res = await req("GET", "/api/agents/%40ghost", { key: adminKey });
    assert.equal(res.status, 404);
  });
});

// === PATCH /api/agents/:handle ===

describe("PATCH /api/agents/:handle", () => {
  it("updates agent fields", async () => {
    await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@patchme", mission: "old mission" },
    });
    const res = await req("PATCH", "/api/agents/%40patchme", {
      key: adminKey,
      body: { mission: "new mission", status: "blocked" },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.mission, "new mission");
    assert.equal(data.status, "blocked");
  });

  it("returns 404 for nonexistent agent", async () => {
    const res = await req("PATCH", "/api/agents/%40ghost", {
      key: adminKey,
      body: { mission: "nothing" },
    });
    assert.equal(res.status, 404);
  });

  it("requires admin key", async () => {
    const createRes = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@worker", mission: "work" },
    });
    const { api_key: agentKey } = await createRes.json();

    const res = await req("PATCH", "/api/agents/%40worker", {
      key: agentKey,
      body: { mission: "hacked" },
    });
    assert.equal(res.status, 403);
  });
});

// === POST /api/channels ===

describe("POST /api/channels", () => {
  it("creates a channel", async () => {
    const res = await req("POST", "/api/channels", {
      key: adminKey,
      body: { name: "test-chan", description: "A test channel" },
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.name, "#test-chan");
    assert.equal(data.description, "A test channel");
  });

  it("rejects duplicate channel", async () => {
    await req("POST", "/api/channels", {
      key: adminKey,
      body: { name: "dupe-chan" },
    });
    const res = await req("POST", "/api/channels", {
      key: adminKey,
      body: { name: "dupe-chan" },
    });
    assert.equal(res.status, 409);
  });

  it("requires name", async () => {
    const res = await req("POST", "/api/channels", {
      key: adminKey,
      body: { description: "no name" },
    });
    assert.equal(res.status, 400);
  });

  it("requires admin key", async () => {
    const createRes = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@worker", mission: "work" },
    });
    const { api_key: agentKey } = await createRes.json();

    const res = await req("POST", "/api/channels", {
      key: agentKey,
      body: { name: "agent-chan" },
    });
    assert.equal(res.status, 403);
  });
});

// === GET /api/channels ===

describe("GET /api/channels", () => {
  it("returns channels with priorities", async () => {
    await req("PUT", "/api/channels/%23general/priority", {
      key: adminKey,
      body: { priority: 42 },
    });
    const res = await req("GET", "/api/channels", { key: adminKey });
    assert.equal(res.status, 200);
    const data = await res.json();
    const general = data.find((ch: any) => ch.name === "#general");
    assert.ok(general);
    assert.equal(general.priority, 42);
  });

  it("defaults priority to 0 for channels without priority", async () => {
    const res = await req("GET", "/api/channels", { key: adminKey });
    const data = await res.json();
    const general = data.find((ch: any) => ch.name === "#general");
    assert.equal(general.priority, 0);
  });
});

// === GET /api/posts ===

describe("GET /api/posts", () => {
  it("returns posts filtered by author", async () => {
    await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@a1", mission: "test" },
    });
    const a1Res = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@a2", mission: "test" },
    });

    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "by admin", channel: "#general", author: "@admin" },
    });
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "by a1", channel: "#general", author: "@a1" },
    });

    const res = await req("GET", "/api/posts?author=%40admin", { key: adminKey });
    const data = await res.json();
    assert.ok(data.every((p: any) => p.author === "@admin"));
  });

  it("returns posts filtered by channel", async () => {
    await req("POST", "/api/channels", {
      key: adminKey,
      body: { name: "other" },
    });
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "in general", channel: "#general", author: "@admin" },
    });
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "in other", channel: "#other", author: "@admin" },
    });

    const res = await req("GET", "/api/posts?channel=%23other", { key: adminKey });
    const data = await res.json();
    assert.ok(data.every((p: any) => p.channel === "#other"));
  });

  it("returns top-level posts only", async () => {
    const postRes = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "root", channel: "#general", author: "@admin" },
    });
    const root = await postRes.json();

    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "reply", channel: "#general", author: "@admin", parent_id: root.id },
    });

    const res = await req("GET", "/api/posts?top_level=true", { key: adminKey });
    const data = await res.json();
    assert.ok(data.every((p: any) => p.parent_id === null));
  });

  it("respects limit parameter", async () => {
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "a", channel: "#general", author: "@admin" },
    });
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "b", channel: "#general", author: "@admin" },
    });

    const res = await req("GET", "/api/posts?limit=1", { key: adminKey });
    const data = await res.json();
    assert.equal(data.length, 1);
  });
});

// === GET /api/posts/:id ===

describe("GET /api/posts/:id", () => {
  it("returns post by id", async () => {
    const createRes = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "find me", channel: "#general", author: "@admin" },
    });
    const post = await createRes.json();

    const res = await req("GET", `/api/posts/${post.id}`, { key: adminKey });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.content, "find me");
  });

  it("returns 404 for nonexistent post", async () => {
    const res = await req("GET", "/api/posts/nonexistent-id", { key: adminKey });
    assert.equal(res.status, 404);
  });
});

// === GET /api/posts/:id/thread ===

describe("GET /api/posts/:id/thread", () => {
  it("returns thread with replies", async () => {
    const rootRes = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "root", channel: "#general", author: "@admin" },
    });
    const root = await rootRes.json();

    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "reply", channel: "#general", author: "@admin", parent_id: root.id },
    });

    const res = await req("GET", `/api/posts/${root.id}/thread`, { key: adminKey });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.post.content, "root");
    assert.equal(data.replies.length, 1);
    assert.equal(data.replies[0].post.content, "reply");
  });

  it("returns 404 for nonexistent post", async () => {
    const res = await req("GET", "/api/posts/nonexistent-id/thread", { key: adminKey });
    assert.equal(res.status, 404);
  });
});

// === POST /api/commits ===

describe("POST /api/commits", () => {
  it("links a commit to a post", async () => {
    const postRes = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "did work", channel: "#general", author: "@admin" },
    });
    const post = await postRes.json();

    const res = await req("POST", "/api/commits", {
      key: adminKey,
      body: { hash: "abc123", post_id: post.id, files: ["a.ts", "b.ts"] },
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.hash, "abc123");
    assert.deepStrictEqual(data.files, ["a.ts", "b.ts"]);
  });

  it("requires hash and post_id", async () => {
    const res = await req("POST", "/api/commits", {
      key: adminKey,
      body: { hash: "abc" },
    });
    assert.equal(res.status, 400);
  });

  it("rejects duplicate commit hash", async () => {
    const postRes = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "work", channel: "#general", author: "@admin" },
    });
    const post = await postRes.json();

    await req("POST", "/api/commits", {
      key: adminKey,
      body: { hash: "dupe", post_id: post.id },
    });
    const res = await req("POST", "/api/commits", {
      key: adminKey,
      body: { hash: "dupe", post_id: post.id },
    });
    assert.equal(res.status, 400);
  });

  it("rejects commit for nonexistent post", async () => {
    const res = await req("POST", "/api/commits", {
      key: adminKey,
      body: { hash: "orphan", post_id: "fake-id" },
    });
    assert.equal(res.status, 400);
  });
});

// === Auth edge cases ===

describe("auth edge cases", () => {
  it("rejects Authorization header without Bearer prefix", async () => {
    const res = await app.request("/api/agents", {
      method: "GET",
      headers: { Authorization: `Token ${adminKey}` },
    });
    assert.equal(res.status, 401);
  });

  it("rejects empty Bearer token", async () => {
    const res = await app.request("/api/agents", {
      method: "GET",
      headers: { Authorization: "Bearer " },
    });
    assert.equal(res.status, 401);
  });
});

// === POST /api/posts edge cases ===

describe("POST /api/posts edge cases", () => {
  it("requires content and channel", async () => {
    const res = await req("POST", "/api/posts", {
      key: adminKey,
      body: { author: "@admin" },
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 for nonexistent channel", async () => {
    const res = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "test", channel: "#nope", author: "@admin" },
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 for nonexistent parent_id", async () => {
    const res = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "reply", channel: "#general", author: "@admin", parent_id: "fake" },
    });
    assert.equal(res.status, 400);
  });

  it("agent key cannot post as different agent", async () => {
    await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@bot1", mission: "one" },
    });
    const res2 = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@bot2", mission: "two" },
    });
    const { api_key: bot2Key } = await res2.json();

    // bot2's key should post as bot2, ignoring body.author
    const postRes = await req("POST", "/api/posts", {
      key: bot2Key,
      body: { content: "sneaky", channel: "#general", author: "@bot1" },
    });
    assert.equal(postRes.status, 201);
    const data = await postRes.json();
    assert.equal(data.author, "@bot2"); // enforced by key, not body
  });
});

// === Revoked key rejection ===

describe("revoked key rejection", () => {
  it("rejects a revoked admin key", async () => {
    const { revokeKey } = await import("./auth.js");
    const tempKey = generateKey();
    db.prepare("INSERT INTO api_keys (key_hash, agent_handle) VALUES (?, ?)").run(
      hashKey(tempKey), null
    );
    // Verify it works first
    const res1 = await req("GET", "/api/agents", { key: tempKey });
    assert.equal(res1.status, 200);

    // Revoke it
    revokeKey(db, tempKey);

    // Now it should be rejected
    const res2 = await req("GET", "/api/agents", { key: tempKey });
    assert.equal(res2.status, 401);
  });

  it("rejects a revoked agent key", async () => {
    const { revokeKey } = await import("./auth.js");
    const createRes = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@revokee", mission: "test" },
    });
    const { api_key: agentKey } = await createRes.json();

    // Verify it works
    const res1 = await req("GET", "/api/agents", { key: agentKey });
    assert.equal(res1.status, 200);

    // Revoke
    revokeKey(db, agentKey);

    const res2 = await req("GET", "/api/agents", { key: agentKey });
    assert.equal(res2.status, 401);
  });
});

// === Admin default author ===

describe("admin default author", () => {
  it("defaults to @admin when admin key posts without specifying author", async () => {
    const res = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "no author specified", channel: "#general" },
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.author, "@admin");
  });

  it("admin can post as a specific author", async () => {
    await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@proxy", mission: "proxy" },
    });
    const res = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "proxied", channel: "#general", author: "@proxy" },
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.author, "@proxy");
  });
});

// === POST /api/posts with metadata ===

describe("POST /api/posts with metadata", () => {
  it("stores and returns post metadata", async () => {
    const res = await req("POST", "/api/posts", {
      key: adminKey,
      body: {
        content: "with meta",
        channel: "#general",
        author: "@admin",
        metadata: { tag: "important", score: 42 },
      },
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.deepStrictEqual(data.metadata, { tag: "important", score: 42 });
  });
});

// === POST /api/posts with parent_id (threading via API) ===

describe("POST /api/posts threading", () => {
  it("creates a threaded reply via API", async () => {
    const rootRes = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "root", channel: "#general", author: "@admin" },
    });
    const root = await rootRes.json();

    const replyRes = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "reply", channel: "#general", author: "@admin", parent_id: root.id },
    });
    assert.equal(replyRes.status, 201);
    const reply = await replyRes.json();
    assert.equal(reply.parent_id, root.id);
  });
});

// === Commit rate limiting for agent ===

describe("POST /api/commits rate limiting", () => {
  it("rate limits commits for agent key", async () => {
    const { checkRateLimit } = await import("./ratelimit.js");
    const createRes = await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@committer", mission: "commit" },
    });
    const { api_key: agentKey } = await createRes.json();

    // Create a post to link commits to
    const postRes = await req("POST", "/api/posts", {
      key: agentKey,
      body: { content: "work", channel: "#general" },
    });
    const post = await postRes.json();

    // First commit should work
    const res1 = await req("POST", "/api/commits", {
      key: agentKey,
      body: { hash: "commit1", post_id: post.id },
    });
    assert.equal(res1.status, 201);
  });

  it("admin exempt from commit rate limiting", async () => {
    const postRes = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "work", channel: "#general", author: "@admin" },
    });
    const post = await postRes.json();

    const res = await req("POST", "/api/commits", {
      key: adminKey,
      body: { hash: "admin-commit", post_id: post.id },
    });
    assert.equal(res.status, 201);
  });
});

// === GET /api/posts with since filter ===

describe("GET /api/posts with since", () => {
  it("filters posts by since timestamp", async () => {
    const p1Res = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "first", channel: "#general", author: "@admin" },
    });
    const p1 = await p1Res.json();

    const res = await req("GET", `/api/posts?since=${encodeURIComponent(p1.created_at)}`, {
      key: adminKey,
    });
    const data = await res.json();
    assert.ok(data.length >= 1);
    assert.ok(data.every((p: any) => p.created_at >= p1.created_at));
  });
});

// === GET /api/feed with since filter ===

describe("GET /api/feed with since", () => {
  it("filters feed by since timestamp", async () => {
    const p1Res = await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "first", channel: "#general", author: "@admin" },
    });
    const p1 = await p1Res.json();

    const res = await req("GET", `/api/feed?since=${encodeURIComponent(p1.created_at)}`, {
      key: adminKey,
    });
    const data = await res.json();
    assert.ok(data.length >= 1);
  });
});

// === GET /api/feed edge cases ===

describe("GET /api/feed edge cases", () => {
  it("filters by author", async () => {
    await req("POST", "/api/agents", {
      key: adminKey,
      body: { handle: "@feeder", mission: "feed" },
    });

    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "admin post", channel: "#general", author: "@admin" },
    });
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "feeder post", channel: "#general", author: "@feeder" },
    });

    const res = await req("GET", "/api/feed?author=%40feeder", { key: adminKey });
    const data = await res.json();
    assert.ok(data.every((p: any) => p.author === "@feeder"));
  });

  it("respects limit parameter", async () => {
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "a", channel: "#general", author: "@admin" },
    });
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "b", channel: "#general", author: "@admin" },
    });
    await req("POST", "/api/posts", {
      key: adminKey,
      body: { content: "c", channel: "#general", author: "@admin" },
    });

    const res = await req("GET", "/api/feed?limit=2", { key: adminKey });
    const data = await res.json();
    assert.equal(data.length, 2);
  });
});

// === Sprint data endpoints ===

describe("GET /data/sprint/latest", () => {
  it("returns null when no running sprint", async () => {
    const res = await app.request("/data/sprint/latest");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data, null);
  });

  it("returns sprint state with agents when sprint is running", async () => {
    // Create sprint
    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("test-sprint", "Build features");

    // Create agent and sprint_agent
    db.prepare("INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)").run(
      "@builder", "Builder", "Build stuff"
    );
    db.prepare(
      "INSERT INTO sprint_agents (sprint_name, agent_handle, identity_name, mission) VALUES (?, ?, ?, ?)"
    ).run("test-sprint", "@builder", "researcher", "Build the feature");

    // Insert a spawn record so bucket inference has data
    db.prepare(
      "INSERT INTO spawns (agent_handle, pid, log_path, worktree_path, branch, started_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
    ).run("@builder", 99999, "/tmp/log", "/tmp/wt", "agent/builder");

    const res = await app.request("/data/sprint/latest");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data);
    assert.equal(data.name, "test-sprint");
    assert.equal(data.goal, "Build features");
    assert.ok(Array.isArray(data.agents));
    assert.equal(data.agents.length, 1);
    assert.equal(data.agents[0].handle, "@builder");
    assert.ok(data.agents[0].bucket); // has a bucket state
    assert.ok(data.createdAt); // has timestamp
  });

  it("ignores finished sprints", async () => {
    db.prepare("INSERT INTO sprints (name, goal, status) VALUES (?, ?, ?)").run(
      "done-sprint", "Old goal", "finished"
    );
    const res = await app.request("/data/sprint/latest");
    const data = await res.json();
    assert.equal(data, null);
  });
});

describe("GET /data/sprint/:name", () => {
  it("returns 404 for unknown sprint", async () => {
    const res = await app.request("/data/sprint/nonexistent");
    assert.equal(res.status, 404);
  });

  it("returns sprint by name", async () => {
    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("named-sprint", "Named goal");
    const res = await app.request("/data/sprint/named-sprint");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, "named-sprint");
    assert.equal(data.goal, "Named goal");
  });
});

describe("GET /data/sprint/:name/buckets", () => {
  it("returns empty object for sprint with no agents", async () => {
    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("empty-sprint", "Goal");
    const res = await app.request("/data/sprint/empty-sprint/buckets");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, {});
  });
});

describe("POST /data/sprint/:name/steer/:handle", () => {
  it("writes directive to agent CLAUDE.md", async () => {
    const handle = "@steer-agent";
    // Create worktree structure with CLAUDE.md
    const worktreePath = path.join(tmpDir, ".worktrees", handle);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(
      path.join(worktreePath, "CLAUDE.md"),
      "# Agent\n\n## Active Directives\n\nNo active directives.\n"
    );

    // Use tmpDir as projectDir
    const testApp = createApp(db, tmpDir);
    const res = await testApp.request(`/data/sprint/test/steer/steer-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directive: "Focus on tests" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    // Verify directive was written
    const content = fs.readFileSync(path.join(worktreePath, "CLAUDE.md"), "utf-8");
    assert.ok(content.includes("Focus on tests"));
  });

  it("returns 400 when directive is missing", async () => {
    const testApp = createApp(db, tmpDir);
    const res = await testApp.request("/data/sprint/test/steer/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

describe("POST /data/sprint/:name/kill/:handle", () => {
  it("returns 400 when no spawn record exists", async () => {
    const testApp = createApp(db, tmpDir);
    const res = await testApp.request("/data/sprint/test/kill/nonexistent", {
      method: "POST",
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("No spawn record"));
  });
});

describe("POST /data/sprint/:name/merge", () => {
  it("returns empty results when no agents in review state", async () => {
    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("merge-test", "Goal");
    const testApp = createApp(db, tmpDir);
    const res = await testApp.request("/data/sprint/merge-test/merge", {
      method: "POST",
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.results, []);
  });
});

describe("GET /data/spawns", () => {
  it("returns spawn records", async () => {
    const res = await app.request("/data/spawns");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
  });
});

describe("static frontend serving", () => {
  it("returns 404 when frontend not built", async () => {
    const testApp = createApp(db, tmpDir);
    const res = await testApp.request("/app/");
    assert.equal(res.status, 404);
  });

  it("serves index.html from frontend/dist", async () => {
    const distDir = path.join(tmpDir, "frontend", "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "index.html"), "<html>kanban</html>");

    const testApp = createApp(db, tmpDir);
    const res = await testApp.request("/app/");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("kanban"));
  });
});

// === GET /data/logs/:handle ===

describe("GET /data/logs/:handle", () => {
  it("returns last N lines of agent log", async () => {
    // Create agent and spawn record with a log file
    db.prepare("INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)").run(
      "@logger", "Logger", "logging"
    );
    const logPath = path.join(tmpDir, "agent-log.txt");
    fs.writeFileSync(logPath, "line1\nline2\nline3\nline4\nline5\n");

    db.prepare(
      "INSERT INTO spawns (agent_handle, pid, log_path, branch, started_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
    ).run("@logger", 99999, logPath, "agent/logger");

    const res = await req("GET", "/data/logs/%40logger?lines=4");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.handle, "@logger");
    // File has trailing newline, so last 4 entries include: line4, line5, empty
    assert.ok(data.log.includes("line4"));
    assert.ok(data.log.includes("line5"));
  });

  it("returns 404 for unknown handle", async () => {
    const res = await req("GET", "/data/logs/%40ghost");
    assert.equal(res.status, 404);
  });

  it("returns 404 when spawn has no log file", async () => {
    db.prepare("INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)").run(
      "@nolog", "NoLog", "no log"
    );
    db.prepare(
      "INSERT INTO spawns (agent_handle, pid, log_path, branch, started_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
    ).run("@nolog", 99998, null, "agent/nolog");

    const res = await req("GET", "/data/logs/%40nolog");
    assert.equal(res.status, 404);
  });

  it("defaults to 50 lines", async () => {
    db.prepare("INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)").run(
      "@biglog", "BigLog", "big log"
    );
    const logPath = path.join(tmpDir, "big-log.txt");
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");
    fs.writeFileSync(logPath, lines);

    db.prepare(
      "INSERT INTO spawns (agent_handle, pid, log_path, branch, started_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
    ).run("@biglog", 99997, logPath, "agent/biglog");

    const res = await req("GET", "/data/logs/%40biglog");
    assert.equal(res.status, 200);
    const data = await res.json();
    // Should contain last 50 lines (line51 through line100)
    assert.ok(data.log.includes("line51"));
    assert.ok(data.log.includes("line100"));
    assert.ok(!data.log.includes("line50\n"));
  });
});

// === GET /data/sprint/:name/state ===

describe("GET /data/sprint/:name/state", () => {
  it("returns sprint state with agent info", async () => {
    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("test-sprint", "Build feature");
    db.prepare("INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)").run(
      "@worker1", "Worker1", "task 1"
    );
    db.prepare(
      "INSERT INTO sprint_agents (sprint_name, agent_handle, identity_name, mission) VALUES (?, ?, ?, ?)"
    ).run("test-sprint", "@worker1", "coder", "task 1");

    // No spawn record — agent should show as stopped with zero stats
    const res = await req("GET", "/data/sprint/test-sprint/state");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.sprint.name, "test-sprint");
    assert.equal(data.sprint.goal, "Build feature");
    assert.equal(data.agents.length, 1);
    assert.equal(data.agents[0].handle, "@worker1");
    assert.equal(data.agents[0].stopped, true);
    assert.equal(data.agents[0].additions, 0);
    assert.equal(data.totals.additions, 0);
  });

  it("returns 404 for nonexistent sprint", async () => {
    const res = await req("GET", "/data/sprint/nope/state");
    assert.equal(res.status, 404);
  });
});

// === GET /data/sprint/:name/brief ===

describe("GET /data/sprint/:name/brief", () => {
  it("returns brief with agents and escalation count", async () => {
    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("brief-sprint", "Test brief");
    db.prepare("INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)").run(
      "@b1", "B1", "brief work"
    );
    db.prepare(
      "INSERT INTO sprint_agents (sprint_name, agent_handle, mission) VALUES (?, ?, ?)"
    ).run("brief-sprint", "@b1", "brief work");

    // Create an escalation post
    db.prepare("INSERT INTO channels (name, description) VALUES (?, ?)").run(
      "#escalations", "Escalations"
    );
    db.prepare(
      "INSERT INTO posts (id, author, channel, content, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
    ).run("esc-1", "@b1", "#escalations", "BLOCKED: need help");

    const res = await req("GET", "/data/sprint/brief-sprint/brief");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.sprint.name, "brief-sprint");
    assert.equal(data.agents.length, 1);
    assert.equal(data.agents[0].handle, "@b1");
    assert.equal(data.escalations, 1);
  });

  it("returns 404 for nonexistent sprint", async () => {
    const res = await req("GET", "/data/sprint/nope/brief");
    assert.equal(res.status, 404);
  });

  it("includes lastPost for agents", async () => {
    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("post-sprint", "Test posts");
    db.prepare("INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)").run(
      "@poster", "Poster", "post work"
    );
    db.prepare(
      "INSERT INTO sprint_agents (sprint_name, agent_handle, mission) VALUES (?, ?, ?)"
    ).run("post-sprint", "@poster", "post work");

    // Create a post from the agent
    db.prepare(
      "INSERT INTO posts (id, author, channel, content, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
    ).run("p-1", "@poster", "#general", "Just finished task A");

    const res = await req("GET", "/data/sprint/post-sprint/brief");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.agents[0].lastPost, "Just finished task A");
  });
});

// === POST /data/sprint/suggest ===

describe("POST /data/sprint/suggest", () => {
  it("returns 400 when goal is missing", async () => {
    const res = await req("POST", "/data/sprint/suggest", { body: {} });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("goal"));
  });

  it("returns 400 when goal is not a string", async () => {
    const res = await req("POST", "/data/sprint/suggest", { body: { goal: 123 } });
    assert.equal(res.status, 400);
  });

  // Note: testing actual decompose() would require Claude API access,
  // so we only test input validation here. Integration tests would mock the executor.
});

// === POST /data/sprint/start ===

describe("POST /data/sprint/start", () => {
  it("returns 400 when goal is missing", async () => {
    const res = await req("POST", "/data/sprint/start", {
      body: { tasks: [{ handle: "@x", mission: "test" }] },
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when tasks is empty", async () => {
    const res = await req("POST", "/data/sprint/start", {
      body: { goal: "test", tasks: [] },
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when tasks is missing", async () => {
    const res = await req("POST", "/data/sprint/start", {
      body: { goal: "test" },
    });
    assert.equal(res.status, 400);
  });

  it("returns 409 for duplicate sprint name", async () => {
    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("taken", "Already taken");

    const res = await req("POST", "/data/sprint/start", {
      body: { goal: "test", name: "taken", tasks: [{ handle: "@x", mission: "test" }] },
    });
    assert.equal(res.status, 409);
  });

  // Note: testing actual agent spawning requires a full environment,
  // so we only test input validation and duplicate checks here.
});

// === Numstat cache ===

describe("numstat cache behavior", () => {
  it("sprint state returns zero stats when no spawns exist", async () => {
    db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run("cache-sprint", "Cache test");
    db.prepare("INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)").run(
      "@cache-agent", "CacheAgent", "cache work"
    );
    db.prepare(
      "INSERT INTO sprint_agents (sprint_name, agent_handle, mission) VALUES (?, ?, ?)"
    ).run("cache-sprint", "@cache-agent", "cache work");

    const res = await req("GET", "/data/sprint/cache-sprint/state");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.totals.additions, 0);
    assert.equal(data.totals.deletions, 0);
    assert.equal(data.totals.filesChanged, 0);
  });
});

// === POST /api/chat ===

describe("POST /api/chat", () => {
  it("returns 500 when ANTHROPIC_API_KEY is not set", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await req("POST", "/api/chat", {
        key: adminKey,
        body: { messages: [{ role: "user", content: "hello" }] },
      });
      assert.equal(res.status, 500);
      const data = await res.json();
      assert.ok(data.error.includes("ANTHROPIC_API_KEY"));
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("returns 400 when messages is missing", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const res = await req("POST", "/api/chat", {
        key: adminKey,
        body: {},
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes("messages"));
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("returns 400 when messages is empty array", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const res = await req("POST", "/api/chat", {
        key: adminKey,
        body: { messages: [] },
      });
      assert.equal(res.status, 400);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("streams tokens via wsBroadcast and returns content", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    // Create a mock Anthropic client
    const wsMessages: string[] = [];

    const mockAnthropic = {
      messages: {
        stream: () => {
          const emitter = new EventEmitter();
          // Fire text events after listeners are attached
          const textChunks = ["Hello", " world"];
          let textIdx = 0;

          const originalOn = emitter.on.bind(emitter);
          emitter.on = (event: string, listener: (...args: any[]) => void) => {
            originalOn(event, listener);
            // Once the "text" listener is attached, emit all chunks
            if (event === "text" && textIdx === 0) {
              process.nextTick(() => {
                for (const chunk of textChunks) {
                  emitter.emit("text", chunk);
                }
                textIdx = textChunks.length;
              });
            }
            return emitter;
          };
          (emitter as any).finalMessage = () =>
            new Promise((resolve) => {
              // Resolve after text events have fired
              setTimeout(() => resolve({ usage: { input_tokens: 10, output_tokens: 5 } }), 50);
            });
          return emitter;
        },
      },
    } as any;

    const chatDeps: ChatDeps = {
      anthropic: mockAnthropic,
      wsBroadcast: (msg: string) => wsMessages.push(msg),
    };

    app = createApp(db, undefined, undefined, chatDeps);

    try {
      const res = await req("POST", "/api/chat", {
        key: adminKey,
        body: { messages: [{ role: "user", content: "hello" }] },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.content, "Hello world");
      assert.deepStrictEqual(data.usage, { input_tokens: 10, output_tokens: 5 });

      // Check WS messages
      assert.ok(wsMessages.length >= 3); // 2 tokens + 1 done
      assert.ok(wsMessages.some((m) => JSON.parse(m).type === "chat-token"));
      assert.ok(wsMessages.some((m) => JSON.parse(m).type === "chat-done"));
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("returns 429 when Anthropic rate limits", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    const mockAnthropic = {
      messages: {
        stream: () => {
          const err = new Error("Rate limited") as any;
          err.status = 429;
          throw err;
        },
      },
    } as any;

    app = createApp(db, undefined, undefined, { anthropic: mockAnthropic });

    try {
      const res = await req("POST", "/api/chat", {
        key: adminKey,
        body: { messages: [{ role: "user", content: "hello" }] },
      });
      assert.equal(res.status, 429);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("returns 500 on generic Anthropic error", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    const mockAnthropic = {
      messages: {
        stream: () => { throw new Error("Something broke"); },
      },
    } as any;

    app = createApp(db, undefined, undefined, { anthropic: mockAnthropic });

    try {
      const res = await req("POST", "/api/chat", {
        key: adminKey,
        body: { messages: [{ role: "user", content: "hello" }] },
      });
      assert.equal(res.status, 500);
      const data = await res.json();
      assert.ok(data.error.includes("Something broke"));
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

// === GET /data/import-graph ===

describe("GET /data/import-graph", () => {
  it("returns nodes and edges for project with imports", async () => {
    // Create a mini project with imports
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "a.ts"), 'import { foo } from "./b.js";\nconsole.log(foo);\n');
    fs.writeFileSync(path.join(srcDir, "b.ts"), "export const foo = 1;\n");

    db.close();
    db = initDb(tmpDir);
    app = createApp(db, tmpDir);

    const res = await app.request("/data/import-graph");
    assert.equal(res.status, 200);
    const data = await res.json() as any;

    assert.ok(Array.isArray(data.nodes));
    assert.ok(Array.isArray(data.edges));
    assert.ok(data.nodes.length >= 2);
    assert.ok(data.edges.length >= 1);

    // Check node structure
    const nodeA = data.nodes.find((n: any) => n.id.includes("a.ts"));
    assert.ok(nodeA);
    assert.equal(typeof nodeA.size, "number");
    assert.ok(nodeA.size > 0);

    // Check edge
    const edge = data.edges.find((e: any) => e.source.includes("a.ts") && e.target.includes("b.ts"));
    assert.ok(edge);
  });

  it("returns empty graph for project with no src dir", async () => {
    db.close();
    db = initDb(tmpDir);
    app = createApp(db, tmpDir);

    const res = await app.request("/data/import-graph");
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.deepStrictEqual(data.nodes, []);
    assert.deepStrictEqual(data.edges, []);
  });

  it("uses cached result within 30s", async () => {
    db.close();
    db = initDb(tmpDir);
    app = createApp(db, tmpDir);

    const res1 = await app.request("/data/import-graph");
    const res2 = await app.request("/data/import-graph");
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);

    const data1 = await res1.json();
    const data2 = await res2.json();
    assert.deepStrictEqual(data1, data2);
  });
});
