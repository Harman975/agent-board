import { Command } from "commander";
import fs from "fs";
import path from "path";
import { initDb, dbExists, initBoard } from "./db.js";
import { normalizeHandle } from "./agents.js";
import { generateKey, hashKey } from "./auth.js";
import { parseDuration } from "./supervision.js";
import { readBoardRC, writeBoardRC, api, ApiError, type BoardRC } from "./boardrc.js";
import {
  c,
  renderAgent,
  renderAgentList,
  renderFeed,
  renderProfile,
  renderThread,
  renderBriefing,
  renderChannelList,
  renderSpawnList,
  renderStatus,
  renderDagLog,
  renderDagTree,
  renderDagSummary,
  renderPromoteSummary,
  renderTeam,
  renderTeamList,
  renderRoute,
  renderRouteList,
  renderOrg,
  renderSprintReport,
  renderSprintList,
  renderLandingBrief,
  renderAgentInspect,
  renderPortfolio,
  renderAlerts,
  renderResearchHistory,
  renderRetro,
  renderRetroMarkdown,
  formatDuration,
  type SpawnInfo,
  type ResearchSession,
  type RetroAgent,
  type RetroData,
} from "./render.js";
import type { Agent, DagCommit, Post, RankedPost, Team, TeamMember, Route, SprintValidation, SprintBranch, Sprint, SprintAgent, SprintReport, SprintAgentReport, Alert } from "./types.js";
import type { BriefingSummary } from "./supervision.js";
import type { PostThread } from "./posts.js";
import type { DagSummary, PromoteResult } from "./gitdag.js";
import { execSync, spawn as nodeSpawn } from "child_process";
import { runPreFlight, buildSprintReport, buildLandingBrief, SPRINT_REPORT_PROTOCOL, mergeWithTestGates, startSprint, type AgentSpec, slugify, uniqueSprintName, validateDisjointScopes } from "./sprint-orchestrator.js";

// === Error classes ===

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function die(message: string): never {
  throw new CliError(message);
}

function requireRC(): BoardRC {
  const rc = readBoardRC();
  if (!rc) die("No .boardrc found. Run `board init` first.");
  return rc;
}

// === CLI ===

const program = new Command();

program
  .name("board")
  .description("AgentBoard — a feed for supervising AI agents")
  .version("0.2.0");

// --- board init ---
program
  .command("init")
  .description("Initialize a new board: creates DB, @admin agent, admin key, .boardrc")
  .option("--port <port>", "Server port for .boardrc", "3141")
  .action(async (opts: { port: string }) => {
    if (dbExists()) {
      console.log("Board already initialized.");
      return;
    }

    const { adminKey } = initBoard();

    // Write .boardrc
    const serverUrl = `http://localhost:${opts.port}`;
    writeBoardRC({ url: serverUrl, key: adminKey });

    // Auto-start the server in the background
    const serverChild = nodeSpawn(process.argv[0], [process.argv[1], "serve", "--port", opts.port], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
    });
    serverChild.unref();

    console.log("Board initialized.");
    console.log(`Admin key: ${adminKey}`);
    console.log("Saved to .boardrc — keep this file secure.");
    console.log("DAG initialized at .dag/");
    console.log(`\nServer started in background (PID ${serverChild.pid}) on ${serverUrl}`);
    console.log("\nNext steps:");
    console.log("  board status          — check system overview");
    console.log("  board agent create    — create an agent");
    console.log("  board spawn <handle>  — spawn an agent subprocess");
    console.log("  board feed            — view the activity feed");
    console.log("  board watch           — live-updating feed");
  });

