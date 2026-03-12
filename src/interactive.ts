import readline from "readline";
import fs from "fs";
import path from "path";
import { spawn as nodeSpawn } from "child_process";
import { initDb, dbExists, getDb } from "./db.js";
import { generateKey, hashKey } from "./auth.js";
import {
  renderFeed,
  renderSpawnList,
  renderBriefing,
  type SpawnInfo,
} from "./render.js";
import type { RankedPost } from "./types.js";
import type { BriefingSummary } from "./supervision.js";
import type Database from "better-sqlite3";

// === ANSI helpers ===

const useColor = !process.env.NO_COLOR;
const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  green: useColor ? "\x1b[32m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  gray: useColor ? "\x1b[90m" : "",
  red: useColor ? "\x1b[31m" : "",
};

// === .boardrc ===

interface BoardRC {
  url: string;
  key: string;
  serverPid?: number;
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

// === API helper ===

async function api<T>(
  rc: BoardRC,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(`${rc.url}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${rc.key}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T;
  return { ok: res.ok, status: res.status, data };
}

// === Server management ===

async function isServerRunning(rc: BoardRC): Promise<boolean> {
  try {
    const res = await fetch(`${rc.url}/api/agents`, {
      headers: { Authorization: `Bearer ${rc.key}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function startServerBackground(rc: BoardRC): number {
  const logPath = path.join(process.cwd(), ".board-server.log");
  const logFd = fs.openSync(logPath, "a");

  // Find the compiled cli.js next to this file (both live in dist/)
  const cliPath = path.join(import.meta.dirname, "cli.js");

  const child = nodeSpawn(
    process.execPath,
    [cliPath, "serve"],
    {
      cwd: process.cwd(),
      stdio: ["ignore", logFd, logFd],
      detached: true,
      env: process.env,
    }
  );

  child.unref();
  fs.closeSync(logFd);

  // Save PID to .boardrc
  rc.serverPid = child.pid!;
  writeBoardRC(rc);

  return child.pid!;
}

// === Readline helpers ===

function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function clear() {
  process.stdout.write("\x1b[2J\x1b[H");
}

// === Init + Server setup ===

async function ensureReady(): Promise<BoardRC> {
  let rc = readBoardRC();

  // Init if needed
  if (!dbExists() || !rc) {
    console.log(`${c.yellow}Initializing board...${c.reset}`);
    const db = initDb();

    db.prepare(
      "INSERT INTO agents (handle, name, mission) VALUES (?, ?, ?)"
    ).run("@admin", "Admin", "Board administrator");

    db.prepare(
      "INSERT INTO channels (name, description) VALUES (?, ?)"
    ).run("#general", "General discussion");

    const rawKey = generateKey();
    db.prepare(
      "INSERT INTO api_keys (key_hash, agent_handle) VALUES (?, ?)"
    ).run(hashKey(rawKey), null);

    db.close();

    rc = { url: "http://localhost:3141", key: rawKey };
    writeBoardRC(rc);
    console.log(`${c.green}Board initialized.${c.reset}\n`);
  }

  // Start server if not running
  if (!(await isServerRunning(rc))) {
    console.log(`${c.yellow}Starting server...${c.reset}`);
    const pid = startServerBackground(rc);

    // Wait for server to be ready
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await isServerRunning(rc)) {
        console.log(`${c.green}Server running${c.reset} ${c.dim}(PID ${pid}, port 3141)${c.reset}\n`);
        return rc;
      }
    }
    console.error(`${c.red}Server failed to start. Check .board-server.log${c.reset}`);
    process.exit(1);
  }

  return rc;
}

// === Menu actions ===
// All actions receive a shared long-lived DB connection so that
// spawned child process exit handlers can still write to it.

async function actionSpawn(rc: BoardRC, rl: readline.Interface, db: Database.Database) {
  const handle = await ask(rl, `  ${c.green}Handle:${c.reset}  @`);
  if (!handle) return;
  const mission = await ask(rl, `  ${c.green}Mission:${c.reset} `);
  if (!mission) return;

  const h = handle.startsWith("@") ? handle : `@${handle}`;

  // Create agent via API
  const res = await api<any>(rc, "POST", "/api/agents", {
    handle: h,
    mission,
  });
  if (!res.ok) {
    console.log(`\n  ${c.red}Error: ${(res.data as any).error}${c.reset}\n`);
    return;
  }

  // Spawn subprocess
  const { spawnAgent } = await import("./spawner.js");
  try {
    const result = spawnAgent(db, {
      handle: res.data.handle,
      mission,
      apiKey: res.data.api_key,
      serverUrl: rc.url,
      projectDir: process.cwd(),
    });
    console.log(`\n  ${c.green}Spawned ${res.data.handle}${c.reset} ${c.dim}PID ${result.pid}${c.reset}`);
    console.log(`  ${c.dim}Branch: ${result.branch}${c.reset}`);
    console.log(`  ${c.dim}Worktree: ${result.worktreePath}${c.reset}\n`);
  } catch (err: any) {
    console.log(`\n  ${c.red}Spawn failed: ${err.message}${c.reset}\n`);
  }
}

async function actionRespawn(rc: BoardRC, rl: readline.Interface, db: Database.Database) {
  // Show stopped agents
  const { listSpawns, isProcessAlive, respawnAgent } = await import("./spawner.js");
  const spawns = listSpawns(db).filter((s) => s.stopped_at || !isProcessAlive(s.pid));

  if (spawns.length === 0) {
    console.log(`\n  ${c.dim}No stopped agents to respawn.${c.reset}\n`);
    return;
  }

  console.log();
  spawns.forEach((s, i) => {
    console.log(`  ${c.bold}${i + 1}${c.reset} ${c.dim}·${c.reset} ${c.green}${s.agent_handle}${c.reset} ${c.dim}(${s.branch})${c.reset}`);
  });
  console.log();

  const pick = await ask(rl, `  ${c.green}Pick agent (number):${c.reset} `);
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= spawns.length) return;

