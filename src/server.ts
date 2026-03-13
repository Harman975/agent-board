import { Hono } from "hono";
import type Database from "better-sqlite3";
import { validateKey, isAdminKey, generateKey, storeKey } from "./auth.js";
import { checkRateLimit } from "./ratelimit.js";
import { createAgent, getAgent, listAgents, updateAgent } from "./agents.js";
import { createChannel, getChannel, listChannels } from "./channels.js";
import { createPost, getPost, listPosts, getThread } from "./posts.js";
import { linkCommit } from "./commits.js";
import { getFeed, getBriefing, setChannelPriority, listChannelPriorities } from "./supervision.js";
import { pushBundle, fetchBundle, listDagCommits, getLeaves, getChildren, diffCommits, promoteCommit, dagExists, getDagSummary } from "./gitdag.js";
import { createTeam, getTeam, listTeams, addTeamMember, removeTeamMember, updateTeamStatus } from "./teams.js";
import { createRoute, listRoutes, updateRouteStatus } from "./routes.js";
import type { ApiKey } from "./types.js";
import { dashboardHtml } from "./dashboard.js";
import fs from "fs";
import path from "path";
import os from "os";

// Extend Hono context with auth info
type Variables = {
  apiKey: ApiKey;
};

export function createApp(db: Database.Database, projectDir?: string): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  const resolvedProjectDir = projectDir ?? process.cwd();

  // === Dashboard (no auth — local only) ===

  app.get("/", (c) => {
    return c.html(dashboardHtml());
  });

  app.get("/data/feed", (c) => {
    const feed = getFeed(db, {
      channel: c.req.query("channel") || undefined,
      since: c.req.query("since") || undefined,
      limit: c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 50,
    });
    return c.json(feed);
  });

  app.get("/data/agents", (c) => {
    const agents = listAgents(db, {});
    return c.json(agents);
  });

  app.get("/data/channels", (c) => {
    const channels = listChannels(db);
    const priorities = listChannelPriorities(db);
    const priorityMap = new Map(priorities.map((p) => [p.channel_name, p.priority]));
    return c.json(channels.map((ch) => ({ ...ch, priority: priorityMap.get(ch.name) ?? 0 })));
  });

  app.get("/data/posts/:id/thread", (c) => {
    const thread = getThread(db, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    return c.json(thread);
  });

  // === Auth middleware ===
  app.use("/api/*", async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const rawKey = authHeader.slice(7);
    const apiKey = validateKey(db, rawKey);
    if (!apiKey) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    c.set("apiKey", apiKey);
    await next();
  });

  // Helper: require admin key
  function requireAdmin(c: any): boolean {
    const apiKey = c.get("apiKey");
    if (!isAdminKey(apiKey)) {
      c.status(403);
      c.json({ error: "Admin key required" });
      return false;
    }
    return true;
  }

  // === Agent routes (foundation) ===

  app.post("/api/agents", async (c) => {
    if (!requireAdmin(c)) return c.body(null);
    const body = await c.req.json();
    if (!body.handle || !body.mission) {
      return c.json({ error: "handle and mission are required" }, 400);
    }
    try {
      const agent = createAgent(db, {
        handle: body.handle,
        name: body.name ?? body.handle.replace(/^@/, ""),
        role: body.role,
        mission: body.mission,
        metadata: body.metadata,
      });
      // Generate API key for this agent
      const rawKey = generateKey();
      storeKey(db, rawKey, agent.handle);
      return c.json({ ...agent, api_key: rawKey }, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 409);
    }
  });

  app.get("/api/agents", (c) => {
    const status = c.req.query("status");
    const agents = listAgents(db, { status: status as any });
    return c.json(agents);
  });

  app.get("/api/agents/:handle", (c) => {
    const agent = getAgent(db, c.req.param("handle"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(agent);
  });

  app.patch("/api/agents/:handle", async (c) => {
    if (!requireAdmin(c)) return c.body(null);
    const body = await c.req.json();
    const agent = updateAgent(db, c.req.param("handle"), body);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(agent);
  });

  // === Channel routes (foundation) ===

  app.post("/api/channels", async (c) => {
    if (!requireAdmin(c)) return c.body(null);
    const body = await c.req.json();
    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }
    try {
      const channel = createChannel(db, {
        name: body.name,
        description: body.description,
      });
      return c.json(channel, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 409);
    }
  });

  app.get("/api/channels", (c) => {
    const channels = listChannels(db);
    // Attach priorities from supervision layer for display
    const priorities = listChannelPriorities(db);
    const priorityMap = new Map(priorities.map((p) => [p.channel_name, p.priority]));
    const result = channels.map((ch) => ({
      ...ch,
      priority: priorityMap.get(ch.name) ?? 0,
    }));
    return c.json(result);
  });

  // === Post routes (foundation) ===

  app.post("/api/posts", async (c) => {
    const apiKey = c.get("apiKey");
    // Must be an agent key (not admin) OR admin key (for @admin posting)
    const authorHandle = apiKey.agent_handle;

    const body = await c.req.json();
    if (!body.content || !body.channel) {
      return c.json({ error: "content and channel are required" }, 400);
    }

    // Determine author: use key's agent_handle, or body.author for admin
    let author: string;
    if (isAdminKey(apiKey)) {
      author = body.author ?? "@admin";
    } else {
      author = authorHandle!;
    }

    // Rate limit check (skip for admin)
    if (!isAdminKey(apiKey)) {
      const rl = checkRateLimit(author, "posts");
      if (!rl.allowed) {
        c.header("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
        return c.json({ error: "Rate limit exceeded" }, 429);
      }
    }

    try {
      const post = createPost(db, {
        author,
        channel: body.channel,
        content: body.content,
        parent_id: body.parent_id,
        metadata: body.metadata,
      });
      return c.json(post, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.get("/api/posts", (c) => {
    const posts = listPosts(db, {
      author: c.req.query("author"),
      channel: c.req.query("channel"),
      since: c.req.query("since"),
      limit: c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined,
      parent_id: c.req.query("top_level") === "true" ? null : undefined,
    });
    return c.json(posts);
  });

  app.get("/api/posts/:id", (c) => {
    const post = getPost(db, c.req.param("id"));
    if (!post) return c.json({ error: "Post not found" }, 404);
    return c.json(post);
  });

  app.get("/api/posts/:id/thread", (c) => {
    const thread = getThread(db, c.req.param("id"));
    if (!thread) return c.json({ error: "Post not found" }, 404);
    return c.json(thread);
  });

  // === Commit routes (foundation) ===

  app.post("/api/commits", async (c) => {
    const apiKey = c.get("apiKey");

    if (!isAdminKey(apiKey)) {
      const rl = checkRateLimit(apiKey.agent_handle!, "commits");
      if (!rl.allowed) {
        c.header("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
        return c.json({ error: "Rate limit exceeded" }, 429);
      }
    }

    const body = await c.req.json();
    if (!body.hash || !body.post_id) {
      return c.json({ error: "hash and post_id are required" }, 400);
    }
    try {
      const commit = linkCommit(db, {
        hash: body.hash,
        post_id: body.post_id,
        files: body.files,
      });
      return c.json(commit, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // === Supervision routes ===

  app.get("/api/feed", (c) => {
    const feed = getFeed(db, {
      channel: c.req.query("channel"),
      since: c.req.query("since"),
      author: c.req.query("author"),
      limit: c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined,
    });
    return c.json(feed);
  });

  app.get("/api/briefing", (c) => {
    if (!requireAdmin(c)) return c.body(null);
    const briefing = getBriefing(db);
    return c.json(briefing);
  });

  // Channel priority (supervision config)
  app.put("/api/channels/:name/priority", async (c) => {
    if (!requireAdmin(c)) return c.body(null);
    const body = await c.req.json();
    if (typeof body.priority !== "number") {
      return c.json({ error: "priority (number) is required" }, 400);
    }
    try {
      setChannelPriority(db, c.req.param("name"), body.priority);
      return c.json({ channel: c.req.param("name"), priority: body.priority });
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
    }
  });

  // === Git DAG routes ===

  // Push a bundle to the DAG
  app.post("/api/git/push", async (c) => {
    const apiKey = c.get("apiKey");
    const agentHandle = apiKey.agent_handle;
    if (!agentHandle && !isAdminKey(apiKey)) {
      return c.json({ error: "Agent key or admin key required" }, 403);
    }

    // Accept multipart form data with bundle file + message
    const formData = await c.req.formData();
    const bundleFile = formData.get("bundle") as File | null;
    const message = formData.get("message") as string | null;
    const author = isAdminKey(apiKey)
      ? (formData.get("author") as string | null) ?? "@admin"
      : agentHandle!;

    if (!bundleFile) {
      return c.json({ error: "bundle file is required" }, 400);
    }
    if (!message) {
      return c.json({ error: "message is required" }, 400);
    }

    // Write bundle to temp file
    const tmpDir = os.tmpdir();
    const tmpPath = path.join(tmpDir, `dag-bundle-${Date.now()}.bundle`);
    try {
      const arrayBuf = await bundleFile.arrayBuffer();
      fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));

      const result = pushBundle(db, resolvedProjectDir, author, tmpPath, message);

      // Auto-post to #work
      try {
        // Ensure #work channel exists
        if (!getChannel(db, "#work")) {
          createChannel(db, { name: "work", description: "Agent work updates" });
        }
        createPost(db, {
          author,
          channel: "#work",
          content: `Pushed commit ${result.hash.slice(0, 8)}: ${message}`,
          metadata: { dag_hash: result.hash, type: "dag_push" },
        });
      } catch {
        // Auto-post is best-effort
      }

      return c.json(result, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });

  // Fetch a bundle for a specific commit
  app.get("/api/git/fetch/:hash", (c) => {
    const hash = c.req.param("hash");
    const tmpPath = path.join(os.tmpdir(), `dag-fetch-${Date.now()}.bundle`);
    try {
      fetchBundle(resolvedProjectDir, hash, tmpPath);
      const data = fs.readFileSync(tmpPath);
      c.header("Content-Type", "application/octet-stream");
      c.header("Content-Disposition", `attachment; filename="${hash.slice(0, 8)}.bundle"`);
      return c.body(data);
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });

  // List DAG commits
  app.get("/api/git/commits", (c) => {
    const commits = listDagCommits(db, {
      agentHandle: c.req.query("agent") || undefined,
      since: c.req.query("since") || undefined,
      limit: c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 50,
    });
    return c.json(commits);
  });

  // Get leaves (active frontiers)
  app.get("/api/git/leaves", (c) => {
    const leaves = getLeaves(db, {
      agentHandle: c.req.query("agent") || undefined,
    });
    return c.json(leaves);
  });

  // Get children of a commit
  app.get("/api/git/commits/:hash/children", (c) => {
    const children = getChildren(db, c.req.param("hash"));
    return c.json(children);
  });

  // Diff two commits
  app.get("/api/git/diff/:a/:b", (c) => {
    try {
      const diff = diffCommits(resolvedProjectDir, c.req.param("a"), c.req.param("b"));
      return c.text(diff);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // Promote a commit to main (admin only)
  app.post("/api/git/promote", async (c) => {
    if (!requireAdmin(c)) return c.body(null);
    const body = await c.req.json();
    if (!body.hash) {
      return c.json({ error: "hash is required" }, 400);
    }
    try {
      const result = promoteCommit(resolvedProjectDir, body.hash);

      // Audit post
      try {
        if (!getChannel(db, "#work")) {
          createChannel(db, { name: "work", description: "Agent work updates" });
        }
        createPost(db, {
          author: "@admin",
          channel: "#work",
          content: `Promoted ${result.originalHash.slice(0, 8)} → main as ${result.newHash.slice(0, 8)}: ${result.message}`,
          metadata: { type: "dag_promote", original_hash: result.originalHash, new_hash: result.newHash },
        });
      } catch {
        // Audit post is best-effort
      }

      return c.json(result);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // === Team routes (M2) ===

  app.post("/api/teams", async (c) => {
    if (!requireAdmin(c)) return c.body(null);
    const body = await c.req.json();
    if (!body.name || !body.mission || !body.manager) {
      return c.json({ error: "name, mission, and manager are required" }, 400);
    }
    try {
      const team = createTeam(db, {
        name: body.name,
        mission: body.mission,
        manager: body.manager,
      });
      return c.json(team, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 409);
    }
  });

  app.get("/api/teams", (c) => {
    const teams = listTeams(db);
    return c.json(teams);
  });

  app.get("/api/teams/:name", (c) => {
    const team = getTeam(db, c.req.param("name"));
    if (!team) return c.json({ error: "Team not found" }, 404);
    return c.json(team);
  });

  app.post("/api/teams/:name/members", async (c) => {
    if (!requireAdmin(c)) return c.body(null);
    const body = await c.req.json();
    if (!body.agent_handle) {
      return c.json({ error: "agent_handle is required" }, 400);
    }
    try {
      const member = addTeamMember(db, c.req.param("name"), body.agent_handle);
      return c.json(member, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.delete("/api/teams/:name/members/:handle", (c) => {
    if (!requireAdmin(c)) return c.body(null);
    try {
      removeTeamMember(db, c.req.param("name"), c.req.param("handle"));
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
    }
  });

  app.patch("/api/teams/:name", async (c) => {
    if (!requireAdmin(c)) return c.body(null);
    const body = await c.req.json();
    if (!body.status) {
      return c.json({ error: "status is required" }, 400);
    }
    try {
      const team = updateTeamStatus(db, c.req.param("name"), body.status);
      if (!team) return c.json({ error: "Team not found" }, 404);
      return c.json(team);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // === Route routes (M2) ===

  app.post("/api/routes", async (c) => {
    const body = await c.req.json();
    if (!body.team_name || !body.agent_handle || !body.name) {
      return c.json({ error: "team_name, agent_handle, and name are required" }, 400);
    }
    try {
      const route = createRoute(db, {
        team_name: body.team_name,
        agent_handle: body.agent_handle,
        name: body.name,
      });
      return c.json(route, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.get("/api/routes", (c) => {
    const routes = listRoutes(db, {
      team_name: c.req.query("team") || undefined,
    });
    return c.json(routes);
  });

  app.patch("/api/routes/:id", async (c) => {
    const body = await c.req.json();
    if (!body.status) {
      return c.json({ error: "status is required" }, 400);
    }
    try {
      const route = updateRouteStatus(db, c.req.param("id"), body.status);
      if (!route) return c.json({ error: "Route not found" }, 404);
      return c.json(route);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // DAG summary for dashboard
  app.get("/data/dag", (c) => {
    if (!dagExists(resolvedProjectDir)) {
      return c.json({ totalCommits: 0, leafCount: 0, agentActivity: [], recentLeaves: [] });
    }
    const summary = getDagSummary(db, c.req.query("since") || undefined);
    return c.json(summary);
  });

  return app;
}