// --- board serve ---
program
  .command("serve")
  .description("Start the AgentBoard HTTP server")
  .option("--port <port>", "Port to listen on", process.env.BOARD_PORT ?? "3141")
  .action(async (opts: { port: string }) => {
    // Dynamic import to avoid loading Hono unless serving
    const { serve } = await import("@hono/node-server");
    const { createApp } = await import("./server.js");
    const { getDb } = await import("./db.js");
    const { BoardEventEmitter } = await import("./bucket-engine.js");

    if (!dbExists()) {
      die("No board found. Run `board init` first.");
    }

    const db = getDb();
    const emitter = new BoardEventEmitter();
    const app = createApp(db, process.cwd(), emitter);
    const port = parseInt(opts.port, 10);

    const server = serve({ fetch: app.fetch, port }, () => {
      console.log(`AgentBoard server listening on http://localhost:${port}`);
      console.log(`Kanban UI: http://localhost:${port}/app/`);
    });

    // WebSocket support
    try {
      const { WebSocketServer } = await import("ws");
      const { inferAllBuckets } = await import("./bucket-engine.js");
      const { listSpawns: listSpawnsFn, isProcessAlive: isProcAlive } = await import("./spawner.js");
      const wss = new WebSocketServer({ server: server as any });

      // Send initial sprint state to new connections
      wss.on("connection", (ws) => {
        // Send initial state
        try {
          const row = db.prepare(
            "SELECT * FROM sprints WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
          ).get() as any;
          if (row) {
            const sprintAgents = db.prepare(
              "SELECT * FROM sprint_agents WHERE sprint_name = ?"
            ).all(row.name) as any[];
            const buckets = inferAllBuckets({ db, sprintName: row.name });
            const spawns = listSpawnsFn(db);

            const agents = sprintAgents.map((sa: any) => {
              const spawn = spawns.find((s: any) => s.agent_handle === sa.agent_handle);
              const alive = spawn && !spawn.stopped_at ? isProcAlive(spawn.pid) : false;
              const lastPost = db.prepare(
                "SELECT content FROM posts WHERE author = ? ORDER BY created_at DESC LIMIT 1"
              ).get(sa.agent_handle) as { content: string } | undefined;
              return {
                handle: sa.agent_handle,
                bucket: buckets.get(sa.agent_handle) ?? "planning",
                mission: sa.mission ?? "",
                branch: spawn?.branch ?? null,
                lastPost: lastPost?.content ?? null,
                additions: 0,
                deletions: 0,
                filesChanged: 0,
                alive,
                exitCode: spawn?.exit_code ?? null,
              };
            });

            ws.send(JSON.stringify({
              type: "initial_state",
              data: { name: row.name, goal: row.goal, createdAt: row.created_at, agents },
            }));
          }
        } catch { /* best effort */ }

        const onPost = (data: any) => {
          ws.send(JSON.stringify({ type: "post_created", data }));
        };
        const onBucket = (data: any) => {
          ws.send(JSON.stringify({ type: "bucket_changed", data }));
        };
        const onSpawn = (data: any) => {
          ws.send(JSON.stringify({ type: "spawn_stopped", data }));
        };
        emitter.on("post_created", onPost);
        emitter.on("bucket_changed", onBucket);
        emitter.on("spawn_stopped", onSpawn);
        ws.on("close", () => {
          emitter.removeListener("post_created", onPost);
          emitter.removeListener("bucket_changed", onBucket);
          emitter.removeListener("spawn_stopped", onSpawn);
        });
      });

      // Bucket polling — re-infer every 5s and broadcast changes
      type BucketState = "planning" | "in_progress" | "blocked" | "review" | "done";
      const bucketCache = new Map<string, BucketState>();
      setInterval(() => {
        try {
          const row = db.prepare(
            "SELECT name FROM sprints WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
          ).get() as { name: string } | undefined;
          if (!row) return;
          const buckets = inferAllBuckets({ db, sprintName: row.name });
          for (const [handle, bucket] of buckets) {
            const prev = bucketCache.get(handle);
            if (prev && prev !== bucket) {
              emitter.emit("bucket_changed", { agent_handle: handle, from: prev, to: bucket });
              // Broadcast to all clients
              const msg = JSON.stringify({ type: "bucket_changed", data: { handle, bucket } });
              for (const client of wss.clients) {
                if (client.readyState === 1) client.send(msg);
              }
            }
            bucketCache.set(handle, bucket);
          }
        } catch { /* polling is best-effort */ }
      }, 5000);
    } catch {
      console.log("(WebSocket support unavailable — install 'ws' package for live updates)");
    }

    // Graceful shutdown
    const shutdown = () => {
      console.log("\nShutting down...");
      db.close();
      server.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// --- board agent ---
const agent = program.command("agent").description("Manage agents");

agent
  .command("create <handle>")
  .description("Create a new agent")
  .requiredOption("--mission <mission>", "Agent mission")
  .option("--name <name>", "Agent display name")
  .option("--role <role>", "Agent role (manager, worker, solo)", "solo")
  .action(async (handle: string, opts: { mission: string; name?: string; role?: string }) => {
    const rc = requireRC();
    const agent = await api<Agent & { api_key: string }>(rc, "POST", "/api/agents", {
      handle,
      name: opts.name,
      role: opts.role,
      mission: opts.mission,
    });
    console.log(`Created agent ${agent.handle}`);
    console.log(`API key: ${agent.api_key}`);
    console.log(renderAgent(agent));
  });

agent
  .command("list")
  .description("List all agents")
  .option("--status <status>", "Filter by status")
  .action(async (opts: { status?: string }) => {
    const rc = requireRC();
    const qs = opts.status ? `?status=${opts.status}` : "";
    const agents = await api<Agent[]>(rc, "GET", `/api/agents${qs}`);
    console.log(renderAgentList(agents));
  });

agent
  .command("show <handle>")
  .description("Show agent details")
  .action(async (handle: string) => {
    const rc = requireRC();
    const h = normalizeHandle(handle);
    const agent = await api<Agent>(rc, "GET", `/api/agents/${encodeURIComponent(h)}`);
    console.log(renderAgent(agent));
  });

agent
  .command("update <handle>")
  .description("Update an agent")
  .option("--name <name>", "New name")
  .option("--mission <mission>", "New mission")
  .option("--status <status>", "New status")
  .action(async (handle: string, opts: { name?: string; mission?: string; status?: string }) => {
    const rc = requireRC();
    const h = normalizeHandle(handle);
    const body: Record<string, string> = {};
    if (opts.name) body.name = opts.name;
    if (opts.mission) body.mission = opts.mission;
    if (opts.status) body.status = opts.status;
    const agent = await api<Agent>(rc, "PATCH", `/api/agents/${encodeURIComponent(h)}`, body);
    console.log(`Updated ${agent.handle}`);
    console.log(renderAgent(agent));
  });

// --- board channel ---
const channel = program.command("channel").description("Manage channels");

channel
  .command("create <name>")
  .description("Create a new channel")
  .option("--description <desc>", "Channel description")
  .action(async (name: string, opts: { description?: string }) => {
    const rc = requireRC();
    await api(rc, "POST", "/api/channels", {
      name,
      description: opts.description,
    });
    console.log(`Created channel ${name.startsWith("#") ? name : "#" + name}`);
  });

channel
  .command("list")
  .description("List all channels")
  .action(async () => {
    const rc = requireRC();
    const channels = await api<{ name: string; description: string | null; priority: number }[]>(
      rc, "GET", "/api/channels"
    );
    console.log(renderChannelList(channels));
  });

channel
  .command("priority <name> <priority>")
  .description("Set channel priority (supervision config)")
  .action(async (name: string, priority: string) => {
    const rc = requireRC();
    const n = name.startsWith("#") ? name : `#${name}`;
    await api(rc, "PUT", `/api/channels/${encodeURIComponent(n)}/priority`, {
      priority: parseInt(priority, 10),
    });
    console.log(`Set ${n} priority to ${priority}`);
  });

// --- board post ---
program
  .command("post <handle> <channel> <content>")
  .description("Create a post as an agent")
  .action(async (handle: string, channelName: string, content: string) => {
    const rc = requireRC();
    const post = await api<Post>(rc, "POST", "/api/posts", {
      author: handle,
      channel: channelName,
      content,
    });
    console.log(`Posted ${post.id.slice(0, 8)} by ${post.author} in ${post.channel}`);
  });

// --- board reply ---
program
  .command("reply <post-id> <handle> <content>")
  .description("Reply to a post")
  .action(async (postId: string, handle: string, content: string) => {
    const rc = requireRC();
    // Get the parent post to find its channel
    const parent = await api<Post>(rc, "GET", `/api/posts/${postId}`);
    const reply = await api<Post>(rc, "POST", "/api/posts", {
      author: handle,
      channel: parent.channel,
      content,
      parent_id: postId,
    });
    console.log(`Reply ${reply.id.slice(0, 8)} by ${reply.author}`);
  });

// --- board feed ---
program
  .command("feed")
  .description("Show the ranked feed")
  .option("--channel <name>", "Filter by channel")
  .option("--author <handle>", "Filter by author")
  .option("--since <duration>", "Time filter (e.g. 1h, 30m, 2d)")
  .option("--limit <n>", "Limit posts", "20")
  .action(async (opts: { channel?: string; author?: string; since?: string; limit: string }) => {
    const rc = requireRC();
    const params = new URLSearchParams();
    if (opts.channel) params.set("channel", opts.channel);
    if (opts.author) params.set("author", opts.author);
    if (opts.since) {
      const ts = parseDuration(opts.since);
      if (!ts) {
        die(`Invalid duration: ${opts.since}. Use format like 1h, 30m, 2d`);
      }
      params.set("since", ts);
    }
    params.set("limit", opts.limit);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const feed = await api<RankedPost[]>(rc, "GET", `/api/feed${qs}`);
    console.log(renderFeed(feed));
  });

// --- board briefing ---
program
  .command("briefing")
  .description("Show what happened since your last briefing")
  .action(async () => {
    const rc = requireRC();
    const briefing = await api<BriefingSummary>(rc, "GET", "/api/briefing");
    console.log(renderBriefing(briefing));
  });

// --- board direct ---
program
  .command("direct <handle> <channel> <message>")
  .description("Post a directive as @admin (auto-threads to agent's latest post)")
  .action(async (handle: string, channelName: string, message: string) => {
    const rc = requireRC();
    const h = normalizeHandle(handle);
    const ch = channelName.startsWith("#") ? channelName : `#${channelName}`;

    // Find agent's latest post in that channel to thread onto
    const posts = await api<Post[]>(
      rc, "GET",
      `/api/posts?author=${encodeURIComponent(h)}&channel=${encodeURIComponent(ch)}&top_level=true&limit=1`
    );

    const parentId = posts.length > 0 ? posts[0].id : undefined;

    const directive = await api<Post>(rc, "POST", "/api/posts", {
      author: "@admin",
      channel: ch,
      content: message,
      parent_id: parentId,
    });
    const threaded = parentId ? ` (threaded to ${parentId.slice(0, 8)})` : "";
    console.log(`Directive ${directive.id.slice(0, 8)} → ${h} in ${ch}${threaded}`);
  });

// --- board thread ---
program
  .command("thread <post-id>")
  .description("Show a post thread")
  .action(async (postId: string) => {
    const rc = requireRC();
    const thread = await api<PostThread>(rc, "GET", `/api/posts/${postId}/thread`);
    console.log(renderThread(thread));
  });

// --- board profile ---
program
  .command("profile <handle>")
  .description("Show an agent's profile and posts")
  .action(async (handle: string) => {
    const rc = requireRC();
    const h = normalizeHandle(handle);

    // Fetch agent and posts in parallel
    const [agent, posts] = await Promise.all([
      api<Agent>(rc, "GET", `/api/agents/${encodeURIComponent(h)}`),
      api<Post[]>(rc, "GET", `/api/posts?author=${encodeURIComponent(h)}&limit=20`),
    ]);

    console.log(renderProfile(agent, posts));
  });

// --- board commit ---
program
  .command("commit <hash> <post-id>")
  .description("Link a git commit to a post")
  .option("--files <files...>", "Files changed")
  .action(async (hash: string, postId: string, opts: { files?: string[] }) => {
    const rc = requireRC();
    await api(rc, "POST", "/api/commits", {
      hash,
      post_id: postId,
      files: opts.files,
    });
    console.log(`Linked commit ${hash.slice(0, 8)} to post ${postId.slice(0, 8)}`);
  });

// --- board spawn ---
program
  .command("spawn <handle>")
  .description("Create an agent and launch a Claude Code subprocess")
  .requiredOption("--mission <mission>", "Agent mission / task description")
  .option("--name <name>", "Agent display name")
  .option("--foreground", "Run in foreground (inherits terminal I/O)")
  .option("--identity <name>", "Identity name (from identities/ folder) to pass to spawner")
  .action(async (handle: string, opts: { mission: string; name?: string; foreground?: boolean; identity?: string }) => {
    const rc = requireRC();

    // Create agent via API
    const created = await api<Agent & { api_key: string }>(rc, "POST", "/api/agents", {
      handle,
      name: opts.name,
      mission: opts.mission,
    });

    const { spawnAgent } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();

    // If identity specified, read identity file and prepend to mission
    let mission = opts.mission;
    if (opts.identity) {
      const identityPath = path.join(process.cwd(), "identities", `${opts.identity}.md`);
      if (!fs.existsSync(identityPath)) {
        db.close();
        die(`Identity not found: ${opts.identity}\nAvailable identities: board identity list`);
      }
      const identityContent = fs.readFileSync(identityPath, "utf-8");
      mission = `[Identity: ${opts.identity}]\n${identityContent}\n\n${opts.mission}`;
    }

    try {
      const result = spawnAgent(db, {
        handle: created.handle,
        mission,
        apiKey: created.api_key,
        serverUrl: rc.url,
        projectDir: process.cwd(),
        foreground: opts.foreground,
      });

      if (opts.foreground) {
        console.log(`Running ${created.handle} in foreground (PID ${result.pid})`);
        console.log(`  Branch:   ${result.branch}`);
        console.log(`  Worktree: ${result.worktreePath}\n`);
        // Wait for child to exit
        await new Promise<void>((resolve) => {
          result.child!.on("exit", () => {
            db.close();
            resolve();
          });
        });
      } else {
        console.log(`Spawned ${created.handle} (PID ${result.pid})`);
        console.log(`  Branch:   ${result.branch}`);
        console.log(`  Worktree: ${result.worktreePath}`);
        console.log(`  Logs:     ${result.worktreePath}/agent.log`);
        db.close();
      }
    } catch (err: any) {
      db.close();
      die(`Spawn failed: ${err.message}`);
    }
  });

// --- board kill ---
program
  .command("kill <handle>")
  .description("Kill a spawned agent's subprocess")
  .action(async (handle: string) => {
    const { killAgent } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();
    const h = normalizeHandle(handle);

    try {
      killAgent(db, h, process.cwd());
      console.log(`Killed ${h}`);
    } catch (err: any) {
      throw new CliError(`Error: ${err.message}`);
    } finally {
      db.close();
    }
  });

// --- board ps ---
program
  .command("ps")
  .description("List spawned agent processes")
  .option("--all", "Show stopped agents too")
  .action(async (opts: { all?: boolean }) => {
    const { listSpawns, isProcessAlive } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();

    const spawns = listSpawns(db, !opts.all);
    const infos: SpawnInfo[] = spawns.map((s) => ({
      agent_handle: s.agent_handle,
      pid: s.pid,
      started_at: s.started_at,
      stopped_at: s.stopped_at,
      alive: s.stopped_at ? false : isProcessAlive(s.pid),
    }));

    console.log(renderSpawnList(infos));
    db.close();
  });

// --- board watch ---
program
  .command("watch")
  .description("Live-updating feed (polls every 5s)")
  .option("--interval <seconds>", "Poll interval in seconds", "5")
  .action(async (opts: { interval: string }) => {
    const rc = requireRC();
    const interval = parseInt(opts.interval, 10) * 1000;

    const poll = async () => {
      try {
        const feed = await api<RankedPost[]>(rc, "GET", "/api/feed?limit=20");
        // Clear screen and move cursor to top
        process.stdout.write("\x1b[2J\x1b[H");
        const now = new Date().toLocaleTimeString();
        console.log(`\x1b[1mAgentBoard Feed\x1b[0m  \x1b[90m${now}  (Ctrl+C to exit)\x1b[0m\n`);
        console.log(renderFeed(feed));
      } catch {
        process.stdout.write("\x1b[2J\x1b[H");
        console.log("\x1b[33mConnection lost, retrying...\x1b[0m");
      }
    };

    await poll();
    setInterval(poll, interval);
  });

// --- board status ---
program
  .command("status")
  .description("Show system overview")
  .action(async () => {
    const rc = requireRC();

    const [agents, channels] = await Promise.all([
      api<Agent[]>(rc, "GET", "/api/agents"),
      api<{ name: string; description: string | null; priority: number }[]>(rc, "GET", "/api/channels"),
    ]);

    // Get spawn info from local DB
    const { listSpawns, isProcessAlive } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();
    const spawns = listSpawns(db);
    db.close();

    const spawnInfos: SpawnInfo[] = spawns.map((s) => ({
      agent_handle: s.agent_handle,
      pid: s.pid,
      started_at: s.started_at,
      stopped_at: s.stopped_at,
      alive: s.stopped_at ? false : isProcessAlive(s.pid),
    }));

    // Count posts via feed endpoint (total)
    const allPosts = await api<Post[]>(rc, "GET", "/api/posts?limit=0");
    const postCount = allPosts.length;

    console.log(renderStatus({
      agents: {
        total: agents.length,
        active: agents.filter((a) => a.status === "active").length,
        blocked: agents.filter((a) => a.status === "blocked").length,
        stopped: agents.filter((a) => a.status === "stopped").length,
      },
      posts: postCount,
      channels: channels.map((ch) => ({ name: ch.name, priority: ch.priority })),
      spawns: spawnInfos,
    }));
  });

// --- board merge ---
program
  .command("merge <handle>")
  .description("Merge a stopped agent's worktree branch into main")
  .option("--cleanup", "Remove worktree and branch after merge")
  .action(async (handle: string, opts: { cleanup?: boolean }) => {
    const { mergeAgent, getSpawn } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();
    const h = normalizeHandle(handle);

    try {
      const result = mergeAgent(db, h, process.cwd(), { cleanup: opts.cleanup });
      console.log(`Merged ${result.branch} into main (${result.mergedCommits} commit${result.mergedCommits !== 1 ? "s" : ""})`);
      if (result.worktreeRemoved) {
        console.log(`Cleaned up worktree and branch`);
      }
    } catch (err: any) {
      throw new CliError(`Error: ${err.message}`);
    } finally {
      db.close();
    }
  });

// --- board logs ---
program
  .command("logs <handle>")
  .description("Tail an agent's log file")
  .option("--lines <n>", "Number of lines to show", "50")
  .action(async (handle: string, opts: { lines: string }) => {
    const { getSpawn } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();
    const h = normalizeHandle(handle);

    const spawn = getSpawn(db, h);
    db.close();

    if (!spawn) {
      die(`No spawn record for ${h}`);
    }
    if (!spawn.log_path || !fs.existsSync(spawn.log_path)) {
      die(`Log file not found: ${spawn.log_path}`);
    }

    const lines = parseInt(opts.lines, 10);
    const content = fs.readFileSync(spawn.log_path, "utf-8");
    const allLines = content.split("\n");
    const tail = allLines.slice(-lines).join("\n");
    console.log(tail);
  });

// --- board tmux ---
program
  .command("tmux")
  .description("Open a tmux session with a pane per active agent")
  .option("--session <name>", "tmux session name", "board")
  .option("--tail", "Tail log files instead of foreground spawn (for already-running agents)", true)
  .action(async (opts: { session: string; tail: boolean }) => {
    const { execSync } = await import("child_process");

    // Check tmux is available
    try {
      execSync("which tmux", { stdio: "pipe" });
    } catch {
      die("tmux not found. Install it: brew install tmux");
    }

    const { listSpawns, isProcessAlive } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();

    const spawns = listSpawns(db, true).filter((s) => isProcessAlive(s.pid));
    db.close();

    if (spawns.length === 0) {
      die("No active agents. Spawn some first with `board spawn`.");
    }

    const session = opts.session;

    // Kill existing session if any
    try {
      execSync(`tmux kill-session -t ${session}`, { stdio: "pipe" });
    } catch {
      // Session didn't exist — fine
    }

    // Create new session with first agent's logs
    const first = spawns[0];
    const logCmd = (s: typeof first) =>
      s.log_path ? `tail -f ${s.log_path}` : `echo 'No log file for ${s.agent_handle}'`;

    execSync(
      `tmux new-session -d -s ${session} -n "${first.agent_handle}" "${logCmd(first)}"`,
      { stdio: "pipe" }
    );

    // Add panes for remaining agents
    for (let i = 1; i < spawns.length; i++) {
      const s = spawns[i];
      execSync(
        `tmux split-window -t ${session} "${logCmd(s)}"`,
        { stdio: "pipe" }
      );
      // Rebalance after each split
      execSync(`tmux select-layout -t ${session} tiled`, { stdio: "pipe" });
    }

    // Set pane titles
    for (let i = 0; i < spawns.length; i++) {
      execSync(
        `tmux select-pane -t ${session}:0.${i} -T "${spawns[i].agent_handle}"`,
        { stdio: "pipe" }
      );
    }

    // Enable pane border status to show agent names
    execSync(`tmux set-option -t ${session} pane-border-status top`, { stdio: "pipe" });
    execSync(`tmux set-option -t ${session} pane-border-format " #{pane_title} "`, { stdio: "pipe" });

    // Attach to the session
    const { spawnSync } = await import("child_process");
    spawnSync("tmux", ["attach-session", "-t", session], { stdio: "inherit" });
  });

// --- board tree ---
program
  .command("tree")
  .description("Show the DAG commit tree")
  .option("--agent <handle>", "Filter by agent")
  .action(async (opts: { agent?: string }) => {
    const rc = requireRC();
    const [commits, leaves] = await Promise.all([
      api<DagCommit[]>(rc, "GET", `/api/git/commits?limit=200${opts.agent ? `&agent=${encodeURIComponent(opts.agent)}` : ""}`),
      api<DagCommit[]>(rc, "GET", `/api/git/leaves${opts.agent ? `?agent=${encodeURIComponent(opts.agent)}` : ""}`),
    ]);
    const leafSet = new Set(leaves.map((l) => l.hash));
    console.log(renderDagTree(commits, leafSet));
  });

// --- board dag log ---
const dag = program.command("dag").description("Git DAG operations");

dag
  .command("log")
  .description("Show DAG commit log")
  .option("--agent <handle>", "Filter by agent")
  .option("--limit <n>", "Limit commits", "20")
  .action(async (opts: { agent?: string; limit: string }) => {
    const rc = requireRC();
    const params = new URLSearchParams();
    if (opts.agent) params.set("agent", opts.agent);
    params.set("limit", opts.limit);
    const commits = await api<DagCommit[]>(rc, "GET", `/api/git/commits?${params.toString()}`);
    console.log(renderDagLog(commits));
  });

dag
  .command("leaves")
  .description("Show active exploration frontiers (leaf commits)")
  .option("--agent <handle>", "Filter by agent")
  .action(async (opts: { agent?: string }) => {
    const rc = requireRC();
    const qs = opts.agent ? `?agent=${encodeURIComponent(opts.agent)}` : "";
    const leaves = await api<DagCommit[]>(rc, "GET", `/api/git/leaves${qs}`);
    if (leaves.length === 0) {
      console.log("  No leaves (DAG is empty).");
    } else {
      console.log(`${leaves.length} active frontier${leaves.length !== 1 ? "s" : ""}:\n`);
      console.log(renderDagLog(leaves));
    }
  });

dag
  .command("diff <hash-a> <hash-b>")
  .description("Diff two DAG commits")
  .action(async (hashA: string, hashB: string) => {
    const rc = requireRC();
    const url = `${rc.url}/api/git/diff/${encodeURIComponent(hashA)}/${encodeURIComponent(hashB)}`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${rc.key}` },
      });
      if (!res.ok) {
        const err = await res.json();
        die(`Error: ${(err as any).error}`);
      }
      console.log(await res.text());
    } catch (err: any) {
      die(`Cannot connect to server: ${err.message}`);
    }
  });

dag
  .command("promote <hash>")
  .description("Promote a DAG commit to main (cherry-pick)")
  .action(async (hash: string) => {
    const rc = requireRC();
    const result = await api<PromoteResult>(rc, "POST", "/api/git/promote", { hash });
    console.log(renderPromoteSummary(result));
  });

dag
  .command("summary")
  .description("Show DAG summary")
  .action(async () => {
    const rc = requireRC();
    const summary = await api<DagSummary>(rc, "GET", "/data/dag");
    console.log(renderDagSummary(summary));
  });

// --- board team ---
const team = program.command("team").description("Manage teams");

team
  .command("create <name>")
  .description("Create a new team")
  .option("--manager <handle>", "Team manager handle")
  .option("--mission <mission>", "Team mission")
  .action(async (name: string, opts: { manager?: string; mission?: string }) => {
    const rc = requireRC();
    const created = await api<Team>(rc, "POST", "/api/teams", {
      name,
      manager: opts.manager,
      mission: opts.mission,
    });
    console.log(`Created team ${created.name}`);
    console.log(renderTeam(created));
  });

team
  .command("list")
  .description("List all teams")
  .action(async () => {
    const rc = requireRC();
    const teams = await api<Team[]>(rc, "GET", "/api/teams");
    console.log(renderTeamList(teams));
  });

team
  .command("show <name>")
  .description("Show team details")
  .action(async (name: string) => {
    const rc = requireRC();
    const team = await api<Team & { members?: TeamMember[] }>(
      rc, "GET", `/api/teams/${encodeURIComponent(name)}`
    );
    console.log(renderTeam(team));
  });

team
  .command("add <name> <handle>")
  .description("Add a member to a team")
  .action(async (name: string, handle: string) => {
    const rc = requireRC();
    const h = normalizeHandle(handle);
    await api<TeamMember>(
      rc, "POST", `/api/teams/${encodeURIComponent(name)}/members`, { agent_handle: h }
    );
    console.log(`Added ${h} to team ${name}`);
  });

team
  .command("remove <name> <handle>")
  .description("Remove a member from a team")
  .action(async (name: string, handle: string) => {
    const rc = requireRC();
    const h = normalizeHandle(handle);
    await api(
      rc, "DELETE", `/api/teams/${encodeURIComponent(name)}/members/${encodeURIComponent(h)}`
    );
    console.log(`Removed ${h} from team ${name}`);
  });

// --- board route ---
const route = program.command("route").description("Manage routes");

route
  .command("create <name>")
  .description("Create a new route")
  .option("--team <team>", "Team name")
  .option("--agent <handle>", "Agent handle")
  .action(async (name: string, opts: { team?: string; agent?: string }) => {
    const rc = requireRC();
    const created = await api<Route>(rc, "POST", "/api/routes", {
      name,
      team_name: opts.team,
      agent_handle: opts.agent,
    });
    console.log(`Created route ${created.name}`);
    console.log(renderRoute(created));
  });

route
  .command("list")
  .description("List all routes")
  .option("--team <team>", "Filter by team")
  .action(async (opts: { team?: string }) => {
    const rc = requireRC();
    const qs = opts.team ? `?team=${encodeURIComponent(opts.team)}` : "";
    const routes = await api<Route[]>(rc, "GET", `/api/routes${qs}`);
    console.log(renderRouteList(routes));
  });

route
  .command("update <id>")
  .description("Update a route")
  .option("--status <status>", "New status (exploring, chosen, abandoned)")
  .action(async (id: string, opts: { status?: string }) => {
    const rc = requireRC();
    const body: Record<string, string> = {};
    if (opts.status) body.status = opts.status;
    const route = await api<Route>(rc, "PATCH", `/api/routes/${encodeURIComponent(id)}`, body);
    console.log(`Updated route ${route.name}`);
    console.log(renderRoute(route));
  });

// --- board org ---
program
  .command("org")
  .description("Bird's-eye view of all teams and routes")
  .action(async () => {
    const rc = requireRC();
    const [teams, routes] = await Promise.all([
      api<(Team & { members?: TeamMember[] })[]>(rc, "GET", "/api/teams?include=members"),
      api<Route[]>(rc, "GET", "/api/routes"),
    ]);
    console.log(renderOrg(teams, routes));
  });

// --- board diff ---
program
  .command("diff <handle>")
  .description("Show git diff for an agent's branch vs main")
  .option("--stat", "Show summary only (--stat)")
  .action(async (handle: string, opts: { stat?: boolean }) => {
    const { getSpawn } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();
    const h = normalizeHandle(handle);

    const spawn = getSpawn(db, h);
    db.close();

    if (!spawn) {
      die(`No spawn record for ${h}`);
    }
    if (!spawn.branch) {
      die(`No branch recorded for ${h}`);
    }

    try {
      const args = opts.stat ? `--stat` : "";
      const output = execSync(`git diff main..${spawn.branch} ${args}`, {
        cwd: process.cwd(),
        encoding: "utf-8",
        stdio: "pipe",
      });
      console.log(output || "(no changes)");
    } catch (err: any) {
      die(`Error running git diff: ${err.message}`);
    }
  });

// --- board log ---
program
  .command("log <handle>")
  .description("Tail an agent's log file")
  .option("--follow", "Follow the log (tail -f)")
  .action(async (handle: string, opts: { follow?: boolean }) => {
    const { getSpawn } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();
    const h = normalizeHandle(handle);

    const spawn = getSpawn(db, h);
    db.close();

    if (!spawn) {
      die(`No spawn record for ${h}`);
    }
    if (!spawn.log_path || !fs.existsSync(spawn.log_path)) {
      die(`Log file not found: ${spawn.log_path}`);
    }

    if (opts.follow) {
      const tail = nodeSpawn("tail", ["-f", spawn.log_path], { stdio: "inherit" });
      tail.on("exit", (code) => process.exit(code ?? 0));
    } else {
      const output = execSync(`tail ${spawn.log_path}`, { encoding: "utf-8" });
      console.log(output);
    }
  });

// --- board validate-sprint ---
program
  .command("validate-sprint")
  .description("Validate sprint: check agents stopped, run tests, detect conflicts")
  .action(async () => {
    console.log("Running pre-flight checks...\n");
    const pf = await runPreFlight(process.cwd());

    if (!pf.allStopped) {
      console.log(`\u26a0 Running agents: ${pf.running.map((s) => s.agent_handle).join(", ")}`);
    } else {
      console.log("All agents stopped.");
    }

    console.log(pf.testsPass ? "Tests passed." : "Tests failed.");

    for (const b of pf.branches) {
      console.log(`\n--- ${b.agent_handle} (${b.branch}) ---`);
      console.log(`  +${b.additions} -${b.deletions} (${b.filesChanged} files)`);
    }

    if (pf.conflicts.length > 0) {
      console.log("\nConflicts detected:");
      for (const c of pf.conflicts) {
        console.log(`  - ${c}`);
      }
    } else {
      console.log("\nNo file conflicts detected.");
    }

    if (pf.mergeOrder.length > 0) {
      console.log("\nSuggested merge order:");
      pf.mergeOrder.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
    }

    const validation: SprintValidation = {
      allStopped: pf.allStopped,
      testsPass: pf.testsPass,
      branches: pf.branches,
      conflicts: pf.conflicts.map((c) => c.split(" (")[0]),
      suggestedOrder: pf.mergeOrder,
    };

    console.log("\n" + JSON.stringify(validation, null, 2));
  });

// --- board sprint ---
const sprint = program.command("sprint").description("Sprint orchestrator — manage parallel agent work");

sprint
  .command("suggest <goal>")
  .description("Smart task decomposition — analyzes codebase, calls Claude to generate a sprint plan")
  .option("--auto", "Call Claude CLI automatically instead of printing the prompt")
  .option("--save <path>", "Save the decomposition result to a JSON file")
  .action(async (goal: string, opts: { auto?: boolean; save?: string }) => {
    const projectDir = process.cwd();
    const {
      analyzeImports,
      findCouplingClusters,
      getFileContext,
      buildDecompositionPrompt,
      parseDecompositionResponse,
    } = await import("./decomposer.js");
    const { listIdentities, loadIdentity: loadId } = await import("./identities.js");

    console.log("Analyzing codebase...");

    // 1. Analyze import graph
    const imports = analyzeImports(projectDir);
    const clusters = findCouplingClusters(imports);

    // 2. Get file context (headers + exports)
    const fileContexts = new Map<string, import("./decomposer.js").FileContext>();
    const allFiles: string[] = [];
    for (const [file] of imports) {
      allFiles.push(file);
      const absPath = path.resolve(projectDir, file);
      fileContexts.set(file, getFileContext(absPath));
    }

    // 3. Load identities
    const identityNames = listIdentities(projectDir);
    const identities: { name: string; description: string }[] = [];
    for (const name of identityNames) {
      try {
        const id = loadId(name, projectDir);
        identities.push({ name: id.name, description: id.description });
      } catch { /* skip malformed */ }
    }

    console.log(`  ${allFiles.length} files, ${clusters.length} coupling clusters, ${identities.length} identities`);

    // 4. Build prompt
    const prompt = buildDecompositionPrompt({
      goal,
      fileTree: allFiles,
      clusters,
      fileContexts,
      identities,
    });

    if (!opts.auto) {
      console.log("\n--- Decomposition Prompt ---\n");
      console.log(prompt);
      console.log("\nRun with --auto to call Claude CLI automatically.");
      return;
    }

    // 5. Call Claude CLI
    console.log("Calling Claude for task decomposition...");
    const { execSync } = await import("child_process");
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    let raw: string;
    try {
      raw = execSync(`claude -p '${escapedPrompt}'`, {
        cwd: projectDir,
        timeout: 120000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err: any) {
      die(`Claude CLI failed: ${err.message}`);
    }

    // 6. Parse response
    const result = parseDecompositionResponse(raw);
    console.log(`\nDecomposition: ${result.tasks.length} tasks\n`);
    for (const task of result.tasks) {
      console.log(`  ${task.handle} (${task.agent})`);
      console.log(`    Mission: ${task.mission.slice(0, 100)}${task.mission.length > 100 ? "..." : ""}`);
      console.log(`    Scope: ${task.scope.join(", ")}`);
      console.log();
    }

    if (opts.save) {
      fs.writeFileSync(opts.save, JSON.stringify(result, null, 2));
      console.log(`Plan saved to ${opts.save}`);
      console.log(`Start with: board sprint start --name my-sprint --goal "${goal}" --plan ${opts.save}`);
    }
  });

sprint
  .command("run <goal>")
  .description("End-to-end sprint: decompose goal → confirm plan → spawn agents")
  .requiredOption("--name <name>", "Sprint name (slug)")
  .action(async (goal: string, opts: { name: string }) => {
    const projectDir = process.cwd();
    const rc = requireRC();
    const { decompose } = await import("./decomposer.js");

    console.log("Analyzing codebase and decomposing task...\n");

    let result;
    try {
      result = await decompose(goal, projectDir);
    } catch (err: any) {
      die(`Decomposition failed: ${err.message}`);
    }

    // Display plan
    console.log(`Goal: ${result.goal}`);
    console.log(`Tasks: ${result.tasks.length}\n`);
    for (let i = 0; i < result.tasks.length; i++) {
      const t = result.tasks[i];
      console.log(`  ${i + 1}. ${t.handle} (${t.agent})`);
      console.log(`     ${t.mission.slice(0, 120)}${t.mission.length > 120 ? "..." : ""}`);
      console.log(`     Scope: ${t.scope.join(", ")}`);
      console.log();
    }

    // Confirm
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Proceed? [Y/n/edit] ", resolve);
    });
    rl.close();

    if (answer.toLowerCase() === "n") {
      console.log("Cancelled.");
      return;
    }

    if (answer.toLowerCase() === "edit") {
      const planPath = path.join(projectDir, `sprint-${opts.name}.json`);
      fs.writeFileSync(planPath, JSON.stringify(result, null, 2));
      console.log(`Plan saved to ${planPath}. Edit it, then run:`);
      console.log(`  board sprint start --name ${opts.name} --goal "${goal}" --plan ${planPath}`);
      return;
    }

    // Save plan and start sprint
    const planPath = path.join(projectDir, `sprint-${opts.name}.json`);
    fs.writeFileSync(planPath, JSON.stringify(result, null, 2));

    // Delegate to sprint start
    const { execSync } = await import("child_process");
    const escapedGoal = goal.replace(/"/g, '\\"');
    execSync(
      `npx tsx src/cli.ts sprint start --name ${opts.name} --goal "${escapedGoal}" --plan ${planPath}`,
      { cwd: projectDir, stdio: "inherit" }
    );

    // Open kanban
    const port = rc.url.match(/:(\d+)/)?.[1] ?? "3141";
    console.log(`\nKanban: http://localhost:${port}/app/`);
  });

sprint
  .command("start")
  .description("Start a new sprint with multiple agents")
  .requiredOption("--name <name>", "Sprint name (slug)")
  .requiredOption("--goal <goal>", "Sprint goal description")
  .option("--plan <path>", "Path to JSON sprint plan file (simple mode)")
  .option("--agents <specs>", "Agent specs as JSON array: [{\"handle\":\"@x\",\"identity\":\"researcher\",\"mission\":\"...\"}]")
  .option("--yaml <path>", "Path to YAML sprint definition file")
  .action(async (opts: { name: string; goal: string; plan?: string; agents?: string; yaml?: string }) => {
    const rc = requireRC();
    const { getDb } = await import("./db.js");
    const db = getDb();

    // Parse agent specs from --plan, --agents, or --yaml
    let agentSpecs: AgentSpec[] = [];

    if (opts.plan) {
      const planPath = path.resolve(opts.plan);
      if (!fs.existsSync(planPath)) { db.close(); die(`Plan file not found: ${planPath}`); }
      let plan: { goal: string; tasks: { agent: string; handle: string; mission: string; scope: string[] }[] };
      try { plan = JSON.parse(fs.readFileSync(planPath, "utf-8")); }
      catch (err: any) { db.close(); die(`Invalid JSON in plan file: ${err.message}`); }
      if (!plan.tasks || !Array.isArray(plan.tasks)) { db.close(); die("Plan must contain a 'tasks' array."); }
      agentSpecs = plan.tasks.map((t) => ({ handle: t.handle, identity: t.agent, mission: t.mission, scope: t.scope }));
    } else if (opts.yaml) {
      const content = fs.readFileSync(opts.yaml, "utf-8");
      try {
        const parsed = JSON.parse(content);
        agentSpecs = parsed.agents || [];
        if (!opts.name && parsed.name) opts.name = parsed.name;
        if (!opts.goal && parsed.goal) opts.goal = parsed.goal;
      } catch { db.close(); die(`Failed to parse sprint file: ${opts.yaml}`); }
    } else if (opts.agents) {
      try { agentSpecs = JSON.parse(opts.agents); }
      catch { db.close(); die("Invalid --agents JSON. Expected: [{\"handle\":\"@x\",\"mission\":\"...\"}]"); }
    } else {
      db.close();
      die("Provide --plan, --agents, or --yaml to define sprint agents.");
    }

    if (agentSpecs.length === 0) { db.close(); die("No agents defined for this sprint."); }

    console.log(`Starting sprint: ${opts.goal}`);
    console.log(`Tasks: ${agentSpecs.length}\n`);

    try {
      const result = await startSprint({
        name: opts.name,
        goal: opts.goal,
        specs: agentSpecs,
        projectDir: process.cwd(),
        serverUrl: rc.url,
        db,
        onSpawn: (handle, pid, branch) => {
          console.log(`  Spawned ${handle} (PID ${pid}, branch: ${branch})`);
        },
      });

      console.log(`\nSprint "${opts.name}" started with ${result.spawned.length} agents.`);
      console.log(`  board sprint status ${opts.name}  — check progress`);
      console.log(`  board sprint land ${opts.name}    — review and merge`);
      console.log(`  board alerts                      — check for issues`);
    } catch (err: any) {
      throw new CliError(err.message);
    } finally {
      db.close();
    }
  });

sprint
  .command("list")
  .description("List all sprints")
  .action(async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const sprints = db.prepare("SELECT * FROM sprints ORDER BY created_at DESC").all() as Sprint[];
    console.log(renderSprintList(sprints));
    db.close();
  });

sprint
  .command("status <name>")
  .description("Show sprint status with agent tiles")
  .option("--detail", "Show expanded tiles with full reports")
  .action(async (name: string, opts: { detail?: boolean }) => {
    try {
      const report = await buildSprintReport(name, process.cwd());
      console.log(renderSprintReport(report, opts.detail));
    } catch (err: any) {
      die(err.message);
    }
  });

sprint
  .command("land <name>")
  .description("CEO landing experience — review agent work in English, inspect, merge passing")
  .option("--yes", "Skip interactive prompts, merge all passing agents")
  .action(async (name: string, opts: { yes?: boolean }) => {
    const projectDir = process.cwd();
    const readline = await import("readline");

    async function runLanding(): Promise<void> {
      console.log(`\n${c.dim}Building landing brief...${c.reset}\n`);

      let brief;
      try {
        brief = await buildLandingBrief(name, projectDir);
      } catch (err: any) {
        die(err.message);
      }

      console.log(renderLandingBrief(brief));

      // Non-interactive mode
      if (opts.yes) {
        const passing = brief.agents.filter((a) => a.status === "passed");
        if (passing.length === 0) {
          console.log(`\n  No passing agents to merge.`);
          return;
        }
        await doMerge(passing.map((a) => a.handle), name, projectDir);
        return;
      }

      // Interactive mode
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

      try {
        await interactiveLoop(brief, rl, ask, name, projectDir);
      } finally {
        rl.close();
      }
    }

    async function interactiveLoop(
      brief: Awaited<ReturnType<typeof buildLandingBrief>>,
      rl: import("readline").Interface,
      ask: (q: string) => Promise<string>,
      sprintName: string,
      dir: string,
    ): Promise<void> {
      const passing = brief.agents.filter((a) => a.status === "passed");
      const hasRunning = brief.summary.running > 0;

      // Build prompt
      console.log("");
      let prompt = `  ${c.bold}[enter]${c.reset} land ${passing.length} passing`;
      if (hasRunning) prompt += `  ${c.bold}[w]${c.reset} wait`;
      for (let i = 0; i < brief.agents.length; i++) {
        prompt += `  ${c.bold}[${i + 1}]${c.reset} ${brief.agents[i].handle}`;
      }
      prompt += `  ${c.bold}[q]${c.reset} quit`;
      console.log(prompt);

      const choice = await ask("  > ");

      if (choice === "q") return;

      if (choice === "w" && hasRunning) {
        console.log(`  ${c.dim}Waiting 10 seconds...${c.reset}`);
        await new Promise((resolve) => setTimeout(resolve, 10000));
        rl.close();
        await runLanding();
        return;
      }

      // Check if user picked an agent number
      const num = parseInt(choice, 10);
      if (!isNaN(num) && num >= 1 && num <= brief.agents.length) {
        const agent = brief.agents[num - 1];
        console.log("");
        console.log(renderAgentInspect(agent));

        const inspectChoice = await ask("  > ");

        if (inspectChoice === "m" && agent.status === "passed") {
          await doMerge([agent.handle], sprintName, dir);
          return;
        }

        if (inspectChoice === "d" && agent.branch) {
          try {
            const diff = execSync(`git diff main..${agent.branch}`, {
              cwd: dir, encoding: "utf-8", stdio: "pipe",
            });
            console.log(diff);
          } catch (err: any) {
            console.log(`  ${c.red}Could not show diff: ${err.message}${c.reset}`);
          }
        }

        // Go back to main loop
        await interactiveLoop(brief, rl, ask, sprintName, dir);
        return;
      }

      // Enter = land all passing
      if (choice === "") {
        if (passing.length === 0) {
          console.log(`\n  No passing agents to merge.`);
          return;
        }
        await doMerge(passing.map((a) => a.handle), sprintName, dir);
        return;
      }

      console.log(`  ${c.dim}Unknown option.${c.reset}`);
      await interactiveLoop(brief, rl, ask, sprintName, dir);
    }

    async function doMerge(handles: string[], sprintName: string, dir: string): Promise<void> {
      console.log(`\n  ${c.bold}Landing ${handles.length} agent${handles.length === 1 ? "" : "s"}...${c.reset}`);

      const { getDb } = await import("./db.js");
      const db = getDb();
      try {
        const result = await mergeWithTestGates(handles, dir, { db });

        // Mark sprint finished
        db.prepare(
          "UPDATE sprints SET status = 'finished', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE name = ?"
        ).run(sprintName);

        console.log(`\n  ${c.green}Landed ${result.merged.length} agent${result.merged.length === 1 ? "" : "s"}.${c.reset}`);

        // Post summary to #status
        try {
          const rc = requireRC();
          await api(rc, "POST", "/api/posts", {
            content: `Sprint "${sprintName}" landed. Merged: ${result.merged.join(", ")}.`,
            channel: "#status",
          });
          console.log(`  ${c.dim}Posted to #status${c.reset}`);
        } catch { /* best effort */ }
      } catch (err: any) {
        console.error(`  ${c.red}Merge failed: ${err.message}${c.reset}`);
        db.prepare(
          "UPDATE sprints SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE name = ?"
        ).run(sprintName);
      } finally {
        db.close();
      }
    }

    await runLanding();
  });

// --- board steer ---
program
  .command("steer <handle> [message]")
  .description("Send a directive to a running agent, or clear directives with --clear")
  .option("--clear", "Clear all directives for this agent")
  .action(async (handle: string, message: string | undefined, opts: { clear?: boolean }) => {
    const h = normalizeHandle(handle);
    const projectDir = process.cwd();

    if (opts.clear) {
      const { clearDirectives } = await import("./spawner.js");
      try {
        clearDirectives(projectDir, h);
        console.log(`Cleared directives for ${h}`);
      } catch (err: any) {
        die(err.message);
      }
      return;
    }

    if (!message) {
      die("Message is required (or use --clear)");
    }

    // Write directive to agent's CLAUDE.md Active Directives section
    const { writeDirective } = await import("./spawner.js");
    try {
      writeDirective(projectDir, h, message);
      console.log(`Wrote directive to ${h}`);
    } catch (err: any) {
      die(err.message);
    }

    // Also post to #work for visibility
    const rc = readBoardRC();
    if (rc) {
      try {
        await api(rc, "POST", "/api/posts", {
          content: `@${h.replace("@", "")} DIRECTIVE: ${message}`,
          channel: "#work",
          author: "@admin",
        });
        console.log(`Posted directive to #work`);
      } catch {
        // Best effort — agent reads CLAUDE.md regardless
      }
    }
  });

// --- board cleanup ---
program
  .command("cleanup")
  .description("Delete merged agent branches and prune worktrees")
  .option("--dry-run", "Show what would be deleted without doing it")
  .action(async (opts: { dryRun?: boolean }) => {
    const projectDir = process.cwd();
    const { listSpawns } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();
    const spawns = listSpawns(db);
    db.close();

    // Find agent branches (strip *, + prefixes from git branch output)
    const parseBranches = (output: string) =>
      output.split("\n").map((b) => b.trim().replace(/^[*+] /, "")).filter((b) => b.startsWith("agent/"));

    const allBranches = parseBranches(
      execSync("git branch", { cwd: projectDir, encoding: "utf-8" })
    );

    // Check which are merged into current branch
    const mergedSet = new Set(parseBranches(
      execSync("git branch --merged", { cwd: projectDir, encoding: "utf-8" })
    ));

    // Don't delete branches with actively running agents
    const activeBranches = new Set(
      spawns.filter((s) => !s.stopped_at && s.branch).map((s) => s.branch!)
    );

    const toDelete = allBranches.filter((b) => mergedSet.has(b) && !activeBranches.has(b));
    const remaining = allBranches.filter((b) => !toDelete.includes(b));

    if (toDelete.length === 0) {
      console.log("No merged agent branches to clean up.");
      return;
    }

    console.log(`Found ${toDelete.length} merged agent branch${toDelete.length === 1 ? "" : "es"}:`);
    for (const b of toDelete) {
      const handle = "@" + b.replace("agent/", "");
      const worktreePath = path.join(projectDir, ".worktrees", handle);
      console.log(`  ${opts.dryRun ? "[dry-run] " : ""}delete ${b}`);
      if (!opts.dryRun) {
        // Remove worktree first (branch can't be deleted while checked out)
        if (fs.existsSync(worktreePath)) {
          try {
            execSync(`git worktree remove "${worktreePath}" --force`, { cwd: projectDir, stdio: "pipe" });
          } catch {
            try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
        try {
          execSync(`git branch -D ${b}`, { cwd: projectDir, stdio: "pipe" });
        } catch {
          console.error(`    Failed to delete ${b}`);
        }
      }
    }

    // Prune any remaining stale worktree references
    if (!opts.dryRun) {
      try {
        execSync("git worktree prune", { cwd: projectDir, stdio: "pipe" });
      } catch { /* ignore */ }
      console.log("Done.");
    }

    if (remaining.length > 0) {
      console.log(`\n${remaining.length} unmerged branch${remaining.length === 1 ? "" : "es"} kept: ${remaining.join(", ")}`);
    }
  });

// --- board portfolio ---
program
  .command("portfolio")
  .description("Bird's-eye view of all sprints")
  .action(async () => {
    const { getDb } = await import("./db.js");
    const { listSpawns, isProcessAlive } = await import("./spawner.js");
    const db = getDb();

    const sprints = db.prepare("SELECT * FROM sprints ORDER BY created_at DESC").all() as Sprint[];
    const spawns = listSpawns(db);

    const portfolioData = sprints.map((s) => {
      const agents = db.prepare("SELECT * FROM sprint_agents WHERE sprint_name = ?").all(s.name) as SprintAgent[];
      let running = 0;
      let stopped = 0;
      for (const a of agents) {
        const spawn = spawns.find((sp) => sp.agent_handle === a.agent_handle);
        if (spawn && !spawn.stopped_at && isProcessAlive(spawn.pid)) {
          running++;
        } else {
          stopped++;
        }
      }
      return { sprint: s, agentCount: agents.length, running, stopped };
    });

    console.log(renderPortfolio(portfolioData));
    db.close();
  });

// --- board alerts ---
program
  .command("alerts")
  .description("Show alerts derived from escalations, crashes, and stale agents")
  .action(async () => {
    const { getDb } = await import("./db.js");
    const { listSpawns, isProcessAlive } = await import("./spawner.js");
    const db = getDb();

    const alerts: Alert[] = [];

    // 1. Escalation posts (last 24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const escalations = db.prepare(
      "SELECT author, content, created_at FROM posts WHERE channel = '#escalations' AND created_at >= ? ORDER BY created_at DESC"
    ).all(oneDayAgo) as { author: string; content: string; created_at: string }[];

    for (const e of escalations) {
      alerts.push({
        type: "escalation",
        agent: e.author,
        message: e.content.length > 100 ? e.content.slice(0, 97) + "..." : e.content,
        time: e.created_at,
      });
    }

    // 2. Dead agents (not stopped but process dead)
    const { markSpawnStopped } = await import("./spawner.js");
    const spawns = listSpawns(db);
    for (const s of spawns) {
      if (s.stopped_at) {
        // Already stopped — check if it was a crash (exit_code > 0)
        if (s.exit_code !== null && s.exit_code > 0) {
          alerts.push({
            type: "crashed",
            agent: s.agent_handle,
            message: `Exited with code ${s.exit_code} (started ${s.started_at})`,
            time: s.stopped_at,
          });
        }
        continue;
      }
      if (!isProcessAlive(s.pid)) {
        // Process dead but not marked stopped — auto-mark
        markSpawnStopped(db, s.agent_handle);
        alerts.push({
          type: "crashed",
          agent: s.agent_handle,
          message: `Process ${s.pid} is dead (started ${s.started_at})`,
          time: s.started_at,
        });
      }
    }

    // 3. Stale agents (running but no post in last 30 minutes)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    for (const s of spawns) {
      if (s.stopped_at || !isProcessAlive(s.pid)) continue;
      const recentPost = db.prepare(
        "SELECT created_at FROM posts WHERE author = ? AND created_at >= ? LIMIT 1"
      ).get(s.agent_handle, thirtyMinAgo) as { created_at: string } | undefined;

      if (!recentPost) {
        alerts.push({
          type: "stale",
          agent: s.agent_handle,
          message: "Running but no posts in 30+ minutes",
          time: s.started_at,
        });
      }
    }

    console.log(renderAlerts(alerts));
    db.close();
  });

// --- board identity ---
const identity = program.command("identity").description("Manage agent identities");

identity
  .command("list")
  .description("List available identities")
  .action(async () => {
    const identitiesDir = path.join(process.cwd(), "identities");
    if (!fs.existsSync(identitiesDir)) {
      console.log("No identities/ folder found.");
      return;
    }
    const files = fs.readdirSync(identitiesDir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) {
      console.log("No identity files found in identities/");
      return;
    }
    console.log("Available identities:");
    for (const file of files) {
      console.log(`  ${file.replace(/\.md$/, "")}`);
    }
  });

identity
  .command("show <name>")
  .description("Show an identity file")
  .action(async (name: string) => {
    const identityPath = path.join(process.cwd(), "identities", `${name}.md`);
    if (!fs.existsSync(identityPath)) {
      die(`Identity not found: ${name}`);
    }
    console.log(fs.readFileSync(identityPath, "utf-8"));
  });

identity
  .command("import <pathOrGlob>")
  .description("Import agency-agents format identities from markdown files")
  .action(async (pathOrGlob: string) => {
    const { parseIdentityFrontmatter, listIdentities, saveIdentity } = await import("./identities.js");

    let files: string[];
    try {
      const resolved = path.resolve(pathOrGlob);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        files = [resolved];
      } else if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        files = fs.readdirSync(resolved)
          .filter(f => f.endsWith(".md"))
          .map(f => path.join(resolved, f));
      } else {
        // Treat as glob using fs.globSync (Node 22+)
        files = fs.globSync(pathOrGlob) as unknown as string[];
      }
    } catch {
      die(`Failed to resolve path: ${pathOrGlob}`);
      return;
    }

    if (files.length === 0) {
      die(`No markdown files found at: ${pathOrGlob}`);
    }

    const existing = new Set(listIdentities(process.cwd()));
    let imported = 0;
    let skipped = 0;

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const raw = fs.readFileSync(file, "utf-8");
        const frontmatter = parseIdentityFrontmatter(raw);

        // Check if identity already exists
        if (existing.has(frontmatter.name)) {
          console.log(`  ${c.dim}skip${c.reset}  ${frontmatter.name} (already exists)`);
          skipped++;
          continue;
        }

        // Extract body after closing ---
        const bodyMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
        const body = bodyMatch ? bodyMatch[1].trim() : "";

        const identity = {
          name: frontmatter.name,
          description: frontmatter.description,
          expertise: frontmatter.expertise ?? [],
          vibe: frontmatter.vibe ?? "",
          content: body,
          emoji: frontmatter.emoji,
          color: frontmatter.color,
        };

        saveIdentity(identity, process.cwd());
        existing.add(frontmatter.name);
        console.log(`  ${c.green}import${c.reset}  ${frontmatter.name}`);
        imported++;
      } catch (err: any) {
        console.log(`  ${c.red}error${c.reset}  ${path.basename(file)}: ${err.message}`);
      }
    }

    console.log(`\nImported ${imported} identit${imported === 1 ? "y" : "ies"}, skipped ${skipped} (already exist).`);
  });

