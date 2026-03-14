import { execSync } from "child_process";
import { EventEmitter } from "events";
import type Database from "better-sqlite3";
import { getSpawn, isProcessAlive } from "./spawner.js";
import { listPosts } from "./posts.js";
import { normalizeHandle } from "./agents.js";

// === Types ===

export type BucketState = "planning" | "in_progress" | "blocked" | "review" | "done";

export interface GitOps {
  hasBranchCommits(projectDir: string, branch: string): boolean;
  isBranchMerged(projectDir: string, branch: string): boolean;
}

// === Default GitOps (real git) ===

export const defaultGitOps: GitOps = {
  hasBranchCommits(projectDir: string, branch: string): boolean {
    try {
      const log = execSync(`git log main..${branch} --oneline`, {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
      return log.length > 0;
    } catch {
      return false;
    }
  },

  isBranchMerged(projectDir: string, branch: string): boolean {
    try {
      const merged = execSync("git branch --merged main", {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
      return merged.split("\n").some((b) => b.trim() === branch);
    } catch {
      return false;
    }
  },
};

// === Inference ===

const TEN_MINUTES_MS = 10 * 60 * 1000;

export function inferBucket(opts: {
  db: Database.Database;
  agentHandle: string;
  gitOps?: GitOps;
}): BucketState {
  const { db, gitOps = defaultGitOps } = opts;
  const handle = normalizeHandle(opts.agentHandle);

  const spawn = getSpawn(db, handle);
  if (!spawn) return "planning";

  const alive = isProcessAlive(spawn.pid);
  const branch = spawn.branch ?? "";
  const projectDir = spawn.worktree_path ?? ".";

  // Check for recent escalations
  const tenMinAgo = new Date(Date.now() - TEN_MINUTES_MS).toISOString();
  const escalations = listPosts(db, {
    author: handle,
    channel: "#escalations",
    since: tenMinAgo,
    limit: 1,
  });
  if (escalations.length > 0) return "blocked";

  // Non-zero exit code → blocked
  if (spawn.stopped_at && spawn.exit_code !== null && spawn.exit_code !== 0) {
    return "blocked";
  }

  // Branch merged → done
  if (branch && gitOps.isBranchMerged(projectDir, branch)) {
    return "done";
  }

  const hasCommits = branch ? gitOps.hasBranchCommits(projectDir, branch) : false;

  // Stopped with exit 0, has commits, not merged → review
  if (spawn.stopped_at && spawn.exit_code === 0 && hasCommits) {
    return "review";
  }

  // Alive and has commits → in_progress
  if (alive && hasCommits) {
    return "in_progress";
  }

  // Alive but no commits — check for zombie
  if (alive && !hasCommits) {
    const lastActivity = getLastActivityTime(db, handle, spawn.started_at);
    const elapsed = Date.now() - new Date(lastActivity).getTime();
    if (elapsed > TEN_MINUTES_MS) {
      return "blocked"; // zombie
    }
    return "planning";
  }

  return "planning";
}

function getLastActivityTime(db: Database.Database, handle: string, fallback: string): string {
  const posts = listPosts(db, { author: handle, limit: 1 });
  if (posts.length > 0) return posts[0].created_at;
  return fallback;
}

// === Bulk inference ===

export function inferAllBuckets(opts: {
  db: Database.Database;
  sprintName: string;
  gitOps?: GitOps;
}): Map<string, BucketState> {
  const { db, sprintName, gitOps } = opts;

  const agents = db
    .prepare("SELECT agent_handle FROM sprint_agents WHERE sprint_name = ?")
    .all(sprintName) as { agent_handle: string }[];

  const result = new Map<string, BucketState>();
  for (const { agent_handle } of agents) {
    result.set(agent_handle, inferBucket({ db, agentHandle: agent_handle, gitOps }));
  }
  return result;
}

// === Event emitter ===

interface BoardEvents {
  post_created: { author: string; channel: string; content: string };
  spawn_stopped: { agent_handle: string; exit_code: number | null };
  bucket_changed: { agent_handle: string; from: BucketState; to: BucketState };
}

export class BoardEventEmitter extends EventEmitter {
  override emit<K extends keyof BoardEvents>(event: K, data: BoardEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof BoardEvents>(event: K, listener: (data: BoardEvents[K]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}
