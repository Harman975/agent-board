import { execSync, spawn as nodeSpawn, type ChildProcess } from "child_process";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { createPost } from "./posts.js";
import { createChannel, getChannel } from "./channels.js";
import { normalizeHandle } from "./agents.js";

// === Types ===

export interface SpawnRecord {
  agent_handle: string;
  pid: number;
  log_path: string | null;
  worktree_path: string | null;
  branch: string | null;
  started_at: string;
  stopped_at: string | null;
}

export interface SpawnOptions {
  handle: string;
  mission: string;
  apiKey: string;
  serverUrl: string;
  projectDir: string;
  foreground?: boolean;
}

// Executor interface for dependency injection (testability)
export type Executor = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdio: any; detached?: boolean }
) => ChildProcess;

const defaultExecutor: Executor = (command, args, opts) => {
  return nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: opts.stdio,
    detached: opts.detached ?? true,
  });
};

// === Worktree management ===

/*
 *  SPAWN FLOW:
 *  ──────────
 *  1. Ensure #status channel exists
 *  2. Create git worktree: .worktrees/@handle → branch agent/handle
 *  3. Write CLAUDE.md into worktree with API instructions + mission
 *  4. Spawn claude subprocess in worktree
 *  5. Record spawn in DB (pid, paths, branch)
 *  6. Post "starting" to #status
 *  7. On exit: post "finished"/"crashed" to #status, mark stopped
 */

function ensureWorktreeDir(projectDir: string): string {
  const dir = path.join(projectDir, ".worktrees");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function createWorktree(projectDir: string, handle: string): { worktreePath: string; branch: string } {
  const cleanHandle = handle.replace(/^@/, "");
  const branch = `agent/${cleanHandle}`;
  const worktreeDir = ensureWorktreeDir(projectDir);
  const worktreePath = path.join(worktreeDir, handle);

  if (fs.existsSync(worktreePath)) {
    // Worktree already exists — reuse it
    return { worktreePath, branch };
  }

  // Check if branch exists
  try {
    execSync(`git rev-parse --verify ${branch}`, { cwd: projectDir, stdio: "pipe" });
    // Branch exists, create worktree from it
    execSync(`git worktree add "${worktreePath}" ${branch}`, { cwd: projectDir, stdio: "pipe" });
  } catch {
    // Branch doesn't exist, create new one
    execSync(`git worktree add -b ${branch} "${worktreePath}"`, { cwd: projectDir, stdio: "pipe" });
  }

  return { worktreePath, branch };
}

function removeWorktree(projectDir: string, worktreePath: string): void {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: projectDir, stdio: "pipe" });
  } catch {
    // Best effort cleanup
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }
}

// === CLAUDE.md generation ===

function generateAgentClaudeMd(opts: {
  handle: string;
  mission: string;
  apiKey: string;
  serverUrl: string;
}): string {
  return `# DO NOT COMMIT — contains API key

# AgentBoard Agent Instructions

You are ${opts.handle}, an AI agent coordinated via AgentBoard.

## Your Mission
${opts.mission}

## Board API

Server: ${opts.serverUrl}
Your API Key: ${opts.apiKey}

### Post an update to #work
\`\`\`bash
curl -s -X POST ${opts.serverUrl}/api/posts \\
  -H "Authorization: Bearer ${opts.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"content":"<your update>","channel":"#work"}'
\`\`\`

### Post an escalation (when blocked)
\`\`\`bash
curl -s -X POST ${opts.serverUrl}/api/posts \\
  -H "Authorization: Bearer ${opts.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"content":"BLOCKED: <reason>","channel":"#escalations"}'
\`\`\`

### Check for directives from @admin
\`\`\`bash
curl -s "${opts.serverUrl}/api/posts?author=%40admin&limit=5" \\
  -H "Authorization: Bearer ${opts.apiKey}"
\`\`\`

## Protocol
1. Post to #work when you start, make progress, or finish a subtask
2. Post to #escalations if you are blocked and need human input
3. Check for @admin directives periodically (every few steps)
4. When done, post a summary of what you accomplished to #work
5. Commit your work to this branch with clear commit messages
`;
}

// === Ensure channels ===

function ensureStatusChannel(db: Database.Database): void {
  if (!getChannel(db, "#status")) {
    createChannel(db, { name: "status", description: "Agent lifecycle status" });
  }
}

function ensureWorkChannels(db: Database.Database): void {
  ensureStatusChannel(db);
  if (!getChannel(db, "#work")) {
    createChannel(db, { name: "work", description: "Agent work updates" });
  }
  if (!getChannel(db, "#escalations")) {
    createChannel(db, { name: "escalations", description: "Blocked agents needing attention" });
  }
}

// === Spawn DB operations ===

export function insertSpawn(db: Database.Database, record: Omit<SpawnRecord, "started_at" | "stopped_at">): void {
  db.prepare(`
    INSERT INTO spawns (agent_handle, pid, log_path, worktree_path, branch)
    VALUES (?, ?, ?, ?, ?)
  `).run(record.agent_handle, record.pid, record.log_path, record.worktree_path, record.branch);
}

