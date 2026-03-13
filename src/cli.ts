import { Command } from "commander";
import fs from "fs";
import path from "path";
import { initDb, dbExists } from "./db.js";
import { generateKey, hashKey } from "./auth.js";
import { parseDuration } from "./supervision.js";
import {
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
  type SpawnInfo,
} from "./render.js";
import type { Agent, DagCommit, Post, RankedPost, Team, TeamMember, Route, SprintValidation, SprintBranch } from "./types.js";
import type { BriefingSummary } from "./supervision.js";
import type { PostThread } from "./posts.js";
import type { DagSummary, PromoteResult } from "./gitdag.js";
import { execSync, spawn as nodeSpawn } from "child_process";

// === .boardrc ===

interface BoardRC {
  url: string;
  key: string;
}

const BOARDRC_FILE = ".boardrc";

function readBoardRC(): BoardRC | null {
  const rcPath = path.join(process.cwd(), BOARDRC_FILE);
  if (!fs.existsSync(rcPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(rcPath, "utf-8"));
  } catch {
    return null;
  }
}

function writeBoardRC(rc: BoardRC): void {
  const rcPath = path.join(process.cwd(), BOARDRC_FILE);
  fs.writeFileSync(rcPath, JSON.stringify(rc, null, 2) + "\n");
}

function requireRC(): BoardRC {
  const rc = readBoardRC();
  if (!rc) {
    console.error("No .boardrc found. Run `board init` first.");
    process.exit(1);
  }
  return rc;
}

// === File tree helper ===

function walkDir(dir: string, base: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      results.push(rel + "/");
      results.push(...walkDir(full, base));
    } else {
      results.push(rel);
    }
  }
  return results;
}

// === HTTP client ===

async function api<T>(
  rc: BoardRC,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: T }> {
  const url = `${rc.url}${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${rc.key}`,
    "Content-Type": "application/json",
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("fetch failed")) {
      console.error(`Cannot connect to server at ${rc.url}. Is \`board serve\` running?`);
      process.exit(1);
    }
    throw err;
  }

  const data = (await res.json()) as T;
  return { ok: res.ok, status: res.status, data };
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
    const db = initDb();

    // Create @admin agent
    db.prepare(
      "INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)"
    ).run("@admin", "Admin", "Board administrator");

    // Create #general channel
    db.prepare(
      "INSERT INTO channels (name, description) VALUES (?, ?)"
    ).run("#general", "General discussion");

    // Generate and store admin API key
    const rawKey = generateKey();
    db.prepare(
      "INSERT INTO api_keys (key_hash, agent_handle) VALUES (?, ?)"
    ).run(hashKey(rawKey), null);

    db.close();

    // Initialize DAG bare repo
    const { initDag } = await import("./gitdag.js");
    initDag(process.cwd());

    // Write .boardrc
    const serverUrl = `http://localhost:${opts.port}`;
    writeBoardRC({ url: serverUrl, key: rawKey });

    // Auto-start the server in the background
    const serverChild = nodeSpawn(process.argv[0], [process.argv[1], "serve", "--port", opts.port], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
    });
    serverChild.unref();

    console.log("Board initialized.");
    console.log(`Admin key: ${rawKey}`);
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

    if (!dbExists()) {
      console.error("No board found. Run `board init` first.");
      process.exit(1);
    }

    const db = getDb();
    const app = createApp(db);
    const port = parseInt(opts.port, 10);

    const server = serve({ fetch: app.fetch, port }, () => {
      console.log(`AgentBoard server listening on http://localhost:${port}`);
    });

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
    const res = await api<Agent & { api_key: string }>(rc, "POST", "/api/agents", {
      handle,
      name: opts.name,
      role: opts.role,
      mission: opts.mission,
    });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(`Created agent ${res.data.handle}`);
    console.log(`API key: ${res.data.api_key}`);
    console.log(renderAgent(res.data));
  });

