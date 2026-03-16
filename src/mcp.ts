import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { spawn as nodeSpawn } from "child_process";
import { getDb, dbExists, initBoard } from "./db.js";
import { normalizeHandle } from "./agents.js";
import { readBoardRC, writeBoardRC, type BoardRC } from "./boardrc.js";
import {
  startSprint,
  uniqueSprintName,
  buildLandingBrief,
  buildSprintReport,
  mergeWithTestGates,
  type AgentSpec,
} from "./sprint-orchestrator.js";
import {
  listSpawns,
  isProcessAlive,
  getSpawn,
  killAgent,
  writeDirective,
} from "./spawner.js";
import { getFeed, getBriefing } from "./supervision.js";
import { decompose } from "./decomposer.js";
import type { Sprint, SprintAgent, RankedPost } from "./types.js";
import type Database from "better-sqlite3";

// ============================================================
//  AgentBoard MCP Server
//
//  Exposes board operations as typed MCP tools.
//  Any MCP-compatible client (Claude Code, Cursor, Windsurf)
//  auto-discovers these tools and can invoke them natively.
//
//  Transport: stdio (spawned as subprocess by the client)
//  Config:    .mcp.json at project root
// ============================================================

const PROJECT_DIR = process.cwd();

// === Lazy singletons ===

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (!_db) _db = getDb(PROJECT_DIR);
  return _db;
}

let _rc: BoardRC | null = null;
async function rc(): Promise<BoardRC> {
  if (_rc) return _rc;

  let existing = readBoardRC(PROJECT_DIR);
  if (!dbExists(PROJECT_DIR) || !existing) {
    const { adminKey } = initBoard(PROJECT_DIR);
    existing = { url: "http://localhost:3141", key: adminKey };
    writeBoardRC(existing, PROJECT_DIR);
  }

  // Auto-start server if not running
  try {
    const res = await fetch(`${existing.url}/api/agents`, {
      headers: { Authorization: `Bearer ${existing.key}` },
    });
    if (res.ok) {
      _rc = existing;
      return _rc;
    }
  } catch {
    // Server not running — start it
  }

  const logPath = path.join(PROJECT_DIR, ".board-server.log");
  const logFd = fs.openSync(logPath, "a");
  const cliPath = path.join(import.meta.dirname, "cli.js");

  const child = nodeSpawn(process.execPath, [cliPath, "serve"], {
    cwd: PROJECT_DIR,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);

  existing.serverPid = child.pid!;
  writeBoardRC(existing, PROJECT_DIR);

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`${existing.url}/api/agents`, {
        headers: { Authorization: `Bearer ${existing.key}` },
      });
      if (res.ok) break;
    } catch {
      // Not ready yet
    }
  }

  _rc = existing;
  return _rc;
}

// === Tool definitions ===

