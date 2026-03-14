import { execSync, spawn as nodeSpawn, type ChildProcess } from "child_process";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { createPost } from "./posts.js";
import { createChannel, getChannel } from "./channels.js";
import { normalizeHandle, getAgent } from "./agents.js";
import { generateKey, storeKey } from "./auth.js";
import type { Identity } from "./types.js";

// === Types ===

export interface SpawnRecord {
  agent_handle: string;
  pid: number;
  log_path: string | null;
  worktree_path: string | null;
  branch: string | null;
  started_at: string;
  stopped_at: string | null;
  exit_code: number | null;
}

export interface SpawnOptions {
  handle: string;
  mission: string;
  apiKey: string;
  serverUrl: string;
  projectDir: string;
  foreground?: boolean;
  identity?: Identity;
  scope?: string[];
}

// Executor interface for dependency injection (testability)
export type Executor = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdio: any; detached?: boolean }
) => ChildProcess;

const defaultExecutor: Executor = (command, args, opts) => {
  // Strip CLAUDECODE env var to allow nested Claude Code sessions
  const { CLAUDECODE, ...parentEnv } = process.env;
  return nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: { ...parentEnv, ...opts.env },
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

  // Symlink node_modules from project root so agents can run tests/builds
  const nodeModulesSrc = path.join(projectDir, "node_modules");
  const nodeModulesDst = path.join(worktreePath, "node_modules");
  if (fs.existsSync(nodeModulesSrc) && !fs.existsSync(nodeModulesDst)) {
    fs.symlinkSync(nodeModulesSrc, nodeModulesDst, "dir");
  }

  return { worktreePath, branch };
}

/**
 * Install a pre-commit hook in a worktree that enforces file scope.
 * Scope is read from the ## File Scope section of CLAUDE.md at commit time.
 * - If CLAUDE.md is missing: reject (fail-closed)
 * - If CLAUDE.md exists but has no File Scope section: allow all
 * - If File Scope section exists: only allow listed files
 */
export function installScopeHook(worktreePath: string): void {
  // Worktrees have .git as a file with "gitdir: <path>", not a directory
  const dotGit = path.join(worktreePath, ".git");
  let hooksDir: string;

  if (fs.statSync(dotGit).isFile()) {
    const content = fs.readFileSync(dotGit, "utf-8").trim();
    const gitDir = content.replace(/^gitdir:\s*/, "");
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreePath, gitDir);
    hooksDir = path.join(resolvedGitDir, "hooks");
  } else {
    hooksDir = path.join(dotGit, "hooks");
  }

  fs.mkdirSync(hooksDir, { recursive: true });

  const hookScript = `#!/bin/bash
# Scope enforcement hook — installed by AgentBoard
set -e

CLAUDE_MD="$(git rev-parse --show-toplevel)/CLAUDE.md"

# Fail-closed: if CLAUDE.md is missing, reject
if [ ! -f "$CLAUDE_MD" ]; then
  echo "ERROR: CLAUDE.md not found — rejecting commit (fail-closed)" >&2
  exit 1
fi

# Extract File Scope section
SCOPE_SECTION=$(sed -n '/^## File Scope$/,/^## /{ /^## File Scope$/d; /^## /d; p; }' "$CLAUDE_MD")

# If no File Scope section, allow all commits
if [ -z "$SCOPE_SECTION" ]; then
  exit 0
fi

# Parse allowed files from bullet list (lines starting with "- ")
ALLOWED_FILES=$(echo "$SCOPE_SECTION" | grep '^- ' | sed 's/^- //')

# Check each staged file
STAGED=$(git diff --cached --name-only)
for FILE in $STAGED; do
  FOUND=0
  for ALLOWED in $ALLOWED_FILES; do
    if [ "$FILE" = "$ALLOWED" ]; then
      FOUND=1
      break
    fi
  done
  if [ "$FOUND" = "0" ]; then
    echo "ERROR: File '$FILE' is outside of allowed scope." >&2
    echo "Allowed files:" >&2
    echo "$ALLOWED_FILES" >&2
    exit 1
  fi
done

exit 0
`;

  const hookPath = path.join(hooksDir, "pre-commit");
  fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
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
  identityContent?: string;
  scope?: string[];
}): string {
  const identitySection = opts.identityContent
    ? `## Identity\n\n${opts.identityContent}\n\n`
    : "";

  const scopeSection = opts.scope && opts.scope.length > 0
    ? `\n## File Scope\n\nYou are only allowed to modify the following files:\n${opts.scope.map(f => `- ${f}`).join("\n")}\n\nIf you need changes outside this scope, post to #escalations and wait for approval.\n`
    : "";

  return `# DO NOT COMMIT — contains API key

# AgentBoard Agent Instructions

You are ${opts.handle}, an AI agent coordinated via AgentBoard.

${identitySection}## Your Mission
${opts.mission}
${scopeSection}
## Active Directives

No active directives.

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

### Push work to the DAG (after committing)
\`\`\`bash
git bundle create work.bundle HEAD
curl -s -X POST ${opts.serverUrl}/api/git/push \\
  -H "Authorization: Bearer ${opts.apiKey}" \\
  -F "bundle=@work.bundle" \\
  -F "message=<describe what changed>"
rm work.bundle
\`\`\`

## Protocol
1. Post to #work when you start, make progress, or finish a subtask
2. Post to #escalations if you are blocked and need human input
3. Check for @admin directives periodically (every few steps)
4. When done, post a summary of what you accomplished to #work
5. Commit your work to this branch with clear commit messages
6. Push bundles to the DAG after significant commits so your work is visible
`;
}