  const chosen = spawns[idx];
  const newMission = await ask(rl, `  ${c.dim}New mission (enter to keep previous):${c.reset} `);

  try {
    const result = respawnAgent(db, chosen.agent_handle, {
      mission: newMission || undefined,
      serverUrl: rc.url,
      projectDir: process.cwd(),
    });
    console.log(`\n  ${c.green}Respawned ${chosen.agent_handle}${c.reset} ${c.dim}PID ${result.pid}${c.reset}`);
    console.log(`  ${c.dim}Branch: ${result.branch}${c.reset}`);
    console.log(`  ${c.dim}Worktree: ${result.worktreePath}${c.reset}\n`);
  } catch (err: any) {
    console.log(`\n  ${c.red}${err.message}${c.reset}\n`);
  }
}

async function actionFeed(rc: BoardRC) {
  const res = await api<RankedPost[]>(rc, "GET", "/api/feed?limit=20");
  if (res.ok) {
    console.log();
    console.log(res.data.length > 0 ? renderFeed(res.data) : `  ${c.dim}No posts yet.${c.reset}`);
    console.log();
  }
}

async function actionPS(db: Database.Database) {
  const { listSpawns, isProcessAlive } = await import("./spawner.js");
  const spawns = listSpawns(db);

  if (spawns.length === 0) {
    console.log(`\n  ${c.dim}No agents spawned yet.${c.reset}\n`);
    return;
  }

  const infos: SpawnInfo[] = spawns.map((s) => ({
    agent_handle: s.agent_handle,
    pid: s.pid,
    started_at: s.started_at,
    stopped_at: s.stopped_at,
    alive: s.stopped_at ? false : isProcessAlive(s.pid),
  }));

  console.log();
  console.log(renderSpawnList(infos));
  console.log();
}

async function actionKill(rl: readline.Interface, db: Database.Database) {
  const handle = await ask(rl, `  ${c.green}Handle to kill:${c.reset} @`);
  if (!handle) return;

  const h = handle.startsWith("@") ? handle : `@${handle}`;
  const { killAgent } = await import("./spawner.js");

  try {
    killAgent(db, h, process.cwd());
    console.log(`\n  ${c.green}Killed ${h}${c.reset}\n`);
  } catch (err: any) {
    console.log(`\n  ${c.red}${err.message}${c.reset}\n`);
  }
}

async function actionMerge(rl: readline.Interface, db: Database.Database) {
  const handle = await ask(rl, `  ${c.green}Handle to merge:${c.reset} @`);
  if (!handle) return;

  const h = handle.startsWith("@") ? handle : `@${handle}`;
  const cleanup = await ask(rl, `  ${c.dim}Clean up worktree after merge? (y/n):${c.reset} `);

  const { mergeAgent } = await import("./spawner.js");

  try {
    const result = mergeAgent(db, h, process.cwd(), { cleanup: cleanup.toLowerCase() === "y" });
    console.log(`\n  ${c.green}Merged ${result.branch}${c.reset} ${c.dim}(${result.mergedCommits} commit${result.mergedCommits !== 1 ? "s" : ""})${c.reset}`);
    if (result.worktreeRemoved) {
      console.log(`  ${c.dim}Cleaned up worktree and branch${c.reset}`);
    }
    console.log();
  } catch (err: any) {
    console.log(`\n  ${c.red}${err.message}${c.reset}\n`);
  }
}

async function actionBriefing(rc: BoardRC) {
  const res = await api<BriefingSummary>(rc, "GET", "/api/briefing");
  if (res.ok) {
    console.log();
    console.log(renderBriefing(res.data));
    console.log();
  }
}

async function actionLogs(rl: readline.Interface, db: Database.Database) {
  const handle = await ask(rl, `  ${c.green}Handle:${c.reset} @`);
  if (!handle) return;

  const h = handle.startsWith("@") ? handle : `@${handle}`;
  const { getSpawn } = await import("./spawner.js");
  const spawn = getSpawn(db, h);

  if (!spawn) {
    console.log(`\n  ${c.red}No spawn record for ${h}${c.reset}\n`);
    return;
  }
  if (!spawn.log_path || !fs.existsSync(spawn.log_path)) {
    console.log(`\n  ${c.red}Log file not found${c.reset}\n`);
    return;
  }

  const content = fs.readFileSync(spawn.log_path, "utf-8");
  const lines = content.split("\n").slice(-30).join("\n");
  console.log(`\n${lines}\n`);
}