export function markSpawnStopped(db: Database.Database, handle: string): void {
  handle = normalizeHandle(handle);
  db.prepare(`
    UPDATE spawns SET stopped_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE agent_handle = ? AND stopped_at IS NULL
  `).run(handle);
}

export function getSpawn(db: Database.Database, handle: string): SpawnRecord | null {
  handle = normalizeHandle(handle);
  return db.prepare("SELECT * FROM spawns WHERE agent_handle = ?").get(handle) as SpawnRecord | undefined ?? null;
}

export function listSpawns(db: Database.Database, activeOnly = false): SpawnRecord[] {
  if (activeOnly) {
    return db.prepare("SELECT * FROM spawns WHERE stopped_at IS NULL ORDER BY started_at DESC").all() as SpawnRecord[];
  }
  return db.prepare("SELECT * FROM spawns ORDER BY started_at DESC").all() as SpawnRecord[];
}

// === PID verification ===

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isClaudeProcess(pid: number): boolean {
  try {
    const output = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8", stdio: "pipe" }).trim();
    return output.toLowerCase().includes("claude");
  } catch {
    return false;
  }
}

// === Core spawn/kill ===

export function spawnAgent(
  db: Database.Database,
  opts: SpawnOptions,
  executor: Executor = defaultExecutor
): { pid: number; worktreePath: string; branch: string; child?: ChildProcess } {
  const handle = normalizeHandle(opts.handle);

  // Ensure required channels exist
  ensureWorkChannels(db);

  // Check claude is available
  try {
    execSync("which claude", { stdio: "pipe" });
  } catch {
    throw new Error("Claude Code CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-code");
  }

  // Create worktree
  const { worktreePath, branch } = createWorktree(opts.projectDir, handle);

  // Write CLAUDE.md into worktree
  const claudeMd = generateAgentClaudeMd({
    handle,
    mission: opts.mission,
    apiKey: opts.apiKey,
    serverUrl: opts.serverUrl,
  });
  fs.writeFileSync(path.join(worktreePath, "CLAUDE.md"), claudeMd);

  const foreground = opts.foreground ?? false;

  // Create log file (not used in foreground mode)
  const logPath = foreground ? null : path.join(worktreePath, "agent.log");
  const logStream = logPath ? fs.openSync(logPath, "a") : null;

  // Spawn claude subprocess
  const child = executor(
    "claude",
    ["--dangerously-skip-permissions", "-p", `Begin your mission: ${opts.mission}`],
    {
      cwd: worktreePath,
      env: {
        BOARD_URL: opts.serverUrl,
        BOARD_KEY: opts.apiKey,
        BOARD_AGENT: handle,
      },
      stdio: foreground ? "inherit" : ["ignore", logStream!, logStream!],
      detached: !foreground,
    }
  );

  const pid = child.pid!;

  // Record spawn
  insertSpawn(db, {
    agent_handle: handle,
    pid,
    log_path: logPath,
    worktree_path: worktreePath,
    branch,
  });

  // Auto-status: starting
  createPost(db, {
    author: handle,
    channel: "#status",
    content: `Starting: ${opts.mission}`,
  });

  // Handle process exit
  child.on("exit", (code) => {
    if (logStream !== null) fs.closeSync(logStream);
    markSpawnStopped(db, handle);
    try {
      if (code === 0) {
        createPost(db, { author: handle, channel: "#status", content: "Finished" });
      } else {
        createPost(db, { author: handle, channel: "#status", content: `Crashed — exit code ${code}` });
      }
    } catch {
      // DB may be closed if server is shutting down
    }
  });

  // In background mode, unref so parent process can exit
  if (!foreground) {
    child.unref();
  }

  return { pid, worktreePath, branch, child: foreground ? child : undefined };
}

export function killAgent(
  db: Database.Database,
  handle: string,
  projectDir: string
): void {
  handle = normalizeHandle(handle);
  const spawn = getSpawn(db, handle);
  if (!spawn) {
    throw new Error(`No spawn record for ${handle}`);
  }
  if (spawn.stopped_at) {
    throw new Error(`${handle} is already stopped`);
  }

  const pid = spawn.pid;

  if (!isProcessAlive(pid)) {
    // Already dead — just mark stopped
    markSpawnStopped(db, handle);
    return;
  }

  // Verify it's actually a claude process before killing
  if (!isClaudeProcess(pid)) {
    throw new Error(`PID ${pid} is not a claude process — refusing to kill (possible PID recycling)`);
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err: any) {
    if (err.code !== "ESRCH") throw err;
  }

  markSpawnStopped(db, handle);

  // Auto-status: stopped
  try {
    createPost(db, { author: handle, channel: "#status", content: "Stopped by operator" });
  } catch {
    // Agent might not exist anymore
  }
}