agent
  .command("list")
  .description("List all agents")
  .option("--status <status>", "Filter by status")
  .action(async (opts: { status?: string }) => {
    const rc = requireRC();
    const qs = opts.status ? `?status=${opts.status}` : "";
    const res = await api<Agent[]>(rc, "GET", `/api/agents${qs}`);
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderAgentList(res.data));
  });

agent
  .command("show <handle>")
  .description("Show agent details")
  .action(async (handle: string) => {
    const rc = requireRC();
    const h = handle.startsWith("@") ? handle : `@${handle}`;
    const res = await api<Agent>(rc, "GET", `/api/agents/${encodeURIComponent(h)}`);
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderAgent(res.data));
  });

agent
  .command("update <handle>")
  .description("Update an agent")
  .option("--name <name>", "New name")
  .option("--mission <mission>", "New mission")
  .option("--status <status>", "New status")
  .action(async (handle: string, opts: { name?: string; mission?: string; status?: string }) => {
    const rc = requireRC();
    const h = handle.startsWith("@") ? handle : `@${handle}`;
    const body: Record<string, string> = {};
    if (opts.name) body.name = opts.name;
    if (opts.mission) body.mission = opts.mission;
    if (opts.status) body.status = opts.status;
    const res = await api<Agent>(rc, "PATCH", `/api/agents/${encodeURIComponent(h)}`, body);
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(`Updated ${res.data.handle}`);
    console.log(renderAgent(res.data));
  });

// --- board channel ---
const channel = program.command("channel").description("Manage channels");

channel
  .command("create <name>")
  .description("Create a new channel")
  .option("--description <desc>", "Channel description")
  .action(async (name: string, opts: { description?: string }) => {
    const rc = requireRC();
    const res = await api(rc, "POST", "/api/channels", {
      name,
      description: opts.description,
    });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(`Created channel ${name.startsWith("#") ? name : "#" + name}`);
  });

channel
  .command("list")
  .description("List all channels")
  .action(async () => {
    const rc = requireRC();
    const res = await api<{ name: string; description: string | null; priority: number }[]>(
      rc, "GET", "/api/channels"
    );
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderChannelList(res.data));
  });

channel
  .command("priority <name> <priority>")
  .description("Set channel priority (supervision config)")
  .action(async (name: string, priority: string) => {
    const rc = requireRC();
    const n = name.startsWith("#") ? name : `#${name}`;
    const res = await api(rc, "PUT", `/api/channels/${encodeURIComponent(n)}/priority`, {
      priority: parseInt(priority, 10),
    });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(`Set ${n} priority to ${priority}`);
  });

// --- board post ---
program
  .command("post <handle> <channel> <content>")
  .description("Create a post as an agent")
  .action(async (handle: string, channelName: string, content: string) => {
    const rc = requireRC();
    const res = await api<Post>(rc, "POST", "/api/posts", {
      author: handle,
      channel: channelName,
      content,
    });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(`Posted ${res.data.id.slice(0, 8)} by ${res.data.author} in ${res.data.channel}`);
  });

// --- board reply ---
program
  .command("reply <post-id> <handle> <content>")
  .description("Reply to a post")
  .action(async (postId: string, handle: string, content: string) => {
    const rc = requireRC();
    // Get the parent post to find its channel
    const parent = await api<Post>(rc, "GET", `/api/posts/${postId}`);
    if (!parent.ok) {
      console.error(`Error: parent post not found`);
      process.exit(1);
    }
    const res = await api<Post>(rc, "POST", "/api/posts", {
      author: handle,
      channel: parent.data.channel,
      content,
      parent_id: postId,
    });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(`Reply ${res.data.id.slice(0, 8)} by ${res.data.author}`);
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
        console.error(`Invalid duration: ${opts.since}. Use format like 1h, 30m, 2d`);
        process.exit(1);
      }
      params.set("since", ts);
    }
    params.set("limit", opts.limit);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await api<RankedPost[]>(rc, "GET", `/api/feed${qs}`);
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderFeed(res.data));
  });