async function actionPost(rc: BoardRC, rl: readline.Interface) {
  const channel = await ask(rl, `  ${c.cyan}Channel:${c.reset} #`);
  if (!channel) return;
  const content = await ask(rl, `  ${c.dim}Message:${c.reset}  `);
  if (!content) return;

  const ch = channel.startsWith("#") ? channel : `#${channel}`;
  const res = await api<any>(rc, "POST", "/api/posts", {
    author: "@admin",
    channel: ch,
    content,
  });
  if (res.ok) {
    console.log(`\n  ${c.green}Posted${c.reset} ${c.dim}${res.data.id.slice(0, 8)}${c.reset}\n`);
  } else {
    console.log(`\n  ${c.red}Error: ${(res.data as any).error}${c.reset}\n`);
  }
}

// === Main menu ===

function showMenu() {
  console.log(`  ${c.bold}1${c.reset} ${c.dim}·${c.reset} Spawn agent`);
  console.log(`  ${c.bold}2${c.reset} ${c.dim}·${c.reset} Respawn agent`);
  console.log(`  ${c.bold}3${c.reset} ${c.dim}·${c.reset} View feed`);
  console.log(`  ${c.bold}4${c.reset} ${c.dim}·${c.reset} Agent status`);
  console.log(`  ${c.bold}5${c.reset} ${c.dim}·${c.reset} Kill agent`);
  console.log(`  ${c.bold}6${c.reset} ${c.dim}·${c.reset} Merge branch`);
  console.log(`  ${c.bold}7${c.reset} ${c.dim}·${c.reset} Briefing`);
  console.log(`  ${c.bold}8${c.reset} ${c.dim}·${c.reset} Logs`);
  console.log(`  ${c.bold}9${c.reset} ${c.dim}·${c.reset} Post as @admin`);
  console.log(`  ${c.bold}q${c.reset} ${c.dim}·${c.reset} Quit`);
  console.log();
}

async function showHeader(rc: BoardRC, db: Database.Database) {
  let agentCount = 0;
  let postInfo = "";
  try {
    const agents = await api<any[]>(rc, "GET", "/api/agents");
    if (agents.ok) agentCount = agents.data.length;
    const feed = await api<any[]>(rc, "GET", "/api/feed?limit=0");
    if (feed.ok) postInfo = `${c.dim}${feed.data.length} posts${c.reset}`;
  } catch {
    // Server might be starting up
  }

  const { listSpawns, isProcessAlive } = await import("./spawner.js");
  const active = listSpawns(db, true).filter((s) => isProcessAlive(s.pid));

  console.log(`  ${c.bold}AgentBoard${c.reset} ${c.dim}v0.2.0${c.reset}`);
  console.log(`  ${c.dim}${agentCount} agents${c.reset}  ${postInfo}  ${active.length > 0 ? `${c.green}${active.length} running${c.reset}` : `${c.dim}0 running${c.reset}`}`);
  console.log();
}

export async function startInteractive() {
  clear();
  const rc = await ensureReady();

  // Single long-lived DB connection for the entire session.
  // This is critical: spawned child processes register exit handlers
  // that write to the DB — closing it early causes crashes.
  const db = getDb();

  const rl = createRL();

  // Clean up on exit
  const cleanup = () => {
    db.close();
    rl.close();
  };
  process.on("SIGINT", () => {
    console.log(`\n  ${c.dim}Server still running in background. Run \`board\` to reconnect.${c.reset}\n`);
    cleanup();
    process.exit(0);
  });

  clear();
  await showHeader(rc, db);
  showMenu();

  const loop = async () => {
    const choice = await ask(rl, `  ${c.bold}>${c.reset} `);

    switch (choice) {
      case "1":
        await actionSpawn(rc, rl, db);
        break;
      case "2":
        await actionRespawn(rc, rl, db);
        break;
      case "3":
        await actionFeed(rc);
        break;
      case "4":
        await actionPS(db);
        break;
      case "5":
        await actionKill(rl, db);
        break;
      case "6":
        await actionMerge(rl, db);
        break;
      case "7":
        await actionBriefing(rc);
        break;
      case "8":
        await actionLogs(rl, db);
        break;
      case "9":
        await actionPost(rc, rl);
        break;
      case "q":
      case "Q":
        console.log(`\n  ${c.dim}Server still running in background. Run \`board\` to reconnect.${c.reset}\n`);
        cleanup();
        process.exit(0);
      case "":
        // Just show menu again
        clear();
        await showHeader(rc, db);
        showMenu();
        break;
      default:
        console.log(`\n  ${c.dim}Unknown option. Pick 1-9 or q.${c.reset}\n`);
    }

    loop();
  };

  loop();
}
