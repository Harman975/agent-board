import { execSync } from "child_process";
import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { validateHandle, normalizeHandle } from "./agents.js";
import type { DagCommit } from "./types.js";

/*
 *  GIT DAG LAYER
 *  ─────────────
 *  Branchless DAG where agents push git bundles to a shared bare repo.
 *  Inspired by Karpathy's AgentHub — dead-end paths are naturally
 *  abandoned (not deleted). CEO promotes winning commits to main.
 *
 *  ┌─────────────┐   bundle    ┌─────────────┐   cherry-pick   ┌──────┐
 *  │ Agent        │ ─────────▶ │ .dag/ bare   │ ──────────────▶ │ main │
 *  │ (worktree)   │            │ repo         │   (promote)     │      │
 *  └─────────────┘            └─────────────┘                  └──────┘
 *
 *  Data flow:
 *  1. Agent creates bundle: git bundle create work.bundle HEAD
 *  2. POST /api/git/push with bundle → server unbundles into .dag/
 *  3. Server records commit in dag_commits table + auto-posts to #work
 *  4. CEO reviews leaves (active frontiers) via board tree / dashboard
 *  5. CEO promotes winning commit: cherry-pick onto main + audit post
 */

const DAG_DIR = ".dag";

// === Init ===

export function initDag(projectDir: string): string {
  const dagPath = path.join(projectDir, DAG_DIR);
  if (fs.existsSync(dagPath)) {
    return dagPath;
  }
  fs.mkdirSync(dagPath, { recursive: true });
  execSync("git init --bare", { cwd: dagPath, stdio: "pipe" });
  return dagPath;
}

export function dagExists(projectDir: string): boolean {
  const dagPath = path.join(projectDir, DAG_DIR);
  return fs.existsSync(path.join(dagPath, "HEAD"));
}

// === Push bundle ===

export interface PushResult {
  hash: string;
  parentHash: string | null;
  agentHandle: string;
  message: string;
}

