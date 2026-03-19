import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type {
  Sprint,
  SprintAgent,
  SprintReport,
  SprintAgentReport,
  SprintBranch,
  AgentBrief,
  LandingBrief,
  CompressionReport,
  SprintCompression,
} from "./types.js";
import { parseAgentReport, formatDuration } from "./render.js";

// === Shared git diff parsing ===

export interface NumstatResult {
  additions: number;
  deletions: number;
  filesChanged: number;
  files: Set<string>;
}

/**
 * Parse `git diff --numstat` output for a branch vs main.
 * Returns null if the branch doesn't exist.
 */
export function parseNumstat(projectDir: string, branch: string): NumstatResult | null {
  try {
    const raw = execSync(`git diff --numstat main..${branch}`, {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;
    const files = new Set<string>();

    if (raw) {
      for (const line of raw.split("\n")) {
        const parts = line.split("\t");
        if (parts.length >= 3) {
          additions += parseInt(parts[0], 10) || 0;
          deletions += parseInt(parts[1], 10) || 0;
          files.add(parts[2]);
          filesChanged++;
        }
      }
    }

    return { additions, deletions, filesChanged, files };
  } catch {
    return null; // Branch not found
  }
}

// === Pre-flight types ===

export interface PreFlightResult {
  allStopped: boolean;
  running: { agent_handle: string; pid: number }[];
  testsPass: boolean;
  branches: SprintBranch[];
  conflicts: string[];
  mergeOrder: string[];
}

// === Pre-flight check (shared by validate-sprint, merge-sprint, sprint finish) ===

export async function runPreFlight(
  projectDir: string,
  opts: {
    skipTests?: boolean;
    agentHandles?: string[];
    approachGroupsByHandle?: Map<string, string | null>;
  } = {}
): Promise<PreFlightResult> {
  const { listSpawns, isProcessAlive } = await import("./spawner.js");
  const { getDb } = await import("./db.js");
  const db = getDb(projectDir);

  const allSpawns = listSpawns(db);
  const spawns = opts.agentHandles
    ? allSpawns.filter((s) => opts.agentHandles!.includes(s.agent_handle))
    : allSpawns;

  db.close();

  // 1. Check all agents stopped
  const running = spawns.filter((s) => !s.stopped_at && isProcessAlive(s.pid));
  const allStopped = running.length === 0;

  // 2. Run tests (optional)
  let testsPass = false;
  if (!opts.skipTests) {
    try {
      execSync("npm test", { cwd: projectDir, stdio: "pipe", timeout: 120_000 });
      testsPass = true;
    } catch {
      testsPass = false;
    }
  }

  // 3. Parse diff stats per branch
  const branches: SprintBranch[] = [];
  const filesByBranch = new Map<string, Set<string>>();

  for (const s of spawns) {
    if (!s.branch) continue;
    const stats = parseNumstat(projectDir, s.branch);
    if (!stats) continue;

    filesByBranch.set(s.agent_handle, stats.files);
    branches.push({
      agent_handle: s.agent_handle,
      branch: s.branch,
      filesChanged: stats.filesChanged,
      additions: stats.additions,
      deletions: stats.deletions,
    });
  }

  // 4. Detect conflicts
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
      const firstGroup = opts.approachGroupsByHandle?.get(agents[0]) ?? null;
      if (firstGroup && agents.every((agent) => opts.approachGroupsByHandle?.get(agent) === firstGroup)) {
        continue;
      }
      conflicts.push(`${file} (${agents.join(", ")})`);
    }
  }

  // 5. Merge order: fewest files first
  const mergeOrder = [...branches]
    .sort((a, b) => a.filesChanged - b.filesChanged)
    .map((b) => b.agent_handle);

  return { allStopped, running, testsPass, branches, conflicts, mergeOrder };
}

// === Sprint report protocol — injected into identity for sprint agents ===

export const SPRINT_CLARITY_PROTOCOL = `

## Sprint Clarity Protocol

- Treat your branch as one hypothesis, not the final answer.
- Reuse or extend existing code before creating new files or abstractions.
- Keep the surviving diff as small as possible.
- If you add surface area, be explicit about why the existing code was insufficient.
`;

export const SPRINT_REPORT_PROTOCOL = `

## Completion Report Protocol

When you finish your work, post a structured completion report to #work with this exact format:

REPORT: <one-line summary of what you built/changed>
HYPOTHESIS: <what idea or route you were testing>
REUSED: <what existing code, patterns, or modules you kept or extended>
WHY NOT EXISTING CODE: <why patching or extending the current code was not enough>
WHY SURVIVES: <why this approach deserves to remain after synthesis>
NEW FILES: <which new files were introduced, or "none">
ARCHITECTURE: <how it's designed, component boundaries, key decisions>
DATA FLOW: <input → transform → output, how data moves through your changes>
EDGE CASES: <what edge cases you handled, what's not handled>
TESTS: <test count, coverage areas, what scenarios are tested>

This report will be shown to the CEO in the sprint finish view.
`;