// --- board briefing ---
program
  .command("briefing")
  .description("Show what happened since your last briefing")
  .action(async () => {
    const rc = requireRC();
    const res = await api<BriefingSummary>(rc, "GET", "/api/briefing");
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderBriefing(res.data));
  });

// --- board direct ---
program
  .command("direct <handle> <channel> <message>")
  .description("Post a directive as @admin (auto-threads to agent's latest post)")
  .action(async (handle: string, channelName: string, message: string) => {
    const rc = requireRC();
    const h = handle.startsWith("@") ? handle : `@${handle}`;
    const ch = channelName.startsWith("#") ? channelName : `#${channelName}`;

    // Find agent's latest post in that channel to thread onto
    const postsRes = await api<Post[]>(
      rc, "GET",
      `/api/posts?author=${encodeURIComponent(h)}&channel=${encodeURIComponent(ch)}&top_level=true&limit=1`
    );

    let parentId: string | undefined;
    if (postsRes.ok && postsRes.data.length > 0) {
      parentId = postsRes.data[0].id;
    }

    const res = await api<Post>(rc, "POST", "/api/posts", {
      author: "@admin",
      channel: ch,
      content: message,
      parent_id: parentId,
    });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    const threaded = parentId ? ` (threaded to ${parentId.slice(0, 8)})` : "";
    console.log(`Directive ${res.data.id.slice(0, 8)} → ${h} in ${ch}${threaded}`);
  });

// --- board thread ---
program
  .command("thread <post-id>")
  .description("Show a post thread")
  .action(async (postId: string) => {
    const rc = requireRC();
    const res = await api<PostThread>(rc, "GET", `/api/posts/${postId}/thread`);
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderThread(res.data));
  });

// --- board profile ---
program
  .command("profile <handle>")
  .description("Show an agent's profile and posts")
  .action(async (handle: string) => {
    const rc = requireRC();
    const h = handle.startsWith("@") ? handle : `@${handle}`;

    // Fetch agent and posts in parallel
    const [agentRes, postsRes] = await Promise.all([
      api<Agent>(rc, "GET", `/api/agents/${encodeURIComponent(h)}`),
      api<Post[]>(rc, "GET", `/api/posts?author=${encodeURIComponent(h)}&limit=20`),
    ]);

    if (!agentRes.ok) {
      console.error(`Agent ${h} not found`);
      process.exit(1);
    }

    console.log(renderProfile(agentRes.data, postsRes.ok ? postsRes.data : []));
  });

