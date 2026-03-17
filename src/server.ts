import { Hono } from "hono";
import type Database from "better-sqlite3";
import { validateKey, isAdminKey, generateKey, storeKey } from "./auth.js";
import { checkRateLimit } from "./ratelimit.js";
import { createAgent, getAgent, listAgents, updateAgent, normalizeHandle } from "./agents.js";
import { createChannel, getChannel, listChannels } from "./channels.js";
import { createPost, getPost, listPosts, getThread } from "./posts.js";
import { linkCommit } from "./commits.js";
import { getFeed, getBriefing, setChannelPriority, listChannelPriorities } from "./supervision.js";
import { pushBundle, fetchBundle, listDagCommits, getLeaves, getChildren, diffCommits, promoteCommit, dagExists, getDagSummary } from "./gitdag.js";
import { createTeam, getTeam, listTeams, addMember, removeMember, updateTeam } from "./teams.js";
import { createRoute, listRoutes, updateRoute } from "./routes.js";
import { parseNumstat, type NumstatResult, startSprint, uniqueSprintName, type AgentSpec } from "./sprint-orchestrator.js";
import { getSpawn, listSpawns, isProcessAlive, killAgent, mergeAgent, writeDirective } from "./spawner.js";
import { decompose } from "./decomposer.js";
import type { ApiKey, Sprint, SprintAgent } from "./types.js";
import { BoardEventEmitter, inferAllBuckets, inferBucket } from "./bucket-engine.js";
import fs from "fs";
import path from "path";
import os from "os";

// Extend Hono context with auth info
type Variables = {
  apiKey: ApiKey;
};