// === Ensure channels ===

function ensureWorkChannels(db: Database.Database): void {
  for (const [name, desc] of [["status", "Agent lifecycle status"], ["work", "Agent work updates"], ["escalations", "Blocked agents needing attention"]] as const) {
    if (!getChannel(db, `#${name}`)) createChannel(db, { name, description: desc });
  }
}

// === Spawn DB operations ===

export function insertSpawn(db: Database.Database, record: Omit<SpawnRecord, "started_at" | "stopped_at">): void {
  db.prepare(`
    INSERT INTO spawns (agent_handle, pid, log_path, worktree_path, branch)
    VALUES (?, ?, ?, ?, ?)
  `).run(record.agent_handle, record.pid, record.log_path, record.worktree_path, record.branch);
}

export function updateSpawn(db: Database.Database, record: Omit<SpawnRecord, "started_at" | "stopped_at">): void {
  db.prepare(`
    UPDATE spawns SET pid = ?, log_path = ?, worktree_path = ?, branch = ?,
      started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), stopped_at = NULL
    WHERE agent_handle = ?
  `).run(record.pid, record.log_path, record.worktree_path, record.branch, record.agent_handle);
}

export function markSpawnStopped(db: Database.Database, handle: string, exitCode?: number | null): void {
  handle = normalizeHandle(handle);
  db.prepare(`
    UPDATE spawns SET stopped_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      exit_code = ?
    WHERE agent_handle = ? AND stopped_at IS NULL
  `).run(exitCode ?? null, handle);
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
  return _spawnProcess(db, { ...opts, isRespawn: false }, executor);
}

/**
 * Respawn a stopped agent. Reuses existing agent record and worktree.
 * Generates a new API key since the original is not recoverable (hashed).
 */
export function respawnAgent(
  db: Database.Database,
  handle: string,
  opts: { mission?: string; serverUrl: string; projectDir: string; foreground?: boolean },
  executor: Executor = defaultExecutor
): { pid: number; worktreePath: string; branch: string; child?: ChildProcess } {
  handle = normalizeHandle(handle);

  const agent = getAgent(db, handle);
  if (!agent) {
    throw new Error(`Agent ${handle} not found`);
  }

  const spawn = getSpawn(db, handle);
  if (spawn && !spawn.stopped_at) {
    if (isProcessAlive(spawn.pid)) {
      throw new Error(`${handle} is already running (PID ${spawn.pid})`);
    }
    // Process is dead but not marked — mark it now
    markSpawnStopped(db, handle);
  }

  const mission = opts.mission ?? agent.mission;

  // Generate new API key for this agent
  const apiKey = generateKey();
  storeKey(db, apiKey, handle);

  // Reuse spawnAgent — it handles worktree reuse, CLAUDE.md, subprocess, DB record
  // But we need to update (not insert) the spawn record if one exists
  const result = _spawnProcess(db, {
    handle,
    mission,
    apiKey,
    serverUrl: opts.serverUrl,
    projectDir: opts.projectDir,
    foreground: opts.foreground,
    isRespawn: !!spawn,
  }, executor);

  return result;
}