const TOOLS = [
  {
    name: "board_init",
    description:
      "Initialize AgentBoard in the current project. Creates the database, admin agent, and starts the server. Idempotent — safe to call if already initialized.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "board_sprint_suggest",
    description:
      "Analyze the codebase and decompose a goal into parallel agent tasks. Returns a plan with agent handles, missions, and file scopes. Does NOT start the sprint — use board_sprint_start after reviewing the plan.",
    inputSchema: {
      type: "object" as const,
      properties: {
        goal: { type: "string", description: "What to accomplish (e.g. 'add rate limiting to the API')" },
      },
      required: ["goal"],
    },
  },
  {
    name: "board_sprint_start",
    description:
      "Start a sprint by spawning agents in isolated worktrees. Call board_sprint_suggest first to get the task plan, then pass it here. Each agent runs as a background Claude Code subprocess.",
    inputSchema: {
      type: "object" as const,
      properties: {
        goal: { type: "string", description: "Sprint goal" },
        name: { type: "string", description: "Sprint name (auto-generated if omitted)" },
        tasks: {
          type: "array",
          description: "Agent tasks from board_sprint_suggest",
          items: {
            type: "object",
            properties: {
              handle: { type: "string", description: "Agent handle (e.g. @auth-agent)" },
              identity: { type: "string", description: "Identity template name" },
              mission: { type: "string", description: "Agent's mission" },
              scope: {
                type: "array",
                items: { type: "string" },
                description: "File paths this agent can modify",
              },
            },
            required: ["handle", "mission"],
          },
        },
      },
      required: ["goal", "tasks"],
    },
  },
  {
    name: "board_sprint_status",
    description:
      "Show the current status of a sprint — which agents are running, finished, or failed, with runtime and file change stats.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Sprint name (defaults to latest running sprint)" },
      },
      required: [],
    },
  },
  {
    name: "board_sprint_land",
    description:
      "Build a landing brief for a sprint. Shows each agent's status, test results, files changed, and merge readiness. Read-only — does not merge. Use board_sprint_merge to actually merge.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Sprint name (defaults to latest running sprint)" },
      },
      required: [],
    },
  },
  {
    name: "board_sprint_merge",
    description:
      "Merge passing agents from a sprint into main. Runs tests after each merge. Only merges agents whose tests pass.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Sprint name" },
        handles: {
          type: "array",
          items: { type: "string" },
          description: "Specific agent handles to merge (merges all passing if omitted)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "board_ps",
    description: "List all spawned agents with their PID, status (alive/stopped), runtime, and branch.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "board_kill",
    description: "Stop a running agent by handle.",
    inputSchema: {
      type: "object" as const,
      properties: {
        handle: { type: "string", description: "Agent handle (e.g. @auth-agent)" },
      },
      required: ["handle"],
    },
  },
  {
    name: "board_steer",
    description:
      "Send a directive to a running agent. The directive is appended to the agent's CLAUDE.md in its worktree, steering its behavior.",
    inputSchema: {
      type: "object" as const,
      properties: {
        handle: { type: "string", description: "Agent handle" },
        message: { type: "string", description: "Directive message" },
      },
      required: ["handle", "message"],
    },
  },
  {
    name: "board_logs",
    description: "Read the last N lines of an agent's log file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        handle: { type: "string", description: "Agent handle" },
        lines: { type: "number", description: "Number of lines to read (default: 50)" },
      },
      required: ["handle"],
    },
  },
  {
    name: "board_feed",
    description: "Get the priority-ranked activity feed — posts from all agents, sorted by importance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max posts to return (default: 20)" },
      },
      required: [],
    },
  },
  {
    name: "board_briefing",
    description:
      "Get a briefing of what changed since the last check — new posts, agent status changes, sprint updates. The CEO's 'what did I miss?' command.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// === Tool handlers ===

async function handleTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "board_init": {
      await rc(); // triggers init + server start
      const boardRC = readBoardRC(PROJECT_DIR)!;
      return JSON.stringify({
        initialized: true,
        serverUrl: boardRC.url,
        serverPid: boardRC.serverPid,
      });
    }

    case "board_sprint_suggest": {
      const goal = args.goal as string;
      const result = await decompose(goal, PROJECT_DIR);
      return JSON.stringify({
        goal: result.goal,
        taskCount: result.tasks.length,
        tasks: result.tasks.map((t) => ({
          handle: t.handle,
          identity: t.agent,
          mission: t.mission,
          scope: t.scope,
        })),
      });
    }

    case "board_sprint_start": {
      await rc(); // ensure server running
      const goal = args.goal as string;
      const tasks = args.tasks as AgentSpec[];
      const sprintName = (args.name as string) || uniqueSprintName(goal, db());

      const spawnDetails: { handle: string; pid: number; branch: string }[] = [];
      const result = await startSprint({
        name: sprintName,
        goal,
        specs: tasks,
        projectDir: PROJECT_DIR,
        serverUrl: (await rc()).url,
        db: db(),
        onSpawn: (handle, pid, branch) => {
          spawnDetails.push({ handle, pid, branch });
        },
      });

      return JSON.stringify({
        sprintName,
        goal,
        agentCount: result.spawned.length,
        agents: spawnDetails,
      });
    }

    case "board_sprint_status": {
      let sprintName = args.name as string | undefined;
      if (!sprintName) {
        const row = db()
          .prepare(
            "SELECT name FROM sprints WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
          )
          .get() as { name: string } | undefined;
        if (!row) return JSON.stringify({ error: "No active sprints" });
        sprintName = row.name;
      }

      const report = await buildSprintReport(sprintName, PROJECT_DIR);
      return JSON.stringify(report);
    }

    case "board_sprint_land": {
      let sprintName = args.name as string | undefined;
      if (!sprintName) {
        const row = db()
          .prepare(
            "SELECT name FROM sprints WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
          )
          .get() as { name: string } | undefined;
        if (!row) return JSON.stringify({ error: "No active sprints" });
        sprintName = row.name;
      }

      const brief = await buildLandingBrief(sprintName, PROJECT_DIR);
      return JSON.stringify(brief);
    }

    case "board_sprint_merge": {
      const sprintName = args.name as string;
      let handles = args.handles as string[] | undefined;

      if (!handles) {
        // Merge all passing agents
        const brief = await buildLandingBrief(sprintName, PROJECT_DIR);
        handles = brief.agents
          .filter((a: { status: string }) => a.status === "passed")
          .map((a: { handle: string }) => a.handle);
      }

      if (handles.length === 0) {
        return JSON.stringify({ error: "No passing agents to merge" });
      }

      const result = await mergeWithTestGates(handles, PROJECT_DIR, { db: db() });

      db()
        .prepare(
          "UPDATE sprints SET status = 'finished', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE name = ?"
        )
        .run(sprintName);

      return JSON.stringify({
        sprintName,
        merged: result.merged,
        failed: result.failed,
      });
    }

    case "board_ps": {
      const spawns = listSpawns(db());
      return JSON.stringify(
        spawns.map((s) => ({
          handle: s.agent_handle,
          pid: s.pid,
          alive: !s.stopped_at && isProcessAlive(s.pid),
          branch: s.branch,
          started_at: s.started_at,
          stopped_at: s.stopped_at,
          exit_code: s.exit_code,
        }))
      );
    }

    case "board_kill": {
      const handle = normalizeHandle(args.handle as string);
      killAgent(db(), handle, PROJECT_DIR);
      return JSON.stringify({ killed: true, handle });
    }

    case "board_steer": {
      const handle = normalizeHandle(args.handle as string);
      const message = args.message as string;
      writeDirective(PROJECT_DIR, handle, message);
      return JSON.stringify({ sent: true, handle, message });
    }

    case "board_logs": {
      const handle = normalizeHandle(args.handle as string);
      const lineCount = (args.lines as number) || 50;
      const spawn = getSpawn(db(), handle);

      if (!spawn) return JSON.stringify({ error: `No spawn record for ${handle}` });
      if (!spawn.log_path || !fs.existsSync(spawn.log_path)) {
        return JSON.stringify({ error: "Log file not found" });
      }

      const content = fs.readFileSync(spawn.log_path, "utf-8");
      const lines = content.split("\n").slice(-lineCount).join("\n");
      return JSON.stringify({ handle, lines: lineCount, log: lines });
    }

    case "board_feed": {
      const limit = (args.limit as number) || 20;
      const posts = getFeed(db(), { limit });
      return JSON.stringify({ count: posts.length, posts });
    }

    case "board_briefing": {
      const summary = getBriefing(db());
      return JSON.stringify(summary);
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// === Server setup ===

const server = new Server(
  { name: "agentboard", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, (args as Record<string, unknown>) ?? {});
    return { content: [{ type: "text", text: result }] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
  }
});

// === Start ===

const transport = new StdioServerTransport();
await server.connect(transport);