// --- board research ---

interface MetricPreset {
  description: string;
  eval: string;
  metric: string;
  direction: "higher" | "lower";
  guard: string;
}

const METRIC_PRESETS: Record<string, MetricPreset> = {
  tests: {
    description: "Maximize test count with zero failures",
    eval: "npm test",
    metric: "grep '^ℹ tests' eval.log | awk '{print $3}'",
    direction: "higher",
    guard: "grep '^ℹ fail' eval.log | awk '{print $3}' | xargs test 0 -eq",
  },
  lean: {
    description: "Minimize source lines of code (tests must pass)",
    eval: "find src -name '*.ts' ! -name '*.test.ts' | xargs wc -l",
    metric: "tail -1 eval.log | awk '{print $1}'",
    direction: "lower",
    guard: "npm test > /dev/null 2>&1",
  },
  coverage: {
    description: "Maximize test coverage percentage",
    eval: "npx c8 --reporter=text npm test",
    metric: "grep 'All files' eval.log | awk '{print $4}' | tr -d '%'",
    direction: "higher",
    guard: "grep '^ℹ fail' eval.log | awk '{print $3}' | xargs test 0 -eq",
  },
  speed: {
    description: "Minimize test duration (tests must pass)",
    eval: "npm test",
    metric: "grep '^ℹ duration_ms' eval.log | awk '{print $3}'",
    direction: "lower",
    guard: "grep '^ℹ fail' eval.log | awk '{print $3}' | xargs test 0 -eq",
  },
  security: {
    description: "Minimize security issues found by grep audit",
    eval: "grep -rn 'eval(\\|exec(\\|execSync(\\|innerHTML\\|dangerouslySetInnerHTML\\|__proto__\\|constructor.prototype' src/ --include='*.ts' || true",
    metric: "wc -l < eval.log | tr -d ' '",
    direction: "lower",
    guard: "npm test > /dev/null 2>&1",
  },
  condense: {
    description: "Structural code condensation — merge files, inline functions, eliminate dead exports (uses condenser identity)",
    eval: "find src -name '*.ts' ! -name '*.test.ts' | xargs wc -l",
    metric: "tail -1 eval.log | awk '{print $1}'",
    direction: "lower",
    guard: "npm test > /dev/null 2>&1",
  },
  explore: {
    description: "Branching exploration — try 3 approaches per round, pick the best (uses explorer identity)",
    eval: "find src -name '*.ts' ! -name '*.test.ts' | xargs wc -l",
    metric: "tail -1 eval.log | awk '{print $1}'",
    direction: "lower",
    guard: "npm test > /dev/null 2>&1",
  },
};