// Internal shared spawn logic used by both spawnAgent and respawnAgent
function _spawnProcess(
  db: Database.Database,
  opts: SpawnOptions & { isRespawn?: boolean },
  executor: Executor
): { pid: number; worktreePath: string; branch: string; child?: ChildProcess } {
  const handle = normalizeHandle(opts.handle);

  ensureWorkChannels(db);

  try {
    execSync("which claude", { stdio: "pipe" });
  } catch {
    throw new Error("Claude Code CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-code");
  }

  const { worktreePath, branch } = createWorktree(opts.projectDir, handle);

  const claudeMd = generateAgentClaudeMd({
    handle,
    mission: opts.mission,
    apiKey: opts.apiKey,
    serverUrl: opts.serverUrl,
    identityContent: opts.identity?.content,
    scope: opts.scope,
  });
  fs.writeFileSync(path.join(worktreePath, "CLAUDE.md"), claudeMd);

  // Install scope enforcement hook
  installScopeHook(worktreePath);

  const foreground = opts.foreground ?? false;
  const logPath = foreground ? null : path.join(worktreePath, "agent.log");
  const logStream = logPath ? fs.openSync(logPath, "a") : null;

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

  if (!child.pid) {
    if (logStream !== null) fs.closeSync(logStream);
    throw new Error(`Failed to spawn claude for ${handle} — is claude installed and on PATH?`);
  }
  const pid = child.pid;

  // Listen for spawn errors (e.g., ENOENT when claude binary not found)
  child.on("error", (err) => {
    if (logStream !== null) try { fs.closeSync(logStream); } catch { /* ignore */ }
    markSpawnStopped(db, handle, 1);
    try {
      createPost(db, { author: handle, channel: "#status", content: `Spawn error: ${err.message}` });
    } catch { /* DB may be closed */ }
  });

  // Insert or update spawn record
  if (opts.isRespawn) {
    updateSpawn(db, {
      agent_handle: handle,
      pid,
      log_path: logPath,
      worktree_path: worktreePath,
      branch,
    });
  } else {
    insertSpawn(db, {
      agent_handle: handle,
      pid,
      log_path: logPath,
      worktree_path: worktreePath,
      branch,
    });
  }

  createPost(db, {
    author: handle,
    channel: "#status",
    content: `Starting: ${opts.mission}`,
  });

  child.on("exit", (code) => {
    if (logStream !== null) try { fs.closeSync(logStream); } catch { /* ignore */ }
    markSpawnStopped(db, handle, code);
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

  if (!foreground) {
    child.unref();
  }

  return { pid, worktreePath, branch, child: foreground ? child : undefined };
}

// === Directive management ===

const DIRECTIVES_HEADER = "## Active Directives";
const DIRECTIVES_EMPTY = "No active directives.";

function getWorktreeClaudeMdPath(projectDir: string, handle: string): string {
  handle = normalizeHandle(handle);
  const worktreePath = path.join(projectDir, ".worktrees", handle);
  return path.join(worktreePath, "CLAUDE.md");
}

export function writeDirective(projectDir: string, handle: string, directive: string): void {
  const claudeMdPath = getWorktreeClaudeMdPath(projectDir, handle);
  if (!fs.existsSync(claudeMdPath)) {
    throw new Error(`CLAUDE.md not found for ${handle} at ${claudeMdPath}`);
  }

  let content = fs.readFileSync(claudeMdPath, "utf-8");
  const headerIdx = content.indexOf(DIRECTIVES_HEADER);
  if (headerIdx === -1) {
    throw new Error(`Active Directives section not found in CLAUDE.md for ${handle}`);
  }

  const timestamp = new Date().toISOString();
  const entry = `- [${timestamp}] ${directive}`;

  // Find the section content between header and next ## section
  const afterHeader = headerIdx + DIRECTIVES_HEADER.length;
  const nextSection = content.indexOf("\n## ", afterHeader);
  const sectionEnd = nextSection === -1 ? content.length : nextSection;
  const sectionContent = content.slice(afterHeader, sectionEnd);

  // Build new section content: remove "No active directives." if present, append new directive
  const existingDirectives = sectionContent
    .split("\n")
    .filter(line => line.startsWith("- ["))
    .join("\n");

  const newSectionContent = existingDirectives
    ? `\n\n${existingDirectives}\n${entry}\n`
    : `\n\n${entry}\n`;

  content = content.slice(0, afterHeader) + newSectionContent + content.slice(sectionEnd);
  fs.writeFileSync(claudeMdPath, content);
}

export function clearDirectives(projectDir: string, handle: string): void {
  const claudeMdPath = getWorktreeClaudeMdPath(projectDir, handle);
  if (!fs.existsSync(claudeMdPath)) {
    throw new Error(`CLAUDE.md not found for ${handle} at ${claudeMdPath}`);
  }

  let content = fs.readFileSync(claudeMdPath, "utf-8");
  const headerIdx = content.indexOf(DIRECTIVES_HEADER);
  if (headerIdx === -1) {
    throw new Error(`Active Directives section not found in CLAUDE.md for ${handle}`);
  }

  const afterHeader = headerIdx + DIRECTIVES_HEADER.length;
  const nextSection = content.indexOf("\n## ", afterHeader);
  const sectionEnd = nextSection === -1 ? content.length : nextSection;

  content = content.slice(0, afterHeader) + `\n\n${DIRECTIVES_EMPTY}\n` + content.slice(sectionEnd);
  fs.writeFileSync(claudeMdPath, content);
}

// === Merge ===

export interface MergeResult {
  branch: string;
  mergedCommits: number;
  worktreeRemoved: boolean;
}

export function mergeAgent(
  db: Database.Database,
  handle: string,
  projectDir: string,
  opts: { cleanup?: boolean } = {}
): MergeResult {
  handle = normalizeHandle(handle);
  const spawn = getSpawn(db, handle);
  if (!spawn) {
    throw new Error(`No spawn record for ${handle}`);
  }

  // Agent must be stopped (or process dead)
  if (!spawn.stopped_at && isProcessAlive(spawn.pid)) {
    throw new Error(`${handle} is still running (PID ${spawn.pid}). Stop it first with \`board kill ${handle}\``);
  }

  const branch = spawn.branch;
  if (!branch) {
    throw new Error(`No branch recorded for ${handle}`);
  }

  // Count commits on branch that aren't on main
  let mergedCommits: number;
  try {
    const log = execSync(`git log main..${branch} --oneline`, {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    mergedCommits = log ? log.split("\n").length : 0;
  } catch {
    throw new Error(`Branch ${branch} not found or cannot compare with main`);
  }

  if (mergedCommits === 0) {
    throw new Error(`Branch ${branch} has no new commits to merge into main`);
  }

  // Merge the branch into main
  try {
    execSync(`git merge ${branch} --no-edit`, {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err: any) {
    throw new Error(
      `Merge conflict merging ${branch} into current branch. Resolve manually:\n` +
      `  cd ${projectDir} && git merge ${branch}`
    );
  }

  // Optionally clean up worktree and branch
  let worktreeRemoved = false;
  if (opts.cleanup && spawn.worktree_path) {
    removeWorktree(projectDir, spawn.worktree_path);
    // Delete the branch too
    try {
      execSync(`git branch -d ${branch}`, { cwd: projectDir, stdio: "pipe" });
    } catch {
      // Branch may not delete if not fully merged — that's ok after merge
      try {
        execSync(`git branch -D ${branch}`, { cwd: projectDir, stdio: "pipe" });
      } catch {
        // Best effort
      }
    }
    worktreeRemoved = true;
  }

  return { branch, mergedCommits, worktreeRemoved };
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
