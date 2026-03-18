import { Command } from "commander";
import fs from "fs";
import path from "path";
import { initDb, dbExists, initBoard } from "./db.js";
import { normalizeHandle } from "./agents.js";
import { normalizeChannel } from "./channels.js";
import { parseDuration } from "./supervision.js";
import { readBoardRC, writeBoardRC, api, type BoardRC } from "./boardrc.js";
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
  renderTeam,
  renderTeamList,
  renderRoute,
  renderRouteList,
  renderOrg,
  type SpawnInfo,
} from "./render.js";
import type { Agent, Post, RankedPost, Team, TeamMember, Route } from "./types.js";
import type { BriefingSummary } from "./supervision.js";
import type { PostThread } from "./posts.js";
import { execSync, spawn as nodeSpawn } from "child_process";
import { registerDagCommands } from "./cli-dag.js";
import { registerSprintCommands } from "./cli-sprint.js";
import { registerIdentityCommands } from "./cli-identity.js";
import { registerResearchCommands } from "./cli-research.js";

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
    console.log(`Created channel ${normalizeChannel(name)}`);
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
    const ch = normalizeChannel(name);
    await api(rc, "PUT", `/api/channels/${encodeURIComponent(ch)}/priority`, {
      priority: parseInt(priority, 10),
    });
    console.log(`Set ${ch} priority to ${priority}`);
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
    const ch = normalizeChannel(channelName);

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

// Register extracted command groups
registerDagCommands(program);
registerSprintCommands(program);
registerIdentityCommands(program);
registerResearchCommands(program);

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
