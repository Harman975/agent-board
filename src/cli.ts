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
} from "./render.js";
import type { Agent, Post, RankedPost } from "./types.js";
import type { BriefingSummary } from "./supervision.js";
import type { PostThread } from "./posts.js";

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

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

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
  .action((opts: { port: string }) => {
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

    // Write .boardrc
    writeBoardRC({ url: `http://localhost:${opts.port}`, key: rawKey });

    console.log("Board initialized.");
    console.log(`Admin key: ${rawKey}`);
    console.log("Saved to .boardrc — keep this file secure.");
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
  .action(async (handle: string, opts: { mission: string; name?: string }) => {
    const rc = requireRC();
    const res = await api<Agent & { api_key: string }>(rc, "POST", "/api/agents", {
      handle,
      name: opts.name,
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

program.parse();