/** Load custom presets from .boardrc if available, merge with built-ins. */
function loadMergedPresets(): { presets: Record<string, MetricPreset>; customNames: Set<string> } {
  const customNames = new Set<string>();
  const rc = readBoardRC();
  if (rc) {
    try {
      const rcPath = path.join(process.cwd(), ".boardrc");
      const rcData = JSON.parse(fs.readFileSync(rcPath, "utf-8"));
      if (rcData.presets && typeof rcData.presets === "object") {
        for (const name of Object.keys(rcData.presets)) {
          customNames.add(name);
        }
        return { presets: { ...METRIC_PRESETS, ...rcData.presets }, customNames };
      }
    } catch { /* ignore parse errors */ }
  }
  return { presets: { ...METRIC_PRESETS }, customNames };
}

const research = program.command("research").description("Auto-research: self-improving background agent");

research
  .command("start")
  .description("Start the auto-research agent (Karpathy-style self-improving loop)")
  .option("--tag <tag>", "Run tag for this session (e.g. 'mar13-security'). Creates branch agent/researcher-<tag>")
  .option("--preset <name>", "Use a metric preset: tests, lean, coverage, speed, security")
  .option("--focus <topic>", "Focus the researcher on a specific area (e.g. 'security', 'test coverage')")
  .option("--scope <files>", "Comma-separated list of in-scope files (e.g. 'src/server.ts,src/routes.ts')")
  .option("--eval <command>", "Eval command (overrides preset)")
  .option("--metric <command>", "Shell command to extract metric from eval.log (overrides preset)")
  .option("--direction <dir>", "Optimize direction: 'higher' or 'lower' (overrides preset)")
  .option("--guard <command>", "Guard command that must exit 0 for KEEP (overrides preset)")
  .option("--identity <name>", "Identity to use (default: researcher, condense preset uses condenser)")
  .option("--width <n>", "Exploration width for explorer identity — approaches per round (default: 3)")
  .option("--foreground", "Run in foreground instead of background")
  .action(async (opts: { tag?: string; preset?: string; focus?: string; scope?: string; eval?: string; metric?: string; direction?: string; guard?: string; identity?: string; width?: string; foreground?: boolean }) => {
    const { initDb } = await import("./db.js");
    const { loadIdentity } = await import("./identities.js");
    const { createAgent, getAgent } = await import("./agents.js");
    const { generateKey, storeKey } = await import("./auth.js");
    const { spawnAgent, respawnAgent, getSpawn, isProcessAlive } = await import("./spawner.js");

    const rc = readBoardRC();
    if (!rc) {
      die("No .boardrc found. Run `board init` first.");
    }

    // Resolve preset → defaults → explicit overrides (merges custom presets from .boardrc)
    const { presets: mergedPresets } = loadMergedPresets();
    const presetName = opts.preset || "tests";
    const preset = mergedPresets[presetName];
    if (opts.preset && !preset) {
      die(`Unknown preset: ${opts.preset}. Available: ${Object.keys(mergedPresets).join(", ")}`);
    }
    const resolvedMetric = {
      eval: opts.eval || preset.eval,
      metric: opts.metric || preset.metric,
      direction: opts.direction || preset.direction,
      guard: opts.guard ?? preset.guard,
    };

    const db = initDb(process.cwd());

    // Handle name: @researcher or @researcher-<tag>
    const handle = opts.tag ? `researcher-${opts.tag}` : "researcher";
    const normalizedHandle = `@${handle}`;

    // Check if this researcher is already running
    const existingSpawn = getSpawn(db, normalizedHandle);
    if (existingSpawn && !existingSpawn.stopped_at && isProcessAlive(existingSpawn.pid)) {
      db.close();
      die(`Researcher is already running (PID ${existingSpawn.pid}). Use \`board research stop${opts.tag ? ` --tag ${opts.tag}` : ""}\` first.`);
    }

    // Load identity — condense/explore presets auto-select their identity
    const identityName = opts.identity || (presetName === "condense" ? "condenser" : presetName === "explore" ? "explorer" : "researcher");
    let identity;
    try {
      identity = loadIdentity(identityName, process.cwd());
    } catch {
      db.close();
      die(`Identity not found at identities/${identityName}.md`);
    }

    // Build mission with metrics, focus, and scope
    let mission = "Autonomously scan and improve this codebase. Follow the experiment loop in your identity: scan → improve → test → commit → report → repeat. Never stop.";

    if (opts.focus) {
      mission += `\n\nFOCUS: Prioritize improvements related to: ${opts.focus}`;
    }

    if (opts.scope) {
      const files = opts.scope.split(",").map(f => f.trim());
      mission += `\n\nIN-SCOPE FILES (only modify these):\n${files.map(f => `- ${f}`).join("\n")}`;
    }

    // Inject metric config into the identity template
    // These replace {{PLACEHOLDER}} tokens in identities/researcher.md
    const metricConfig: Record<string, string> = {
      EVAL_COMMAND: resolvedMetric.eval,
      METRIC_COMMAND: resolvedMetric.metric,
      DIRECTION: resolvedMetric.direction,
      GUARD_COMMAND: resolvedMetric.guard,
      WIDTH: opts.width || "3",
    };

    if (identity) {
      let content = identity.content;
      for (const [key, value] of Object.entries(metricConfig)) {
        content = content.replaceAll(`{{${key}}}`, value);
      }
      identity = { ...identity, content };
    }

    // Create or reuse the agent
    const existing = getAgent(db, normalizedHandle);
    try {
      if (existing && existingSpawn) {
        // Respawn existing researcher
        const result = respawnAgent(db, normalizedHandle, {
          mission,
          serverUrl: rc.url,
          projectDir: process.cwd(),
          foreground: opts.foreground,
        });
        console.log(`Researcher respawned (PID ${result.pid})`);
        console.log(`  Tag: ${opts.tag || "(default)"}`);
        console.log(`  Branch: ${result.branch}`);
        console.log(`  Worktree: ${result.worktreePath}`);
      } else {
        // First time — create agent + spawn
        if (!existing) {
          createAgent(db, { handle, name: `Auto-Researcher${opts.tag ? ` (${opts.tag})` : ""}`, role: "worker", mission });
        }
        const apiKey = generateKey();
        storeKey(db, apiKey, normalizedHandle);

        const result = spawnAgent(db, {
          handle: normalizedHandle,
          mission,
          apiKey,
          serverUrl: rc.url,
          projectDir: process.cwd(),
          foreground: opts.foreground,
          identity,
        });
        console.log(`Researcher started (PID ${result.pid})`);
        console.log(`  Tag: ${opts.tag || "(default)"}`);
        console.log(`  Branch: ${result.branch}`);
        console.log(`  Worktree: ${result.worktreePath}`);
      }
    } catch (err: any) {
      db.close();
      die(`Failed to start researcher: ${err.message}`);
    }

    if (opts.focus) console.log(`  Focus: ${opts.focus}`);
    if (opts.scope) console.log(`  Scope: ${opts.scope}`);
    console.log(`  Preset: ${presetName}${preset ? ` — ${preset.description}` : ""}`);
    console.log(`  Eval: ${resolvedMetric.eval}`);
    console.log(`  Metric: ${resolvedMetric.metric}`);
    console.log(`  Direction: ${resolvedMetric.direction}`);
    if (resolvedMetric.guard) console.log(`  Guard: ${resolvedMetric.guard}`);

    if (!opts.foreground) {
      const h = opts.tag ? `@researcher-${opts.tag}` : "@researcher";
      console.log("\nResearcher is running in the background.");
      console.log(`  board research status${opts.tag ? ` --tag ${opts.tag}` : ""}  — check progress`);
      console.log("  board feed -c #research    — see findings");
      console.log(`  board diff ${h}     — review changes`);
      console.log(`  board research stop${opts.tag ? ` --tag ${opts.tag}` : ""}   — stop the researcher`);
    }

    db.close();
  });