// --- board commit ---
program
  .command("commit <hash> <post-id>")
  .description("Link a git commit to a post")
  .option("--files <files...>", "Files changed")
  .action(async (hash: string, postId: string, opts: { files?: string[] }) => {
    const rc = requireRC();
    const res = await api(rc, "POST", "/api/commits", {
      hash,
      post_id: postId,
      files: opts.files,
    });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
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
    const res = await api<Agent & { api_key: string }>(rc, "POST", "/api/agents", {
      handle,
      name: opts.name,
      mission: opts.mission,
    });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }

    const { spawnAgent } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();

    // If identity specified, read identity file and prepend to mission
    let mission = opts.mission;
    if (opts.identity) {
      const identityPath = path.join(process.cwd(), "identities", `${opts.identity}.md`);
      if (!fs.existsSync(identityPath)) {
        console.error(`Identity not found: ${opts.identity}`);
        console.error(`Available identities: board identity list`);
        db.close();
        process.exit(1);
      }
      const identityContent = fs.readFileSync(identityPath, "utf-8");
      mission = `[Identity: ${opts.identity}]\n${identityContent}\n\n${opts.mission}`;
    }

    try {
      const result = spawnAgent(db, {
        handle: res.data.handle,
        mission,
        apiKey: res.data.api_key,
        serverUrl: rc.url,
        projectDir: process.cwd(),
        foreground: opts.foreground,
      });

      if (opts.foreground) {
        console.log(`Running ${res.data.handle} in foreground (PID ${result.pid})`);
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
        console.log(`Spawned ${res.data.handle} (PID ${result.pid})`);
        console.log(`  Branch:   ${result.branch}`);
        console.log(`  Worktree: ${result.worktreePath}`);
        console.log(`  Logs:     ${result.worktreePath}/agent.log`);
        db.close();
      }
    } catch (err: any) {
      console.error(`Spawn failed: ${err.message}`);
      db.close();
      process.exit(1);
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
    const h = handle.startsWith("@") ? handle : `@${handle}`;

    try {
      killAgent(db, h, process.cwd());
      console.log(`Killed ${h}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
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
        const res = await api<RankedPost[]>(rc, "GET", "/api/feed?limit=20");
        if (res.ok) {
          // Clear screen and move cursor to top
          process.stdout.write("\x1b[2J\x1b[H");
          const now = new Date().toLocaleTimeString();
          console.log(`\x1b[1mAgentBoard Feed\x1b[0m  \x1b[90m${now}  (Ctrl+C to exit)\x1b[0m\n`);
          console.log(renderFeed(res.data));
        }
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

    const [agentsRes, channelsRes, feedRes] = await Promise.all([
      api<Agent[]>(rc, "GET", "/api/agents"),
      api<{ name: string; description: string | null; priority: number }[]>(rc, "GET", "/api/channels"),
      api<RankedPost[]>(rc, "GET", "/api/feed?limit=0"),
    ]);

    // Get spawn info from local DB
    const { listSpawns, isProcessAlive } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();
    const spawns = listSpawns(db);
    db.close();

    const agents = agentsRes.ok ? agentsRes.data : [];
    const channels = channelsRes.ok ? channelsRes.data : [];

    const spawnInfos: SpawnInfo[] = spawns.map((s) => ({
      agent_handle: s.agent_handle,
      pid: s.pid,
      started_at: s.started_at,
      stopped_at: s.stopped_at,
      alive: s.stopped_at ? false : isProcessAlive(s.pid),
    }));

    // Count posts via feed endpoint (total)
    const postsRes = await api<Post[]>(rc, "GET", "/api/posts?limit=0");
    const postCount = postsRes.ok ? postsRes.data.length : 0;

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
    const h = handle.startsWith("@") ? handle : `@${handle}`;

    try {
      const result = mergeAgent(db, h, process.cwd(), { cleanup: opts.cleanup });
      console.log(`Merged ${result.branch} into main (${result.mergedCommits} commit${result.mergedCommits !== 1 ? "s" : ""})`);
      if (result.worktreeRemoved) {
        console.log(`Cleaned up worktree and branch`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
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
    const h = handle.startsWith("@") ? handle : `@${handle}`;

    const spawn = getSpawn(db, h);
    db.close();

    if (!spawn) {
      console.error(`No spawn record for ${h}`);
      process.exit(1);
    }
    if (!spawn.log_path || !fs.existsSync(spawn.log_path)) {
      console.error(`Log file not found: ${spawn.log_path}`);
      process.exit(1);
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
      console.error("tmux not found. Install it: brew install tmux");
      process.exit(1);
    }

    const { listSpawns, isProcessAlive } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();

    const spawns = listSpawns(db, true).filter((s) => isProcessAlive(s.pid));
    db.close();

    if (spawns.length === 0) {
      console.error("No active agents. Spawn some first with `board spawn`.");
      process.exit(1);
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
    const [commitsRes, leavesRes] = await Promise.all([
      api<DagCommit[]>(rc, "GET", `/api/git/commits?limit=200${opts.agent ? `&agent=${encodeURIComponent(opts.agent)}` : ""}`),
      api<DagCommit[]>(rc, "GET", `/api/git/leaves${opts.agent ? `?agent=${encodeURIComponent(opts.agent)}` : ""}`),
    ]);
    if (!commitsRes.ok) {
      console.error(`Error: ${(commitsRes.data as any).error}`);
      process.exit(1);
    }
    const leafSet = new Set((leavesRes.ok ? leavesRes.data : []).map((l) => l.hash));
    console.log(renderDagTree(commitsRes.data, leafSet));
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
    const res = await api<DagCommit[]>(rc, "GET", `/api/git/commits?${params.toString()}`);
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderDagLog(res.data));
  });

dag
  .command("leaves")
  .description("Show active exploration frontiers (leaf commits)")
  .option("--agent <handle>", "Filter by agent")
  .action(async (opts: { agent?: string }) => {
    const rc = requireRC();
    const qs = opts.agent ? `?agent=${encodeURIComponent(opts.agent)}` : "";
    const res = await api<DagCommit[]>(rc, "GET", `/api/git/leaves${qs}`);
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    if (res.data.length === 0) {
      console.log("  No leaves (DAG is empty).");
    } else {
      console.log(`${res.data.length} active frontier${res.data.length !== 1 ? "s" : ""}:\n`);
      console.log(renderDagLog(res.data));
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
        console.error(`Error: ${(err as any).error}`);
        process.exit(1);
      }
      console.log(await res.text());
    } catch (err: any) {
      console.error(`Cannot connect to server: ${err.message}`);
      process.exit(1);
    }
  });

dag
  .command("promote <hash>")
  .description("Promote a DAG commit to main (cherry-pick)")
  .action(async (hash: string) => {
    const rc = requireRC();
    const res = await api<PromoteResult>(rc, "POST", "/api/git/promote", { hash });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderPromoteSummary(res.data));
  });

dag
  .command("summary")
  .description("Show DAG summary")
  .action(async () => {
    const rc = requireRC();
    const res = await api<DagSummary>(rc, "GET", "/data/dag");
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderDagSummary(res.data));
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
    const res = await api<Team>(rc, "POST", "/api/teams", {
      name,
      manager: opts.manager,
      mission: opts.mission,
    });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(`Created team ${res.data.name}`);
    console.log(renderTeam(res.data));
  });

team
  .command("list")
  .description("List all teams")
  .action(async () => {
    const rc = requireRC();
    const res = await api<Team[]>(rc, "GET", "/api/teams");
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderTeamList(res.data));
  });

team
  .command("show <name>")
  .description("Show team details")
  .action(async (name: string) => {
    const rc = requireRC();
    const res = await api<Team & { members?: TeamMember[] }>(
      rc, "GET", `/api/teams/${encodeURIComponent(name)}`
    );
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderTeam(res.data));
  });

team
  .command("add <name> <handle>")
  .description("Add a member to a team")
  .action(async (name: string, handle: string) => {
    const rc = requireRC();
    const h = handle.startsWith("@") ? handle : `@${handle}`;
    const res = await api<TeamMember>(
      rc, "POST", `/api/teams/${encodeURIComponent(name)}/members`, { agent_handle: h }
    );
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(`Added ${h} to team ${name}`);
  });

team
  .command("remove <name> <handle>")
  .description("Remove a member from a team")
  .action(async (name: string, handle: string) => {
    const rc = requireRC();
    const h = handle.startsWith("@") ? handle : `@${handle}`;
    const res = await api(
      rc, "DELETE", `/api/teams/${encodeURIComponent(name)}/members/${encodeURIComponent(h)}`
    );
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
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
    const res = await api<Route>(rc, "POST", "/api/routes", {
      name,
      team_name: opts.team,
      agent_handle: opts.agent,
    });
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(`Created route ${res.data.name}`);
    console.log(renderRoute(res.data));
  });

route
  .command("list")
  .description("List all routes")
  .option("--team <team>", "Filter by team")
  .action(async (opts: { team?: string }) => {
    const rc = requireRC();
    const qs = opts.team ? `?team=${encodeURIComponent(opts.team)}` : "";
    const res = await api<Route[]>(rc, "GET", `/api/routes${qs}`);
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(renderRouteList(res.data));
  });

route
  .command("update <id>")
  .description("Update a route")
  .option("--status <status>", "New status (exploring, chosen, abandoned)")
  .action(async (id: string, opts: { status?: string }) => {
    const rc = requireRC();
    const body: Record<string, string> = {};
    if (opts.status) body.status = opts.status;
    const res = await api<Route>(rc, "PATCH", `/api/routes/${encodeURIComponent(id)}`, body);
    if (!res.ok) {
      console.error(`Error: ${(res.data as any).error}`);
      process.exit(1);
    }
    console.log(`Updated route ${res.data.name}`);
    console.log(renderRoute(res.data));
  });

// --- board org ---
program
  .command("org")
  .description("Bird's-eye view of all teams and routes")
  .action(async () => {
    const rc = requireRC();
    const [teamsRes, routesRes] = await Promise.all([
      api<(Team & { members?: TeamMember[] })[]>(rc, "GET", "/api/teams?include=members"),
      api<Route[]>(rc, "GET", "/api/routes"),
    ]);
    if (!teamsRes.ok) {
      console.error(`Error: ${(teamsRes.data as any).error}`);
      process.exit(1);
    }
    console.log(renderOrg(
      teamsRes.ok ? teamsRes.data : [],
      routesRes.ok ? routesRes.data : [],
    ));
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
    const h = handle.startsWith("@") ? handle : `@${handle}`;

    const spawn = getSpawn(db, h);
    db.close();

    if (!spawn) {
      console.error(`No spawn record for ${h}`);
      process.exit(1);
    }
    if (!spawn.branch) {
      console.error(`No branch recorded for ${h}`);
      process.exit(1);
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
      console.error(`Error running git diff: ${err.message}`);
      process.exit(1);
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
    const h = handle.startsWith("@") ? handle : `@${handle}`;

    const spawn = getSpawn(db, h);
    db.close();

    if (!spawn) {
      console.error(`No spawn record for ${h}`);
      process.exit(1);
    }
    if (!spawn.log_path || !fs.existsSync(spawn.log_path)) {
      console.error(`Log file not found: ${spawn.log_path}`);
      process.exit(1);
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
    const { listSpawns, isProcessAlive } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();

    const spawns = listSpawns(db);
    db.close();

    // 1. Check all spawned agents are stopped
    const allStopped = spawns.every((s) => s.stopped_at !== null || !isProcessAlive(s.pid));
    if (!allStopped) {
      const running = spawns.filter((s) => !s.stopped_at && isProcessAlive(s.pid));
      console.log(`⚠ Running agents: ${running.map((s) => s.agent_handle).join(", ")}`);
    } else {
      console.log("All agents stopped.");
    }

    // 2. Run npm test
    let testsPass = false;
    console.log("\nRunning tests...");
    try {
      execSync("npm test", { cwd: process.cwd(), stdio: "inherit" });
      testsPass = true;
      console.log("Tests passed.");
    } catch {
      console.log("Tests failed.");
    }

    // 3. Show git diff --stat for each agent branch and collect file changes
    const branches: SprintBranch[] = [];
    const filesByBranch = new Map<string, Set<string>>();

    for (const s of spawns) {
      if (!s.branch) continue;
      try {
        const stat = execSync(`git diff --stat main..${s.branch}`, {
          cwd: process.cwd(),
          encoding: "utf-8",
          stdio: "pipe",
        });
        console.log(`\n--- ${s.agent_handle} (${s.branch}) ---`);
        console.log(stat || "(no changes)");

        // Parse numstat for structured data
        const numstat = execSync(`git diff --numstat main..${s.branch}`, {
          cwd: process.cwd(),
          encoding: "utf-8",
          stdio: "pipe",
        }).trim();

        let filesChanged = 0;
        let additions = 0;
        let deletions = 0;
        const files = new Set<string>();

        if (numstat) {
          for (const line of numstat.split("\n")) {
            const parts = line.split("\t");
            if (parts.length >= 3) {
              additions += parseInt(parts[0], 10) || 0;
              deletions += parseInt(parts[1], 10) || 0;
              files.add(parts[2]);
              filesChanged++;
            }
          }
        }

        filesByBranch.set(s.agent_handle, files);
        branches.push({
          agent_handle: s.agent_handle,
          branch: s.branch,
          filesChanged,
          additions,
          deletions,
        });
      } catch {
        console.log(`\n--- ${s.agent_handle} (${s.branch}) --- (branch not found)`);
      }
    }

    // 4. Detect file conflicts (files changed by multiple branches)
    const fileCounts = new Map<string, string[]>();
    for (const [handle, files] of filesByBranch) {
      for (const file of files) {
        if (!fileCounts.has(file)) fileCounts.set(file, []);
        fileCounts.get(file)!.push(handle);
      }
    }
    const conflicts: string[] = [];
    for (const [file, agents] of fileCounts) {
      if (agents.length > 1) {
        conflicts.push(`${file} (${agents.join(", ")})`);
      }
    }

    if (conflicts.length > 0) {
      console.log("\nConflicts detected:");
      for (const c of conflicts) {
        console.log(`  - ${c}`);
      }
    } else {
      console.log("\nNo file conflicts detected.");
    }

    // 5. Suggest merge order: fewest files first (less likely to conflict)
    const suggestedOrder = [...branches]
      .sort((a, b) => a.filesChanged - b.filesChanged)
      .map((b) => b.agent_handle);

    if (suggestedOrder.length > 0) {
      console.log("\nSuggested merge order:");
      suggestedOrder.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
    }

    const validation: SprintValidation = {
      allStopped,
      testsPass,
      branches,
      conflicts: conflicts.map((c) => c.split(" (")[0]), // just file names
      suggestedOrder,
    };

    // Output JSON for programmatic use
    console.log("\n" + JSON.stringify(validation, null, 2));
  });

// --- board sprint ---
const sprint = program.command("sprint").description("Sprint planning and execution");

sprint
  .command("suggest <goal>")
  .description("Generate an LLM prompt for sprint planning based on src/ tree and available identities")
  .action(async (goal: string) => {
    // 1. Read file tree of src/
    const srcDir = path.join(process.cwd(), "src");
    let fileTree: string[] = [];
    if (fs.existsSync(srcDir)) {
      fileTree = walkDir(srcDir, process.cwd());
    }

    // 2. Read identities from identities/ folder
    const identitiesDir = path.join(process.cwd(), "identities");
    const agents: { name: string; description: string }[] = [];
    if (fs.existsSync(identitiesDir)) {
      const files = fs.readdirSync(identitiesDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const content = fs.readFileSync(path.join(identitiesDir, file), "utf-8");
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
    }

    // 3. Output formatted prompt
    const prompt = `You are a sprint planner for a software project.

## Goal
${goal}

## Source Tree
\`\`\`
${fileTree.join("\n")}
\`\`\`

## Available Agents
${agents.map((a) => `- **${a.name}**: ${a.description}`).join("\n")}

## Instructions
Break the goal into parallel tasks. Assign each task to an agent whose expertise matches.
Ensure scopes are disjoint — no file should appear in two agents' scopes.

Respond with the following JSON schema:

\`\`\`json
{
  "goal": "string — the sprint goal",
  "tasks": [
    {
      "agent": "string — agent identity name",
      "handle": "string — @handle for the agent",
      "mission": "string — detailed task description",
      "scope": ["string — file paths this agent owns"]
    }
  ]
}
\`\`\`
`;
    console.log(prompt);
  });

sprint
  .command("start")
  .description("Start a sprint from a plan file, spawning agents with disjoint scopes")
  .requiredOption("--plan <path>", "Path to JSON sprint plan file")
  .action(async (opts: { plan: string }) => {
    const rc = requireRC();
    const planPath = path.resolve(opts.plan);

    if (!fs.existsSync(planPath)) {
      console.error(`Plan file not found: ${planPath}`);
      process.exit(1);
    }

    let plan: { goal: string; tasks: { agent: string; handle: string; mission: string; scope: string[] }[] };
    try {
      plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    } catch (err: any) {
      console.error(`Invalid JSON in plan file: ${err.message}`);
      process.exit(1);
    }

    if (!plan.tasks || !Array.isArray(plan.tasks)) {
      console.error("Plan must contain a 'tasks' array.");
      process.exit(1);
    }

    // Validate scopes are disjoint
    const fileOwners = new Map<string, string>();
    const overlaps: string[] = [];
    for (const task of plan.tasks) {
      for (const file of task.scope ?? []) {
        const existing = fileOwners.get(file);
        if (existing) {
          overlaps.push(`${file} claimed by both ${existing} and ${task.handle}`);
        } else {
          fileOwners.set(file, task.handle);
        }
      }
    }

    if (overlaps.length > 0) {
      console.error("Scope overlap detected — aborting:");
      for (const o of overlaps) {
        console.error(`  - ${o}`);
      }
      process.exit(1);
    }

    console.log(`Starting sprint: ${plan.goal}`);
    console.log(`Tasks: ${plan.tasks.length}, scopes disjoint ✓\n`);

    const { spawnAgent } = await import("./spawner.js");
    const { getDb } = await import("./db.js");
    const db = getDb();

    for (const task of plan.tasks) {
      const handle = task.handle.startsWith("@") ? task.handle.slice(1) : task.handle;

      // Create agent via API
      const res = await api<any>(rc, "POST", "/api/agents", {
        handle,
        name: task.agent,
        mission: task.mission,
      });
      if (!res.ok) {
        console.error(`Error creating ${handle}: ${(res.data as any).error}`);
        continue;
      }

      // Read identity if available
      let mission = task.mission;
      if (task.scope && task.scope.length > 0) {
        mission += `\n\nYour scope (files you own):\n${task.scope.map((f) => `- ${f}`).join("\n")}`;
      }

      const identityPath = path.join(process.cwd(), "identities", `${task.agent}.md`);
      if (fs.existsSync(identityPath)) {
        const identityContent = fs.readFileSync(identityPath, "utf-8");
        mission = `[Identity: ${task.agent}]\n${identityContent}\n\n${mission}`;
      }

      try {
        const result = spawnAgent(db, {
          handle: res.data.handle,
          mission,
          apiKey: res.data.api_key,
          serverUrl: rc.url,
          projectDir: process.cwd(),
        });
        console.log(`Spawned ${res.data.handle} (PID ${result.pid}) → ${result.branch}`);
      } catch (err: any) {
        console.error(`Spawn failed for ${handle}: ${err.message}`);
      }
    }

    db.close();
  });

// --- board steer ---
program
  .command("steer <handle> [message]")
  .description("Send a directive to a running agent, or clear directives with --clear")
  .option("--clear", "Clear all directives for this agent")
  .action(async (handle: string, message: string | undefined, opts: { clear?: boolean }) => {
    const h = handle.startsWith("@") ? handle : `@${handle}`;
    const projectDir = process.cwd();

    if (opts.clear) {
      const { clearDirectives } = await import("./spawner.js");
      try {
        clearDirectives(projectDir, h);
        console.log(`Cleared directives for ${h}`);
      } catch (err: any) {
        console.error(err.message);
        process.exit(1);
      }
      return;
    }

    if (!message) {
      console.error("Message is required (or use --clear)");
      process.exit(1);
    }

    // Write directive to agent's CLAUDE.md Active Directives section
    const { writeDirective } = await import("./spawner.js");
    try {
      writeDirective(projectDir, h, message);
      console.log(`Wrote directive to ${h}`);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
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
      console.error(`Identity not found: ${name}`);
      process.exit(1);
    }
    console.log(fs.readFileSync(identityPath, "utf-8"));
  });

// If no subcommand given, launch interactive mode
if (process.argv.length <= 2) {
  import("./interactive.js").then((m) => m.startInteractive());
} else {
  program.parse();
}