export function pushBundle(
  db: Database.Database,
  projectDir: string,
  agentHandle: string,
  bundlePath: string,
  commitMessage: string
): PushResult {
  validateHandle(agentHandle);
  agentHandle = normalizeHandle(agentHandle);

  const dagPath = path.join(projectDir, DAG_DIR);
  if (!dagExists(projectDir)) {
    throw new Error("DAG not initialized. Run `board init` first.");
  }

  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Bundle file not found: ${bundlePath}`);
  }

  // Verify the bundle is valid
  try {
    execSync(`git bundle verify "${bundlePath}"`, { cwd: dagPath, stdio: "pipe" });
  } catch {
    throw new Error("Invalid git bundle");
  }

  // Unbundle into the bare repo
  let unbundleOutput: string;
  try {
    unbundleOutput = execSync(`git bundle unbundle "${bundlePath}"`, {
      cwd: dagPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err: any) {
    throw new Error(`Failed to unbundle: ${err.message}`);
  }

  // Extract the commit hash from unbundle output
  // Output format: "<hash> <ref>\n..." — take the first hash
  const hashMatch = unbundleOutput.trim().match(/^([0-9a-f]{40})/m);
  if (!hashMatch) {
    throw new Error("Could not extract commit hash from unbundle output");
  }
  const hash = hashMatch[1];

  // Get parent hash (if any)
  let parentHash: string | null = null;
  try {
    const parentOutput = execSync(`git rev-parse ${hash}^`, {
      cwd: dagPath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    parentHash = parentOutput || null;
  } catch {
    // No parent — root commit
    parentHash = null;
  }

  // Record in dag_commits table
  db.prepare(`
    INSERT OR IGNORE INTO dag_commits (hash, parent_hash, agent_handle, message)
    VALUES (?, ?, ?, ?)
  `).run(hash, parentHash, agentHandle, commitMessage);

  return { hash, parentHash, agentHandle, message: commitMessage };
}

// === Fetch bundle ===

export function fetchBundle(
  projectDir: string,
  hash: string,
  outputPath: string
): void {
  const dagPath = path.join(projectDir, DAG_DIR);
  if (!dagExists(projectDir)) {
    throw new Error("DAG not initialized");
  }

  // Validate hash format to prevent injection
  if (!/^[0-9a-f]{7,40}$/.test(hash)) {
    throw new Error("Invalid commit hash format");
  }

  try {
    execSync(`git bundle create "${outputPath}" ${hash}`, {
      cwd: dagPath,
      stdio: "pipe",
    });
  } catch {
    throw new Error(`Failed to create bundle for ${hash}`);
  }
}

// === Query commits ===

export function listDagCommits(
  db: Database.Database,
  opts?: { agentHandle?: string; since?: string; limit?: number }
): DagCommit[] {
  let sql = "SELECT * FROM dag_commits WHERE 1=1";
  const params: unknown[] = [];

  if (opts?.agentHandle) {
    const handle = normalizeHandle(opts.agentHandle);
    sql += " AND agent_handle = ?";
    params.push(handle);
  }
  if (opts?.since) {
    sql += " AND created_at >= ?";
    params.push(opts.since);
  }

  sql += " ORDER BY created_at DESC";

  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  return db.prepare(sql).all(...params) as DagCommit[];
}

export function getDagCommit(db: Database.Database, hash: string): DagCommit | null {
  return (db.prepare("SELECT * FROM dag_commits WHERE hash = ?").get(hash) as DagCommit | undefined) ?? null;
}

/**
 * Get leaves — commits with no children (active exploration frontiers).
 * Uses NOT IN subquery; fine for small DAGs, optimize later if needed.
 */
export function getLeaves(
  db: Database.Database,
  opts?: { agentHandle?: string }
): DagCommit[] {
  let sql = `
    SELECT * FROM dag_commits
    WHERE hash NOT IN (SELECT parent_hash FROM dag_commits WHERE parent_hash IS NOT NULL)
  `;
  const params: unknown[] = [];

  if (opts?.agentHandle) {
    const handle = normalizeHandle(opts.agentHandle);
    sql += " AND agent_handle = ?";
    params.push(handle);
  }

  sql += " ORDER BY created_at DESC";

  return db.prepare(sql).all(...params) as DagCommit[];
}

/**
 * Get children of a commit.
 */
export function getChildren(db: Database.Database, hash: string): DagCommit[] {
  return db.prepare(
    "SELECT * FROM dag_commits WHERE parent_hash = ? ORDER BY created_at ASC"
  ).all(hash) as DagCommit[];
}

/**
 * Trace lineage from a commit back to root.
 * Returns commits in reverse order (oldest first).
 */
export function getLineage(db: Database.Database, hash: string): DagCommit[] {
  const lineage: DagCommit[] = [];
  const visited = new Set<string>();
  let current = hash;

  while (current && !visited.has(current)) {
    visited.add(current);
    const commit = getDagCommit(db, current);
    if (!commit) break;
    lineage.unshift(commit);
    if (!commit.parent_hash) break;
    current = commit.parent_hash;
  }

  return lineage;
}

// === Diff ===

export function diffCommits(
  projectDir: string,
  hashA: string,
  hashB: string
): string {
  const dagPath = path.join(projectDir, DAG_DIR);
  if (!dagExists(projectDir)) {
    throw new Error("DAG not initialized");
  }

  // Validate hash formats
  if (!/^[0-9a-f]{7,40}$/.test(hashA) || !/^[0-9a-f]{7,40}$/.test(hashB)) {
    throw new Error("Invalid commit hash format");
  }

  try {
    return execSync(`git diff ${hashA} ${hashB}`, {
      cwd: dagPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    throw new Error(`Failed to diff ${hashA}..${hashB}`);
  }
}

// === Promote ===

export interface PromoteResult {
  originalHash: string;
  newHash: string;
  message: string;
}

/**
 * Promote a DAG commit onto main by cherry-picking.
 * Must be run from the project's main worktree (not .dag/).
 */
export function promoteCommit(
  projectDir: string,
  hash: string
): PromoteResult {
  const dagPath = path.join(projectDir, DAG_DIR);
  if (!dagExists(projectDir)) {
    throw new Error("DAG not initialized");
  }

  // Validate hash format
  if (!/^[0-9a-f]{7,40}$/.test(hash)) {
    throw new Error("Invalid commit hash format");
  }

  // Get the commit message from the DAG
  let message: string;
  try {
    message = execSync(`git log -1 --format=%s ${hash}`, {
      cwd: dagPath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    throw new Error(`Commit ${hash} not found in DAG`);
  }

  // Create a temporary patch from the DAG commit
  const patchPath = path.join(projectDir, ".dag-promote.patch");
  try {
    const patch = execSync(`git format-patch -1 ${hash} --stdout`, {
      cwd: dagPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
    fs.writeFileSync(patchPath, patch);

    // Apply the patch to the main worktree
    execSync(`git am "${patchPath}"`, {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Get the new commit hash
    const newHash = execSync("git rev-parse HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    return { originalHash: hash, newHash, message };
  } catch (err: any) {
    // Clean up on failure
    try {
      execSync("git am --abort", { cwd: projectDir, stdio: "pipe" });
    } catch {
      // ignore cleanup failure
    }
    throw new Error(
      `Failed to promote ${hash.slice(0, 8)}. Possible conflict.\n` +
      `Manual promote: cd ${dagPath} && git format-patch -1 ${hash} --stdout | git am`
    );
  } finally {
    // Clean up patch file
    try {
      fs.unlinkSync(patchPath);
    } catch {
      // ignore
    }
  }
}

// === DAG summary for briefings ===

export interface DagSummary {
  totalCommits: number;
  leafCount: number;
  agentActivity: { handle: string; commits: number }[];
  recentLeaves: DagCommit[];
}

export function getDagSummary(
  db: Database.Database,
  since?: string
): DagSummary {
  // Total commits
  let countSql = "SELECT COUNT(*) as count FROM dag_commits";
  const countParams: unknown[] = [];
  if (since) {
    countSql += " WHERE created_at >= ?";
    countParams.push(since);
  }
  const totalCommits = (db.prepare(countSql).get(...countParams) as { count: number }).count;

  // Leaves
  const leaves = getLeaves(db);

  // Per-agent activity
  let activitySql = `
    SELECT agent_handle as handle, COUNT(*) as commits
    FROM dag_commits
  `;
  const activityParams: unknown[] = [];
  if (since) {
    activitySql += " WHERE created_at >= ?";
    activityParams.push(since);
  }
  activitySql += " GROUP BY agent_handle ORDER BY commits DESC";
  const agentActivity = db.prepare(activitySql).all(...activityParams) as { handle: string; commits: number }[];

  // Recent leaves (last 5)
  const recentLeaves = leaves.slice(0, 5);

  return {
    totalCommits,
    leafCount: leaves.length,
    agentActivity,
    recentLeaves,
  };
}