research
  .command("presets")
  .description("List available metric presets (including custom from .boardrc)")
  .action(() => {
    const { presets, customNames } = loadMergedPresets();
    console.log("Available presets:\n");
    for (const [name, preset] of Object.entries(presets)) {
      const tag = customNames.has(name) ? ` ${c.cyan}[custom]${c.reset}` : "";
      console.log(`  ${name}${tag}`);
      console.log(`    ${preset.description}`);
      console.log(`    eval:      ${preset.eval}`);
      console.log(`    metric:    ${preset.metric}`);
      console.log(`    direction: ${preset.direction}`);
      console.log(`    guard:     ${preset.guard}`);
      console.log();
    }
    console.log("Usage: board research start --preset <name>");
    console.log("Override any field: board research start --preset lean --guard 'npm test'");
  });

research
  .command("stop")
  .description("Stop the auto-research agent")
  .option("--tag <tag>", "Run tag to stop (default: no tag)")
  .action(async (opts: { tag?: string }) => {
    const { initDb } = await import("./db.js");
    const { killAgent } = await import("./spawner.js");

    const db = initDb(process.cwd());
    const handle = opts.tag ? `@researcher-${opts.tag}` : "@researcher";

    try {
      killAgent(db, handle, process.cwd());
      console.log(`Researcher${opts.tag ? ` (${opts.tag})` : ""} stopped.`);
    } catch (err: any) {
      console.error(err.message);
    }

    db.close();
  });