export function createApp(db: Database.Database, projectDir?: string, emitter?: BoardEventEmitter): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  const resolvedProjectDir = projectDir ?? process.cwd();

  // === Dashboard (no auth — local only) ===

  app.get("/", (c) => {
    return c.redirect("/app/");
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
      if (emitter) {
        emitter.emit("post_created", { author, channel: body.channel, content: body.content });
      }
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
      const member = addMember(db, c.req.param("name"), body.agent_handle);
      return c.json(member, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.delete("/api/teams/:name/members/:handle", (c) => {
    if (!requireAdmin(c)) return c.body(null);
    try {
      removeMember(db, c.req.param("name"), c.req.param("handle"));
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
      const team = updateTeam(db, c.req.param("name"), { status: body.status });
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
      const route = updateRoute(db, c.req.param("id"), { status: body.status });
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

  // === Numstat cache (invalidated on bucket_changed / spawn_stopped) ===

  const numstatCache = new Map<string, NumstatResult>();

  function invalidateNumstatCache(branch?: string) {
    if (branch) {
      numstatCache.delete(branch);
    } else {
      numstatCache.clear();
    }
  }

  function getCachedNumstat(branch: string): NumstatResult | null {
    const cached = numstatCache.get(branch);
    if (cached) return cached;
    const result = parseNumstat(resolvedProjectDir, branch);
    if (result) numstatCache.set(branch, result);
    return result;
  }

  // === Helper: build SprintState for frontend ===

  function buildSprintState(sprintName: string) {
    const sprint = db.prepare("SELECT * FROM sprints WHERE name = ?").get(sprintName) as Sprint | undefined;
    if (!sprint) return null;

    const sprintAgents = db.prepare("SELECT * FROM sprint_agents WHERE sprint_name = ?").all(sprintName) as SprintAgent[];
    const buckets = inferAllBuckets({ db, sprintName });
    const spawns = listSpawns(db);

    const agents = sprintAgents.map((sa) => {
      const spawn = spawns.find((s) => s.agent_handle === sa.agent_handle);
      const alive = spawn && !spawn.stopped_at ? isProcessAlive(spawn.pid) : false;
      const stats = spawn?.branch ? getCachedNumstat(spawn.branch) : null;

      const lastPost = db.prepare(
        "SELECT content FROM posts WHERE author = ? ORDER BY created_at DESC LIMIT 1"
      ).get(sa.agent_handle) as { content: string } | undefined;

      return {
        handle: sa.agent_handle,
        bucket: buckets.get(sa.agent_handle) ?? "planning",
        identity: sa.identity_name,
        mission: sa.mission ?? "",
        branch: spawn?.branch ?? null,
        alive,
        stopped: spawn ? !!spawn.stopped_at || !alive : true,
        exitCode: spawn?.exit_code ?? null,
        additions: stats?.additions ?? 0,
        deletions: stats?.deletions ?? 0,
        filesChanged: stats?.filesChanged ?? 0,
        lastPost: lastPost?.content ?? null,
      };
    });

    const totals = agents.reduce(
      (acc, a) => ({
        additions: acc.additions + a.additions,
        deletions: acc.deletions + a.deletions,
        filesChanged: acc.filesChanged + a.filesChanged,
      }),
      { additions: 0, deletions: 0, filesChanged: 0 }
    );

    return {
      name: sprint.name,
      goal: sprint.goal,
      createdAt: sprint.created_at,
      sprint,
      agents,
      totals,
    };
  }

  // === Sprint data (kanban frontend) ===

  app.get("/data/sprint/latest", (c) => {
    const row = db.prepare(
      "SELECT * FROM sprints WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
    ).get() as Sprint | undefined;
    if (!row) {
      return c.json(null);
    }
    return c.json(buildSprintState(row.name));
  });

  app.get("/data/sprint/:name{[^/]+}", (c) => {
    const name = c.req.param("name");
    if (name === "latest") return c.json(null);
    const state = buildSprintState(name);
    if (!state) return c.json({ error: "Sprint not found" }, 404);
    return c.json(state);
  });

  app.get("/data/sprint/:name/buckets", (c) => {
    const sprintName = c.req.param("name");
    const buckets = inferAllBuckets({ db, sprintName });
    const result: Record<string, string> = {};
    for (const [handle, bucket] of buckets) {
      result[handle] = bucket;
    }
    return c.json(result);
  });

  // === GET /data/sprint/:name/state — full sprint state with diff stats ===

  app.get("/data/sprint/:name/state", (c) => {
    const state = buildSprintState(c.req.param("name"));
    if (!state) return c.json({ error: "Sprint not found" }, 404);
    return c.json(state);
  });

  // === GET /data/logs/:handle — read last N lines of agent log ===

  app.get("/data/logs/:handle", (c) => {
    const handle = c.req.param("handle");
    const lines = parseInt(c.req.query("lines") ?? "50", 10);
    const spawn = getSpawn(db, handle);
    if (!spawn || !spawn.log_path) {
      return c.json({ error: "No spawn or log file found" }, 404);
    }

    try {
      const content = fs.readFileSync(spawn.log_path, "utf-8");
      const allLines = content.split("\n");
      const lastLines = allLines.slice(-lines).join("\n");
      return c.json({ handle, log: lastLines });
    } catch {
      return c.json({ error: "Log file not found" }, 404);
    }
  });

  // === GET /data/sprint/:name/brief — landing brief for a sprint ===

  app.get("/data/sprint/:name/brief", (c) => {
    const sprintName = c.req.param("name");
    const sprint = db.prepare("SELECT * FROM sprints WHERE name = ?").get(sprintName) as Sprint | undefined;
    if (!sprint) return c.json({ error: "Sprint not found" }, 404);

    const sprintAgents = db.prepare("SELECT * FROM sprint_agents WHERE sprint_name = ?").all(sprintName) as SprintAgent[];
    const spawns = listSpawns(db);

    const agents = sprintAgents.map((sa) => {
      const spawn = spawns.find((s) => s.agent_handle === sa.agent_handle);
      const alive = spawn && !spawn.stopped_at ? isProcessAlive(spawn.pid) : false;
      const stats = spawn?.branch ? getCachedNumstat(spawn.branch) : null;

      const lastPost = db.prepare(
        "SELECT content FROM posts WHERE author = ? ORDER BY created_at DESC LIMIT 1"
      ).get(sa.agent_handle) as { content: string } | undefined;

      return {
        handle: sa.agent_handle,
        identity: sa.identity_name,
        mission: sa.mission,
        branch: spawn?.branch || null,
        alive,
        stopped: spawn ? !!spawn.stopped_at || !alive : true,
        exitCode: spawn?.exit_code ?? null,
        additions: stats?.additions ?? 0,
        deletions: stats?.deletions ?? 0,
        filesChanged: stats?.filesChanged ?? 0,
        lastPost: lastPost?.content || null,
      };
    });

    const escalationCount = (db.prepare(
      "SELECT COUNT(*) as count FROM posts WHERE channel = '#escalations' AND created_at >= ?"
    ).get(sprint.created_at) as { count: number }).count;

    return c.json({
      sprint,
      agents,
      escalations: escalationCount,
    });
  });

  // Actions: kill, steer, merge
  app.post("/data/sprint/:name/kill/:handle", (c) => {
    const handle = c.req.param("handle").startsWith("@") ? c.req.param("handle") : `@${c.req.param("handle")}`;
    try {
      killAgent(db, handle, resolvedProjectDir);
      if (emitter) {
        emitter.emit("spawn_stopped", { agent_handle: handle, exit_code: null });
      }
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.post("/data/sprint/:name/steer/:handle", async (c) => {
    const handle = c.req.param("handle").startsWith("@") ? c.req.param("handle") : `@${c.req.param("handle")}`;
    const body = await c.req.json();
    if (!body.directive) {
      return c.json({ error: "directive is required" }, 400);
    }
    try {
      writeDirective(resolvedProjectDir, handle, body.directive);
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.post("/data/sprint/:name/merge", async (c) => {
    const sprintName = c.req.param("name");
    const agents = db
      .prepare("SELECT agent_handle FROM sprint_agents WHERE sprint_name = ?")
      .all(sprintName) as { agent_handle: string }[];

    const results: { handle: string; success: boolean; error?: string }[] = [];
    for (const { agent_handle } of agents) {
      const bucket = inferBucket({ db, agentHandle: agent_handle });
      if (bucket !== "review" && bucket !== "done") continue;
      if (bucket === "done") continue;
      try {
        mergeAgent(db, agent_handle, resolvedProjectDir, { cleanup: true });
        results.push({ handle: agent_handle, success: true });
      } catch (e: any) {
        results.push({ handle: agent_handle, success: false, error: e.message });
      }
    }

    const remaining = inferAllBuckets({ db, sprintName });
    const allDone = [...remaining.values()].every((b) => b === "done");
    if (allDone) {
      db.prepare("UPDATE sprints SET status = 'finished', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE name = ?").run(sprintName);
    }

    return c.json({ results, allDone });
  });

  app.get("/data/spawns", (c) => {
    const spawns = listSpawns(db);
    return c.json(spawns);
  });

  // === POST /data/sprint/suggest — decompose a goal into agent tasks ===

  app.post("/data/sprint/suggest", async (c) => {
    const body = await c.req.json();
    if (!body.goal || typeof body.goal !== "string") {
      return c.json({ error: "goal (string) is required" }, 400);
    }
    try {
      const result = await decompose(body.goal, resolvedProjectDir);
      return c.json(result);
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // === POST /data/sprint/start — start a sprint with agents ===

  app.post("/data/sprint/start", async (c) => {
    const body = await c.req.json();
    if (!body.goal || !Array.isArray(body.tasks) || body.tasks.length === 0) {
      return c.json({ error: "goal and non-empty tasks array are required" }, 400);
    }

    const sprintName = body.name || uniqueSprintName(body.goal, db);
    const serverUrl = process.env.BOARD_URL || "http://localhost:3141";
    const spawnedAgents: { handle: string; pid: number; branch: string }[] = [];

    try {
      await startSprint({
        name: sprintName,
        goal: body.goal,
        specs: body.tasks,
        projectDir: resolvedProjectDir,
        serverUrl,
        db,
        onSpawn: (handle, pid, branch) => {
          spawnedAgents.push({ handle, pid, branch });
        },
      });
      return c.json({ sprintName, agents: spawnedAgents }, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, e.message.includes("already exists") ? 409 : 500);
    }
  });

  // === Static frontend serving ===

  app.get("/app/*", (c) => {
    const reqPath = c.req.path.replace(/^\/app/, "");
    const frontendDist = path.join(resolvedProjectDir, "frontend", "dist");

    let filePath = path.join(frontendDist, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(frontendDist, "index.html");
    }

    if (!fs.existsSync(filePath)) {
      return c.text("Frontend not built. Run: cd frontend && npm run build", 404);
    }

    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
    };
    c.header("Content-Type", mimeTypes[ext] || "application/octet-stream");
    return c.body(content);
  });

  return app;
}

// === WebSocket log streaming types ===

interface LogSubscription {
  handle: string;
  logPath: string;
  watcher: fs.FSWatcher;
  offset: number;
}

interface WsClient {
  ws: WebSocket;
  subscriptions: Map<string, LogSubscription>;
}

/**
 * Attach WebSocket log streaming to a Node.js HTTP server.
 * Call this after creating the HTTP server (e.g., from @hono/node-server).
 *
 * Clients send JSON messages:
 *   { subscribe_logs: "@handle" }   — start streaming log lines
 *   { unsubscribe_logs: "@handle" } — stop streaming
 *
 * Server sends:
 *   { type: "log_line", handle: "@handle", line: "..." }
 */
export function attachLogStreaming(
  server: import("http").Server,
  db: import("better-sqlite3").Database,
): void {
  const { WebSocketServer } = require("ws") as typeof import("ws");
  const wss = new WebSocketServer({ server });
  const clients = new Set<WsClient>();

  wss.on("connection", (ws: WebSocket) => {
    const client: WsClient = { ws, subscriptions: new Map() };
    clients.add(client);

    ws.addEventListener("message", (event: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      } catch {
        return; // Ignore malformed messages
      }

      if (msg.subscribe_logs) {
        const handle = msg.subscribe_logs;
        // Don't double-subscribe
        if (client.subscriptions.has(handle)) return;

        const spawn = getSpawn(db, handle);
        if (!spawn?.log_path || !fs.existsSync(spawn.log_path)) return;

        const logPath = spawn.log_path;
        // Start from end of file
        let offset = 0;
        try {
          const stat = fs.statSync(logPath);
          offset = stat.size;
        } catch { /* start from 0 */ }

        const watcher = fs.watch(logPath, () => {
          try {
            const stat = fs.statSync(logPath);
            if (stat.size <= offset) return;

            const fd = fs.openSync(logPath, "r");
            const buf = Buffer.alloc(stat.size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            offset = stat.size;

            const newContent = buf.toString("utf-8");
            for (const line of newContent.split("\n")) {
              if (line) {
                ws.send(JSON.stringify({ type: "log_line", handle, line }));
              }
            }
          } catch {
            // File may have been rotated or deleted
          }
        });

        client.subscriptions.set(handle, { handle, logPath, watcher, offset });
      }

      if (msg.unsubscribe_logs) {
        const sub = client.subscriptions.get(msg.unsubscribe_logs);
        if (sub) {
          sub.watcher.close();
          client.subscriptions.delete(msg.unsubscribe_logs);
        }
      }
    });

    ws.addEventListener("close", () => {
      client.subscriptions.forEach((sub) => {
        sub.watcher.close();
      });
      client.subscriptions.clear();
      clients.delete(client);
    });
  });
}