export function decorateSprintMission(
  mission: string,
  opts: { includeReportProtocol?: boolean } = {},
): string {
  const sections = [mission.trim(), SPRINT_CLARITY_PROTOCOL.trim()];
  if (opts.includeReportProtocol) {
    sections.push(SPRINT_REPORT_PROTOCOL.trim());
  }
  return sections.filter(Boolean).join("\n\n");
}

function getBranchCommitCount(projectDir: string, branch: string | null): number {
  if (!branch) return 0;
  try {
    const raw = execSync(`git rev-list --count main..${branch}`, {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return parseInt(raw, 10) || 0;
  } catch {
    return 0;
  }
}

function getLastDagPushMessage(db: Database.Database, handle: string): string | null {
  const row = db.prepare(
    "SELECT message FROM dag_commits WHERE agent_handle = ? ORDER BY created_at DESC LIMIT 1"
  ).get(handle) as { message: string } | undefined;
  return row?.message ?? null;
}

function getWorkerSprintAgents(db: Database.Database, sprintName: string): SprintAgent[] {
  return db.prepare(
    "SELECT * FROM sprint_agents WHERE sprint_name = ? AND (identity_name IS NULL OR identity_name != 'condenser')"
  ).all(sprintName) as SprintAgent[];
}

function getSprintCompression(db: Database.Database, sprintName: string): SprintCompression | null {
  return db.prepare(
    "SELECT * FROM sprint_compressions WHERE sprint_name = ?"
  ).get(sprintName) as SprintCompression | undefined ?? null;
}

function upsertSprintCompression(
  db: Database.Database,
  sprintName: string,
  updates: Partial<Omit<SprintCompression, "sprint_name">>
): SprintCompression {
  const current = getSprintCompression(db, sprintName);
  const next: SprintCompression = {
    sprint_name: sprintName,
    status: updates.status ?? current?.status ?? "pending",
    staging_branch: updates.staging_branch ?? current?.staging_branch ?? null,
    staging_worktree_path: updates.staging_worktree_path ?? current?.staging_worktree_path ?? null,
    condenser_handle: updates.condenser_handle ?? current?.condenser_handle ?? null,
    before_additions: updates.before_additions ?? current?.before_additions ?? 0,
    before_deletions: updates.before_deletions ?? current?.before_deletions ?? 0,
    before_files_changed: updates.before_files_changed ?? current?.before_files_changed ?? 0,
    after_additions: updates.after_additions ?? current?.after_additions ?? null,
    after_deletions: updates.after_deletions ?? current?.after_deletions ?? null,
    after_files_changed: updates.after_files_changed ?? current?.after_files_changed ?? null,
    error_message: updates.error_message ?? current?.error_message ?? null,
    bypass_reason: updates.bypass_reason ?? current?.bypass_reason ?? null,
    started_at: updates.started_at ?? current?.started_at ?? null,
    finished_at: updates.finished_at ?? current?.finished_at ?? null,
  };

  db.prepare(`
    INSERT INTO sprint_compressions (
      sprint_name, status, staging_branch, staging_worktree_path, condenser_handle,
      before_additions, before_deletions, before_files_changed,
      after_additions, after_deletions, after_files_changed,
      error_message, bypass_reason, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sprint_name) DO UPDATE SET
      status = excluded.status,
      staging_branch = excluded.staging_branch,
      staging_worktree_path = excluded.staging_worktree_path,
      condenser_handle = excluded.condenser_handle,
      before_additions = excluded.before_additions,
      before_deletions = excluded.before_deletions,
      before_files_changed = excluded.before_files_changed,
      after_additions = excluded.after_additions,
      after_deletions = excluded.after_deletions,
      after_files_changed = excluded.after_files_changed,
      error_message = excluded.error_message,
      bypass_reason = excluded.bypass_reason,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at
  `).run(
    next.sprint_name,
    next.status,
    next.staging_branch,
    next.staging_worktree_path,
    next.condenser_handle,
    next.before_additions,
    next.before_deletions,
    next.before_files_changed,
    next.after_additions,
    next.after_deletions,
    next.after_files_changed,
    next.error_message,
    next.bypass_reason,
    next.started_at,
    next.finished_at,
  );

  return getSprintCompression(db, sprintName)!;
}

// === Shared sprint data gathering ===
//
//  gatherSprintData() → { sprint, agentData[], preflight }
//     ├── buildSprintReport() maps agentData → SprintAgentReport[]
//     └── buildLandingBrief()  maps agentData → AgentBrief[]

interface GatheredAgentData {
  handle: string;
  mission: string | null;
  track: string | null;
  approachGroup: string | null;
  approachLabel: string | null;
  spawn: import("./spawner.js").SpawnRecord | undefined;
  alive: boolean;
  stopped: boolean;
  report: import("./types.js").ParsedAgentReport | null;
  lastPost: string | null;
  lastPosts: { content: string; created_at: string }[];
  stats: NumstatResult | null;
  commitCount: number;
  lastDagPushMessage: string | null;
}

async function gatherSprintData(
  sprintName: string,
  projectDir: string,
  opts: { skipTests?: boolean } = {},
) {
  const { getDb } = await import("./db.js");
  const { listSpawns, isProcessAlive, markSpawnStopped } = await import("./spawner.js");
  const db = getDb(projectDir);

  const sprint = db.prepare("SELECT * FROM sprints WHERE name = ?").get(sprintName) as Sprint | undefined;
  if (!sprint) {
    db.close();
    throw new Error(`Sprint not found: ${sprintName}`);
  }

  const sprintAgents = getWorkerSprintAgents(db, sprintName);
  const spawns = listSpawns(db);
  const approachGroupsByHandle = new Map(sprintAgents.map((sa) => [sa.agent_handle, sa.approach_group]));

  const escalationCount = (db.prepare(
    "SELECT COUNT(*) as count FROM posts WHERE channel = '#escalations' AND created_at >= ?"
  ).get(sprint.created_at) as { count: number }).count;

  const agentData: GatheredAgentData[] = [];

  for (const sa of sprintAgents) {
    const spawn = spawns.find((s) => s.agent_handle === sa.agent_handle);
    const alive = spawn && !spawn.stopped_at ? isProcessAlive(spawn.pid) : false;
    const stopped = spawn ? !!spawn.stopped_at || !alive : true;

    // Auto-mark dead agents as stopped
    if (spawn && !spawn.stopped_at && !alive) {
      markSpawnStopped(db, sa.agent_handle);
    }

    // Get last 3 posts (superset — callers pick what they need)
    const lastPosts = db.prepare(
      "SELECT content, created_at FROM posts WHERE author = ? ORDER BY created_at DESC LIMIT 3"
    ).all(sa.agent_handle) as { content: string; created_at: string }[];

    // Parse structured report from last 10 posts
    let report = null;
    const recentPosts = db.prepare(
      "SELECT content FROM posts WHERE author = ? ORDER BY created_at DESC LIMIT 10"
    ).all(sa.agent_handle) as { content: string }[];
    for (const p of recentPosts) {
      report = parseAgentReport(p.content);
      if (report) break;
    }

    const stats = spawn?.branch ? parseNumstat(projectDir, spawn.branch) : null;

    agentData.push({
      handle: sa.agent_handle,
      mission: sa.mission,
      track: sa.track,
      approachGroup: sa.approach_group,
      approachLabel: sa.approach_label,
      spawn,
      alive,
      stopped,
      report,
      lastPost: lastPosts[0]?.content ?? null,
      lastPosts,
      stats,
      commitCount: getBranchCommitCount(projectDir, spawn?.branch ?? null),
      lastDagPushMessage: getLastDagPushMessage(db, sa.agent_handle),
    });
  }

  const handles = sprintAgents.map((sa) => sa.agent_handle);
  const preflight = await runPreFlight(projectDir, {
    skipTests: opts.skipTests ?? false,
    agentHandles: handles,
    approachGroupsByHandle,
  });
  const compression = getSprintCompression(db, sprintName);

  db.close();

  return { sprint, agentData, escalationCount, preflight, compression };
}

function countTests(testsStr: string | null): number | null {
  if (!testsStr) return null;
  const numbers = testsStr.match(/\d+/g);
  if (!numbers || numbers.length === 0) return null;
  return parseInt(numbers[0], 10);
}

// === Build landing brief ===

export async function buildLandingBrief(
  sprintName: string,
  projectDir: string,
): Promise<LandingBrief> {
  const { sprint, agentData, preflight, compression } = await gatherSprintData(sprintName, projectDir, { skipTests: false });

  let totalTests = 0;
  const agents: AgentBrief[] = agentData.map((a) => {
    let status: "passed" | "crashed" | "running";
    if (a.alive) status = "running";
    else if (a.spawn?.exit_code === 0) status = "passed";
    else status = "crashed";

    const runtime = a.spawn?.started_at
      ? formatDuration(a.spawn.started_at, a.spawn.stopped_at)
      : null;

    const testCount = countTests(a.report?.tests ?? null);
    if (testCount !== null) totalTests += testCount;

    return {
      handle: a.handle,
      status,
      report: a.report,
      lastPosts: a.lastPosts,
      exitCode: a.spawn?.exit_code ?? null,
      runtime,
      branch: a.spawn?.branch ?? null,
      testCount,
      mission: a.mission,
      track: a.track,
      approachGroup: a.approachGroup,
      approachLabel: a.approachLabel,
      commitCount: a.commitCount,
      lastDagPushMessage: a.lastDagPushMessage,
    };
  });

  const { getDb } = await import("./db.js");
  const db = getDb(projectDir);
  const compressionReport = await buildCompressionReport(projectDir, db, sprintName);
  db.close();

  return {
    sprint,
    agents,
    summary: {
      passed: agents.filter((a) => a.status === "passed").length,
      crashed: agents.filter((a) => a.status === "crashed").length,
      running: agents.filter((a) => a.status === "running").length,
      totalTests,
    },
    conflicts: preflight.conflicts,
    testsPassOnMain: preflight.testsPass,
    compression: compression ? compressionReport ?? undefined : undefined,
  };
}

// === Merge with test gates ===

export interface MergeResult {
  merged: string[];
  failed: string | null;
}

/**
 * Sequentially merge branches, running tests after each.
 * Reverts on test failure. Returns list of successfully merged handles.
 */
export async function mergeWithTestGates(
  mergeOrder: string[],
  projectDir: string,
  opts: { db: Database.Database; onFailure?: (handle: string) => void } = {} as any,
): Promise<MergeResult> {
  const { mergeAgent } = await import("./spawner.js");
  const merged: string[] = [];

  for (const handle of mergeOrder) {
    console.log(`\nMerging ${handle}...`);
    try {
      const result = mergeAgent(opts.db, handle, projectDir);
      console.log(`  Merged ${result.branch} (${result.mergedCommits} commits)`);
    } catch (err: any) {
      opts.onFailure?.(handle);
      throw new Error(`Merge failed for ${handle}: ${err.message}`);
    }

    try {
      execSync("npm test", { cwd: projectDir, stdio: "pipe", timeout: 120_000 });
      console.log(`  Tests pass after merging ${handle}.`);
      merged.push(handle);
    } catch {
      console.error(`  Tests FAILED after merging ${handle}. Reverting...`);
      execSync("git reset --hard HEAD~1", { cwd: projectDir, stdio: "pipe" });
      console.error(`  Reverted merge of ${handle}. Stopping.`);
      opts.onFailure?.(handle);
      throw new Error(`Tests failed after merging ${handle}`);
    }
  }

  return { merged, failed: null };
}

// === Sprint helper: build report for a sprint ===

export async function buildSprintReport(
  sprintName: string,
  projectDir: string,
  detail = false,
): Promise<SprintReport> {
  const { sprint, agentData, escalationCount, preflight, compression } = await gatherSprintData(sprintName, projectDir, { skipTests: true });

  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalFiles = 0;

  const agentReports: SprintAgentReport[] = agentData.map((a) => {
    const additions = a.stats?.additions ?? 0;
    const deletions = a.stats?.deletions ?? 0;
    const filesChanged = a.stats?.filesChanged ?? 0;

    totalAdditions += additions;
    totalDeletions += deletions;
    totalFiles += filesChanged;

    return {
      handle: a.handle,
      branch: a.spawn?.branch || null,
      alive: a.alive,
      stopped: a.stopped,
      exitCode: a.spawn?.exit_code ?? null,
      additions,
      deletions,
      filesChanged,
      mission: a.mission,
      lastPost: a.lastPost,
      report: a.report,
      track: a.track,
      approachGroup: a.approachGroup,
      approachLabel: a.approachLabel,
      commitCount: a.commitCount,
      lastDagPushMessage: a.lastDagPushMessage,
    };
  });

  const { getDb } = await import("./db.js");
  const db = getDb(projectDir);
  const compressionReport = await buildCompressionReport(projectDir, db, sprintName);
  db.close();

  return {
    sprint,
    agents: agentReports,
    totals: { additions: totalAdditions, deletions: totalDeletions, filesChanged: totalFiles },
    conflicts: preflight.conflicts,
    escalations: escalationCount,
    mergeOrder: preflight.mergeOrder,
    compression: compression ? compressionReport ?? undefined : undefined,
  };
}

// === Sprint name slugification ===

export function slugify(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Generate a unique sprint name from a goal string.
 * Appends -2, -3, etc. on collision.
 */
export function uniqueSprintName(goal: string, db: Database.Database): string {
  const base = slugify(goal);
  if (!base) return `sprint-${Date.now()}`;

  const exists = (name: string) =>
    !!db.prepare("SELECT name FROM sprints WHERE name = ?").get(name);

  if (!exists(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Could not generate unique sprint name for "${goal}" (99 collisions)`);
}

// === Shared sprint start logic ===

export interface AgentSpec {
  handle: string;
  identity?: string;
  mission: string;
  scope?: string[];
  track?: string;
  approachGroup?: string;
  approachLabel?: string;
}

export interface StartSprintResult {
  name: string;
  spawned: string[];
}

/**
 * Validate disjoint scopes across agent specs.
 * Throws on overlap.
 */
export function validateDisjointScopes(specs: AgentSpec[]): void {
  const fileOwners = new Map<string, { handle: string; approachGroup: string | null }>();
  const overlaps: string[] = [];
  for (const spec of specs) {
    for (const file of spec.scope ?? []) {
      const existingOwner = fileOwners.get(file);
      if (existingOwner) {
        if (existingOwner.approachGroup && existingOwner.approachGroup === spec.approachGroup) {
          continue;
        }
        overlaps.push(`${file} claimed by both ${existingOwner.handle} and ${spec.handle}`);
      } else {
        fileOwners.set(file, { handle: spec.handle, approachGroup: spec.approachGroup ?? null });
      }
    }
  }
  if (overlaps.length > 0) {
    throw new Error(`Scope overlap detected:\n${overlaps.map((o) => `  - ${o}`).join("\n")}`);
  }
}

/**
 * Start a sprint: create sprint record, spawn all agents with identities,
 * atomic rollback on failure.
 *
 * Used by both `board sprint start` (cli.ts) and the CEO console (interactive.ts).
 */
export async function startSprint(opts: {
  name: string;
  goal: string;
  specs: AgentSpec[];
  teamName?: string | null;
  projectDir: string;
  serverUrl: string;
  db: Database.Database;
  onSpawn?: (handle: string, pid: number, branch: string) => void;
}): Promise<StartSprintResult> {
  const { spawnAgent, killAgent } = await import("./spawner.js");
  const { createAgent, getAgent } = await import("./agents.js");
  const { normalizeHandle } = await import("./agents.js");
  const { generateKey, storeKey } = await import("./auth.js");
  const { loadIdentity } = await import("./identities.js");

  // Validate scopes
  validateDisjointScopes(opts.specs);

  // Check sprint name doesn't already exist
  const existing = opts.db.prepare("SELECT name FROM sprints WHERE name = ?").get(opts.name);
  if (existing) {
    throw new Error(`Sprint "${opts.name}" already exists. Choose a different name.`);
  }

  if (opts.teamName) {
    const teamExists = opts.db.prepare("SELECT name FROM teams WHERE name = ?").get(opts.teamName);
    if (!teamExists) {
      throw new Error(`Team "${opts.teamName}" does not exist.`);
    }
  }

  // Create sprint record
  opts.db
    .prepare("INSERT INTO sprints (name, goal, team_name) VALUES (?, ?, ?)")
    .run(opts.name, opts.goal, opts.teamName ?? null);

  // Spawn agents atomically
  const spawned: string[] = [];

  for (const spec of opts.specs) {
    const handle = normalizeHandle(spec.handle);

    try {
      if (!getAgent(opts.db, handle)) {
        createAgent(opts.db, {
          handle: handle.slice(1),
          name: handle.slice(1),
          role: "worker",
          mission: spec.mission,
        });
      }

      let mission = decorateSprintMission(spec.mission, {
        includeReportProtocol: !spec.identity,
      });
      let identity = undefined;

      if (spec.identity) {
        try {
          identity = loadIdentity(spec.identity, opts.projectDir);
          identity = { ...identity, content: identity.content + SPRINT_REPORT_PROTOCOL };
        } catch {
          const identityPath = path.join(opts.projectDir, "identities", `${spec.identity}.md`);
          if (fs.existsSync(identityPath)) {
            const identityContent = fs.readFileSync(identityPath, "utf-8");
            mission = `[Identity: ${spec.identity}]\n${identityContent}\n\n${decorateSprintMission(spec.mission, {
              includeReportProtocol: true,
            })}`;
          } else {
            throw new Error(`Identity not found: ${spec.identity}`);
          }
        }
      }

      const apiKey = generateKey();
      storeKey(opts.db, apiKey, handle);

      const result = spawnAgent(opts.db, {
        handle,
        mission,
        apiKey,
        serverUrl: opts.serverUrl,
        projectDir: opts.projectDir,
        identity,
        scope: spec.scope,
      });

      opts.db.prepare(
        `INSERT INTO sprint_agents (
          sprint_name, agent_handle, identity_name, mission, track, approach_group, approach_label
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        opts.name,
        handle,
        spec.identity || null,
        spec.mission,
        spec.track ?? null,
        spec.approachGroup ?? null,
        spec.approachLabel ?? null,
      );

      spawned.push(handle);
      opts.onSpawn?.(handle, result.pid, result.branch);
    } catch (err: any) {
      // Atomic rollback
      for (const h of spawned) {
        try { killAgent(opts.db, h, opts.projectDir); } catch { /* best effort */ }
      }
      opts.db.prepare(
        "UPDATE sprints SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE name = ?"
      ).run(opts.name);
      throw new Error(`Failed to spawn ${handle}: ${err.message}`);
    }
  }

  return { name: opts.name, spawned };
}

// === Compression pipeline ===
//
//  COMPRESSION FLOW:
//  ─────────────────
//  1. createStagingBranch() — create staging/{sprint} from main
//  2. mergeAgentsToStaging() — merge all agent branches into staging
//  3. spawnCondenser() — spawn condenser agent on staging worktree
//  4. (condenser works, time-boxed to 10 min)
//  5. buildCompressionReport() — measure before/after LOC
//  6. squashMergeToMain() — squash-merge staging to main
//

const CONDENSER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function currentUtcIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function elapsedMsSince(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return Date.now() - parsed;
}

function ensureStagingRoot(projectDir: string): string {
  const dir = path.join(projectDir, ".worktrees");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function ensureNodeModulesSymlink(projectDir: string, worktreePath: string): void {
  const nodeModulesSrc = path.join(projectDir, "node_modules");
  const nodeModulesDst = path.join(worktreePath, "node_modules");
  if (fs.existsSync(nodeModulesSrc) && !fs.existsSync(nodeModulesDst)) {
    fs.symlinkSync(nodeModulesSrc, nodeModulesDst, "dir");
  }
}

/**
 * Create a staging branch from main for the sprint.
 * Returns the branch name.
 */
export function createStagingBranch(projectDir: string, sprintName: string): string {
  const branch = `staging/${sprintName}`;
  try {
    execSync(`git rev-parse --verify ${branch}`, { cwd: projectDir, stdio: "pipe" });
  } catch {
    execSync(`git branch ${branch} main`, { cwd: projectDir, stdio: "pipe" });
  }
  return branch;
}

export function ensureStagingWorktree(
  projectDir: string,
  sprintName: string,
): { branch: string; worktreePath: string } {
  const branch = createStagingBranch(projectDir, sprintName);
  const worktreePath = path.join(ensureStagingRoot(projectDir), `staging-${sprintName}`);

  if (!fs.existsSync(worktreePath)) {
    execSync(`git worktree add "${worktreePath}" ${branch}`, {
      cwd: projectDir,
      stdio: "pipe",
    });
  }

  ensureNodeModulesSymlink(projectDir, worktreePath);
  return { branch, worktreePath };
}

/**
 * Merge all agent branches into the staging worktree.
 * Returns list of successfully merged handles and any that had conflicts.
 * Conflict markers are left in place for the condenser to resolve.
 */
export async function mergeAgentsToStaging(
  stagingWorktreePath: string,
  agentHandles: string[],
  db: Database.Database,
): Promise<{ merged: string[]; conflicted: string[] }> {
  const { getSpawn } = await import("./spawner.js");

  const merged: string[] = [];
  const conflicted: string[] = [];

  for (const handle of agentHandles) {
    const spawn = getSpawn(db, handle);
    if (!spawn?.branch) continue;

    try {
      execSync(`git merge ${spawn.branch} --no-edit`, {
        cwd: stagingWorktreePath,
        encoding: "utf-8",
        stdio: "pipe",
      });
      merged.push(handle);
    } catch {
      // Merge conflict — commit with markers for condenser to resolve
      try {
        execSync("git add -A", { cwd: stagingWorktreePath, stdio: "pipe" });
        execSync(`git commit -m "merge ${handle} (conflicts for condenser)"`, {
          cwd: stagingWorktreePath,
          stdio: "pipe",
        });
        conflicted.push(handle);
      } catch {
        // If we can't even commit, abort the merge
        try { execSync("git merge --abort", { cwd: stagingWorktreePath, stdio: "pipe" }); } catch { /* */ }
      }
    }
  }

  return { merged, conflicted };
}

/**
 * Spawn the condenser agent on the staging branch.
 * Returns the condenser's handle and a timeout that will kill it.
 */
export async function spawnCondenser(opts: {
  sprintName: string;
  stagingBranch: string;
  stagingWorktreePath: string;
  projectDir: string;
  serverUrl: string;
  db: Database.Database;
  beforeLines: number;
}): Promise<{ handle: string; pid: number }> {
  const { spawnAgent, respawnAgent, getSpawn } = await import("./spawner.js");
  const { createAgent, getAgent } = await import("./agents.js");
  const { normalizeHandle } = await import("./agents.js");
  const { generateKey, storeKey } = await import("./auth.js");
  const { loadIdentity } = await import("./identities.js");

  const handle = normalizeHandle(`condenser-${opts.sprintName}`);

  // Create agent record if needed
  if (!getAgent(opts.db, handle)) {
    createAgent(opts.db, {
      handle: handle.slice(1),
      name: "condenser",
      role: "worker",
      mission: `Compress sprint ${opts.sprintName}`,
    });
  }

  // Load condenser identity
  let identity;
  try {
    identity = loadIdentity("condenser", opts.projectDir);
  } catch {
    throw new Error("Condenser identity not found. Create identities/condenser.md first.");
  }

  const apiKey = generateKey();
  storeKey(opts.db, apiKey, handle);

  const mission = `Synthesize the competing approaches on branch ${opts.stagingBranch}. ` +
    `Baseline: +${opts.beforeLines} lines vs main. ` +
    `Goal: same tests passing, fewer lines, and one surviving implementation. ` +
    `Work directly on this branch — do not create new branches.`;

  const existingSpawn = getSpawn(opts.db, handle);
  const result = existingSpawn
    ? respawnAgent(opts.db, handle, {
      mission,
      serverUrl: opts.serverUrl,
      projectDir: opts.projectDir,
      branch: opts.stagingBranch,
      worktreePath: opts.stagingWorktreePath,
      identity,
    })
    : spawnAgent(opts.db, {
      handle,
      mission,
      apiKey,
      serverUrl: opts.serverUrl,
      projectDir: opts.projectDir,
      identity,
      branch: opts.stagingBranch,
      worktreePath: opts.stagingWorktreePath,
    });

  // Register condenser as sprint agent
  opts.db.prepare(
    `INSERT OR IGNORE INTO sprint_agents (
      sprint_name, agent_handle, identity_name, mission, track, approach_group, approach_label
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(opts.sprintName, handle, "condenser", mission, "synthesis", "__synthesis__", "Condenser");

  // Time-box: kill after 10 minutes
  setTimeout(async () => {
    const { isProcessAlive, killAgent } = await import("./spawner.js");
    if (isProcessAlive(result.pid)) {
      try {
        killAgent(opts.db, handle, opts.projectDir);
      } catch { /* already dead */ }
    }
  }, CONDENSER_TIMEOUT_MS);

  return { handle, pid: result.pid };
}

export async function syncSprintCompressionState(
  projectDir: string,
  db: Database.Database,
  sprintName: string,
): Promise<SprintCompression | null> {
  const { getSpawn, isProcessAlive, killAgent } = await import("./spawner.js");
  const compression = getSprintCompression(db, sprintName);
  if (!compression || compression.status !== "running" || !compression.condenser_handle) {
    return compression;
  }

  let spawn = getSpawn(db, compression.condenser_handle);
  const timedOut = (elapsedMsSince(compression.started_at ?? spawn?.started_at ?? null) ?? 0) > CONDENSER_TIMEOUT_MS;

  if (spawn && !spawn.stopped_at && isProcessAlive(spawn.pid)) {
    if (!timedOut) {
      return compression;
    }
    try {
      killAgent(db, compression.condenser_handle, projectDir);
    } catch {
      // Best effort; the status update below still marks the run failed.
    }
    spawn = getSpawn(db, compression.condenser_handle);
  }

  const finalStats = compression.staging_branch ? parseNumstat(projectDir, compression.staging_branch) : null;
  const nextStatus = timedOut || spawn?.exit_code !== 0 ? "failed" : "ready";
  const updated = upsertSprintCompression(db, sprintName, {
    status: nextStatus,
    after_additions: finalStats?.additions ?? compression.after_additions ?? compression.before_additions,
    after_deletions: finalStats?.deletions ?? compression.after_deletions ?? compression.before_deletions,
    after_files_changed: finalStats?.filesChanged ?? compression.after_files_changed ?? compression.before_files_changed,
    error_message: nextStatus === "failed"
      ? compression.error_message ?? (timedOut
        ? `Condenser exceeded ${Math.round(CONDENSER_TIMEOUT_MS / 60000)} minutes and was stopped`
        : `Condenser exited with code ${spawn?.exit_code ?? "unknown"}`)
      : null,
    finished_at: currentUtcIso(),
  });

  db.prepare("UPDATE sprints SET status = ?, finished_at = ? WHERE name = ?")
    .run(nextStatus === "ready" ? "ready" : "failed", updated.finished_at, sprintName);
  return updated;
}

export interface StartSprintCompressionResult {
  compression: SprintCompression;
  launched: boolean;
  merged: string[];
  conflicted: string[];
}

export async function startSprintCompression(opts: {
  sprintName: string;
  projectDir: string;
  serverUrl: string;
  db: Database.Database;
}): Promise<StartSprintCompressionResult> {
  const { listSpawns, isProcessAlive } = await import("./spawner.js");

  const sprint = opts.db.prepare("SELECT * FROM sprints WHERE name = ?").get(opts.sprintName) as Sprint | undefined;
  if (!sprint) {
    throw new Error(`Sprint not found: ${opts.sprintName}`);
  }
  if (sprint.status === "finished") {
    throw new Error(`Sprint "${opts.sprintName}" is already finished.`);
  }

  const workerAgents = getWorkerSprintAgents(opts.db, opts.sprintName);
  const workerHandles = workerAgents.map((agent) => agent.agent_handle);
  const spawns = listSpawns(opts.db);
  const running = workerAgents
    .map((agent) => spawns.find((spawn) => spawn.agent_handle === agent.agent_handle))
    .filter((spawn): spawn is NonNullable<typeof spawn> => !!spawn)
    .filter((spawn) => !spawn.stopped_at && isProcessAlive(spawn.pid))
    .map((spawn) => spawn.agent_handle);

  if (running.length > 0) {
    throw new Error(`Sprint "${opts.sprintName}" still has running agents: ${running.join(", ")}`);
  }

  let compression = await syncSprintCompressionState(opts.projectDir, opts.db, opts.sprintName);
  if (compression?.status === "ready" || compression?.status === "bypassed") {
    return { compression, launched: false, merged: [], conflicted: [] };
  }
  if (compression?.status === "running") {
    return { compression, launched: false, merged: [], conflicted: [] };
  }

  const branch = compression?.staging_branch ?? createStagingBranch(opts.projectDir, opts.sprintName);
  const worktreePath = compression?.staging_worktree_path ?? ensureStagingWorktree(opts.projectDir, opts.sprintName).worktreePath;

  let merged: string[] = [];
  let conflicted: string[] = [];
  if (!compression || compression.status === "pending") {
    ({ merged, conflicted } = await mergeAgentsToStaging(worktreePath, workerHandles, opts.db));
  }

  const baseline = parseNumstat(opts.projectDir, branch);
  compression = upsertSprintCompression(opts.db, opts.sprintName, {
    status: "running",
    staging_branch: branch,
    staging_worktree_path: worktreePath,
    before_additions: baseline?.additions ?? compression?.before_additions ?? 0,
    before_deletions: baseline?.deletions ?? compression?.before_deletions ?? 0,
    before_files_changed: baseline?.filesChanged ?? compression?.before_files_changed ?? 0,
    after_additions: null,
    after_deletions: null,
    after_files_changed: null,
    error_message: null,
    bypass_reason: null,
    started_at: currentUtcIso(),
    finished_at: null,
  });
  opts.db.prepare("UPDATE sprints SET status = 'compressing', finished_at = NULL WHERE name = ?").run(opts.sprintName);

  const beforeLines = Math.max(0, compression.before_additions - compression.before_deletions);
  const condenser = await spawnCondenser({
    sprintName: opts.sprintName,
    stagingBranch: branch,
    stagingWorktreePath: worktreePath,
    projectDir: opts.projectDir,
    serverUrl: opts.serverUrl,
    db: opts.db,
    beforeLines,
  });

  compression = upsertSprintCompression(opts.db, opts.sprintName, {
    condenser_handle: condenser.handle,
  });

  return { compression, launched: true, merged, conflicted };
}

export function bypassSprintCompression(
  db: Database.Database,
  sprintName: string,
  reason: string,
): SprintCompression {
  if (!reason.trim()) {
    throw new Error("A bypass reason is required.");
  }
  db.prepare("UPDATE sprints SET status = 'ready' WHERE name = ?").run(sprintName);
  return upsertSprintCompression(db, sprintName, {
    status: "bypassed",
    bypass_reason: reason.trim(),
    finished_at: currentUtcIso(),
  });
}

/**
 * Build a compression report from the persisted sprint synthesis record.
 */
export async function buildCompressionReport(
  projectDir: string,
  db: Database.Database,
  sprintName: string,
): Promise<CompressionReport | null> {
  const { getSpawn } = await import("./spawner.js");

  const compression = await syncSprintCompressionState(projectDir, db, sprintName);
  if (!compression) return null;

  const condenserSpawn = compression.condenser_handle
    ? getSpawn(db, compression.condenser_handle)
    : null;
  const condenserRuntime = condenserSpawn?.started_at
    ? formatDuration(condenserSpawn.started_at, condenserSpawn.stopped_at)
    : null;

  const beforeLines = Math.max(0, compression.before_additions - compression.before_deletions);
  const afterAdditions = compression.after_additions ?? compression.before_additions;
  const afterDeletions = compression.after_deletions ?? compression.before_deletions;
  const afterFilesChanged = compression.after_files_changed ?? compression.before_files_changed;
  const afterLines = Math.max(0, afterAdditions - afterDeletions);
  const ratio = beforeLines > 0
    ? Math.max(0, (beforeLines - afterLines) / beforeLines)
    : 0;

  return {
    status: compression.status,
    stagingBranch: compression.staging_branch,
    stagingWorktreePath: compression.staging_worktree_path,
    beforeLines,
    afterLines,
    ratio,
    condenserExitCode: condenserSpawn?.exit_code ?? null,
    condenserRuntime,
    beforeAdditions: compression.before_additions,
    beforeDeletions: compression.before_deletions,
    beforeFilesChanged: compression.before_files_changed,
    afterAdditions,
    afterDeletions,
    afterFilesChanged,
    errorMessage: compression.error_message,
    bypassReason: compression.bypass_reason,
  };
}

/**
 * Squash-merge the staging branch into main as a single commit.
 */
export function squashMergeToMain(
  projectDir: string,
  stagingBranch: string,
  sprintName: string,
  goal: string,
  stagingWorktreePath?: string | null,
): void {
  execSync(`git merge --squash ${stagingBranch}`, {
    cwd: projectDir,
    stdio: "pipe",
  });

  execSync(`git commit -m "feat: ${goal} (sprint: ${sprintName})"`, {
    cwd: projectDir,
    stdio: "pipe",
  });

  if (stagingWorktreePath && fs.existsSync(stagingWorktreePath)) {
    try {
      execSync(`git worktree remove "${stagingWorktreePath}" --force`, {
        cwd: projectDir,
        stdio: "pipe",
      });
    } catch { /* best effort */ }
  }

  try {
    execSync(`git branch -D ${stagingBranch}`, { cwd: projectDir, stdio: "pipe" });
  } catch { /* best effort */ }
}