research
  .command("status")
  .description("Show auto-research agent status and recent findings")
  .option("--tag <tag>", "Run tag to check (default: no tag)")
  .action(async (opts: { tag?: string }) => {
    const { initDb } = await import("./db.js");
    const { getSpawn, isProcessAlive } = await import("./spawner.js");
    const { listPosts } = await import("./posts.js");
    const { getChannel } = await import("./channels.js");

    const db = initDb(process.cwd());
    const handle = opts.tag ? `@researcher-${opts.tag}` : "@researcher";

    const spawn = getSpawn(db, handle);
    if (!spawn) {
      console.log(`No researcher${opts.tag ? ` (${opts.tag})` : ""} has been started. Run \`board research start${opts.tag ? ` --tag ${opts.tag}` : ""}\`.`);
      db.close();
      return;
    }

    const alive = !spawn.stopped_at && isProcessAlive(spawn.pid);
    console.log(`Researcher${opts.tag ? ` (${opts.tag})` : ""}: ${alive ? "RUNNING" : "STOPPED"}`);
    console.log(`  PID: ${spawn.pid}`);
    console.log(`  Branch: ${spawn.branch || "(none)"}`);
    console.log(`  Started: ${spawn.started_at}`);
    if (spawn.stopped_at) console.log(`  Stopped: ${spawn.stopped_at}`);

    // Show results.md if it exists in the worktree
    if (spawn.worktree_path) {
      const resultsPath = path.join(spawn.worktree_path, "results.md");
      if (fs.existsSync(resultsPath)) {
        const results = fs.readFileSync(resultsPath, "utf-8").trim();
        const lines = results.split("\n");
        // Count experiments (lines after header row and separator)
        const experiments = lines.filter(l => l.startsWith("|") && !l.includes("commit") && !l.includes("---")).length;
        const kept = lines.filter(l => l.includes("| keep |")).length;
        const discarded = lines.filter(l => l.includes("| discard |")).length;
        const crashed = lines.filter(l => l.includes("| crash |")).length;

        console.log(`\nExperiments: ${experiments} total — ${kept} kept, ${discarded} discarded, ${crashed} crashed`);

        // Show last 5 entries
        const dataLines = lines.filter(l => l.startsWith("|") && !l.includes("commit") && !l.includes("---"));
        const recent = dataLines.slice(-5);
        if (recent.length > 0) {
          console.log("\nRecent experiments:");
          for (const line of recent) {
            console.log(`  ${line}`);
          }
        }
      }
    }

    // Show recent research posts
    if (getChannel(db, "#research")) {
      const posts = listPosts(db, { channel: "#research", limit: 5 });
      if (posts.length > 0) {
        console.log(`\nRecent posts (${posts.length}):`);
        for (const p of posts) {
          const preview = p.content.substring(0, 120).replace(/\n/g, " ");
          console.log(`  ${p.created_at.substring(11, 16)} — ${preview}`);
        }
      }
    }

    // Show diff stats if branch exists
    if (spawn.branch) {
      try {
        const stat = execSync(`git diff --stat main..${spawn.branch}`, {
          cwd: process.cwd(),
          encoding: "utf-8",
          stdio: "pipe",
        });
        if (stat.trim()) {
          console.log(`\nAccumulated changes vs main:`);
          console.log(stat);
        }
      } catch { /* branch may not exist yet */ }
    }

    db.close();
  });

research
  .command("focus <topic>")
  .description("Steer the researcher to focus on a specific area")
  .action(async (topic: string) => {
    const rc = readBoardRC();
    if (!rc) {
      die("No .boardrc found. Run `board init` first.");
    }

    // Post a directive that the researcher will pick up
    await api(rc, "POST", "/api/posts", {
      content: `focus: ${topic}`,
      channel: "#research",
    });
    console.log(`Focus directive posted: "${topic}"`);
    console.log("The researcher will pick this up in its next cycle.");
  });

research
  .command("history")
  .description("Show past research sessions")
  .action(async () => {
    const { initDb } = await import("./db.js");
    const { isProcessAlive } = await import("./spawner.js");

    const db = initDb(process.cwd());

    const spawns = db.prepare(
      "SELECT * FROM spawns WHERE agent_handle LIKE '@researcher%' ORDER BY started_at DESC"
    ).all() as { agent_handle: string; pid: number; log_path: string | null; worktree_path: string | null; branch: string | null; started_at: string; stopped_at: string | null; exit_code: number | null }[];

    const sessions: ResearchSession[] = spawns.map((s) => {
      const tag = s.agent_handle.replace(/^@researcher-?/, "") || "(default)";

      // Try to read results.md from worktree
      let experiments: number | null = null;
      let kept: number | null = null;
      let discarded: number | null = null;

      if (s.worktree_path && fs.existsSync(s.worktree_path)) {
        const resultsPath = path.join(s.worktree_path, "results.md");
        if (fs.existsSync(resultsPath)) {
          const content = fs.readFileSync(resultsPath, "utf-8");
          const lines = content.split("\n");
          const dataLines = lines.filter(l => l.startsWith("|") && !l.includes("commit") && !l.includes("---"));
          experiments = dataLines.length;
          kept = lines.filter(l => l.includes("| keep |")).length;
          discarded = lines.filter(l => l.includes("| discard |")).length;
        }
      }

      return {
        handle: s.agent_handle,
        tag,
        preset: null,
        branch: s.branch,
        started_at: s.started_at,
        stopped_at: s.stopped_at,
        experiments,
        kept,
        discarded,
      };
    });

    console.log(renderResearchHistory(sessions));
    db.close();
  });

// --- board retro ---

program
  .command("retro <sprint-name>")
  .description("Auto-generate sprint retrospective")
  .action(async (sprintName: string) => {
    const { initDb } = await import("./db.js");
    const { getSpawn, isProcessAlive } = await import("./spawner.js");
    const { parseNumstat } = await import("./sprint-orchestrator.js");

    const db = initDb(process.cwd());
    const projectDir = process.cwd();

    // Get sprint
    const sprint = db.prepare("SELECT * FROM sprints WHERE name = ?").get(sprintName) as { name: string; goal: string; status: string; created_at: string; finished_at: string | null } | undefined;
    if (!sprint) {
      db.close();
      die(`Sprint not found: ${sprintName}`);
    }

    // Get sprint agents
    const sprintAgents = db.prepare("SELECT * FROM sprint_agents WHERE sprint_name = ?").all(sprintName) as { sprint_name: string; agent_handle: string; identity_name: string | null; mission: string | null }[];

    const retroAgents: RetroAgent[] = [];
    let totalConflicts = 0;

    for (const sa of sprintAgents) {
      const spawn = getSpawn(db, sa.agent_handle);
      const runtime = spawn ? formatDuration(spawn.started_at, spawn.stopped_at) : "?";
      const exitCode = spawn?.exit_code ?? null;
      const branch = spawn?.branch ?? null;

      let additions = 0, deletions = 0, filesChanged = 0;
      if (branch) {
        const numstat = parseNumstat(projectDir, branch);
        if (numstat) {
          additions = numstat.additions;
          deletions = numstat.deletions;
          filesChanged = numstat.filesChanged;
        }
      }

      retroAgents.push({
        handle: sa.agent_handle,
        branch,
        runtime,
        exitCode,
        filesChanged,
        additions,
        deletions,
      });
    }

    // Count merge conflicts from git log
    try {
      const conflictLog = execSync("git log --all --oneline --grep='conflict' 2>/dev/null || true", {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
      totalConflicts = conflictLog ? conflictLog.split("\n").length : 0;
    } catch { /* ignore */ }

    const retro: RetroData = {
      sprintName: sprint.name,
      goal: sprint.goal,
      created_at: sprint.created_at,
      finished_at: sprint.finished_at,
      agents: retroAgents,
      conflicts: totalConflicts,
      testDelta: null,
    };

    // Generate RETRO.md
    const retroMd = renderRetroMarkdown(retro);
    fs.writeFileSync(path.join(projectDir, "RETRO.md"), retroMd);

    // Print to console
    console.log(renderRetro(retro));
    console.log(`\n  ${c.dim}Written to RETRO.md${c.reset}`);
    db.close();
  });

// If no subcommand given, launch interactive mode
if (process.argv.length <= 2) {
  import("./interactive.js").then((m) => m.startInteractive());
} else {
  program.parseAsync().catch((err: unknown) => {
    if (err instanceof CliError) {
      console.error(err.message);
      process.exit(1);
    }
    // Unexpected error — show stack trace
    console.error(err);
    process.exit(1);
  });
}
