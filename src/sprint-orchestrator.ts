import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { Sprint, SprintAgent, SprintReport, SprintAgentReport, SprintBranch, AgentBrief, LandingBrief, CompressionReport } from "./types.js";
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
  opts: { skipTests?: boolean; agentHandles?: string[] } = {}
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

export const SPRINT_REPORT_PROTOCOL = `

## Completion Report Protocol

When you finish your work, post a structured completion report to #work with this exact format:

REPORT: <one-line summary of what you built/changed>
ARCHITECTURE: <how it's designed, component boundaries, key decisions>
DATA FLOW: <input → transform → output, how data moves through your changes>
EDGE CASES: <what edge cases you handled, what's not handled>
TESTS: <test count, coverage areas, what scenarios are tested>

This report will be shown to the CEO in the sprint finish view.
`;

// === Shared sprint data gathering ===
//
//  gatherSprintData() → { sprint, agentData[], preflight }
//     ├── buildSprintReport() maps agentData → SprintAgentReport[]
//     └── buildLandingBrief()  maps agentData → AgentBrief[]

interface GatheredAgentData {
  handle: string;
  mission: string | null;
  spawn: import("./spawner.js").SpawnRecord | undefined;
  alive: boolean;
  stopped: boolean;
  report: import("./types.js").ParsedAgentReport | null;
  lastPost: string | null;
  lastPosts: { content: string; created_at: string }[];
  stats: NumstatResult | null;
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

  const sprintAgents = db.prepare("SELECT * FROM sprint_agents WHERE sprint_name = ?").all(sprintName) as SprintAgent[];
  const spawns = listSpawns(db);

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
      spawn,
      alive,
      stopped,
      report,
      lastPost: lastPosts[0]?.content ?? null,
      lastPosts,
      stats,
    });
  }

  db.close();

  const handles = sprintAgents.map((sa) => sa.agent_handle);
  const preflight = await runPreFlight(projectDir, { skipTests: opts.skipTests ?? false, agentHandles: handles });

  return { sprint, agentData, escalationCount, preflight };
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
  const { sprint, agentData, preflight } = await gatherSprintData(sprintName, projectDir, { skipTests: false });

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
    };
  });

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
  const { sprint, agentData, escalationCount, preflight } = await gatherSprintData(sprintName, projectDir, { skipTests: true });

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
    };
  });

  return {
    sprint,
    agents: agentReports,
    totals: { additions: totalAdditions, deletions: totalDeletions, filesChanged: totalFiles },
    conflicts: preflight.conflicts,
    escalations: escalationCount,
    mergeOrder: preflight.mergeOrder,
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
  const fileOwners = new Map<string, string>();
  const overlaps: string[] = [];
  for (const spec of specs) {
    for (const file of spec.scope ?? []) {
      const existingOwner = fileOwners.get(file);
      if (existingOwner) {
        overlaps.push(`${file} claimed by both ${existingOwner} and ${spec.handle}`);
      } else {
        fileOwners.set(file, spec.handle);
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

  // Create sprint record
  opts.db.prepare("INSERT INTO sprints (name, goal) VALUES (?, ?)").run(opts.name, opts.goal);

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

      let mission = spec.mission;
      let identity = undefined;

      if (spec.identity) {
        try {
          identity = loadIdentity(spec.identity, opts.projectDir);
          identity = { ...identity, content: identity.content + SPRINT_REPORT_PROTOCOL };
        } catch {
          const identityPath = path.join(opts.projectDir, "identities", `${spec.identity}.md`);
          if (fs.existsSync(identityPath)) {
            const identityContent = fs.readFileSync(identityPath, "utf-8");
            mission = `[Identity: ${spec.identity}]\n${identityContent}\n\n${mission}`;
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
        "INSERT INTO sprint_agents (sprint_name, agent_handle, identity_name, mission) VALUES (?, ?, ?, ?)"
      ).run(opts.name, handle, spec.identity || null, spec.mission);

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

/**
 * Create a staging branch from main for the sprint.
 * Returns the branch name.
 */
export function createStagingBranch(projectDir: string, sprintName: string): string {
  const branch = `staging/${sprintName}`;
  try {
    execSync(`git branch -D ${branch}`, { cwd: projectDir, stdio: "pipe" });
  } catch { /* branch didn't exist */ }
  execSync(`git branch ${branch} main`, { cwd: projectDir, stdio: "pipe" });
  return branch;
}

/**
 * Merge all agent branches into the staging branch.
 * Returns list of successfully merged handles and any that had conflicts.
 * Conflict markers are left in place for the condenser to resolve.
 */
export async function mergeAgentsToStaging(
  projectDir: string,
  stagingBranch: string,
  agentHandles: string[],
  db: Database.Database,
): Promise<{ merged: string[]; conflicted: string[] }> {
  const { getSpawn } = await import("./spawner.js");

  // Checkout staging branch
  execSync(`git checkout ${stagingBranch}`, { cwd: projectDir, stdio: "pipe" });

  const merged: string[] = [];
  const conflicted: string[] = [];

  for (const handle of agentHandles) {
    const spawn = getSpawn(db, handle);
    if (!spawn?.branch) continue;

    try {
      execSync(`git merge ${spawn.branch} --no-edit`, {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
      merged.push(handle);
    } catch {
      // Merge conflict — commit with markers for condenser to resolve
      try {
        execSync(`git add -A && git commit -m "merge ${handle} (conflicts for condenser)"`, {
          cwd: projectDir,
          stdio: "pipe",
          shell: "/bin/bash",
        });
        conflicted.push(handle);
      } catch {
        // If we can't even commit, abort the merge
        try { execSync("git merge --abort", { cwd: projectDir, stdio: "pipe" }); } catch { /* */ }
      }
    }
  }

  // Return to main
  execSync("git checkout main", { cwd: projectDir, stdio: "pipe" });

  return { merged, conflicted };
}

/**
 * Spawn the condenser agent on the staging branch.
 * Returns the condenser's handle and a timeout that will kill it.
 */
export async function spawnCondenser(opts: {
  sprintName: string;
  stagingBranch: string;
  projectDir: string;
  serverUrl: string;
  db: Database.Database;
  beforeLines: number;
}): Promise<{ handle: string; pid: number }> {
  const { spawnAgent } = await import("./spawner.js");
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

  const mission = `Compress the code on branch ${opts.stagingBranch}. ` +
    `Baseline: +${opts.beforeLines} lines vs main. ` +
    `Goal: same tests passing, fewer lines. ` +
    `Work directly on this branch — do not create new branches.`;

  const result = spawnAgent(opts.db, {
    handle,
    mission,
    apiKey,
    serverUrl: opts.serverUrl,
    projectDir: opts.projectDir,
    identity,
  });

  // Register condenser as sprint agent
  opts.db.prepare(
    "INSERT OR IGNORE INTO sprint_agents (sprint_name, agent_handle, identity_name, mission) VALUES (?, ?, ?, ?)"
  ).run(opts.sprintName, handle, "condenser", mission);

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

/**
 * Build a compression report by comparing staging branch LOC to pre-compression baseline.
 */
export async function buildCompressionReport(
  projectDir: string,
  stagingBranch: string,
  beforeLines: number,
  db: Database.Database,
  condenserHandle: string,
): Promise<CompressionReport> {
  const { getSpawn } = await import("./spawner.js");

  const stats = parseNumstat(projectDir, stagingBranch);
  const afterLines = stats ? stats.additions - stats.deletions : beforeLines;

  const condenserSpawn = getSpawn(db, condenserHandle);
  const condenserRuntime = condenserSpawn?.started_at
    ? formatDuration(condenserSpawn.started_at, condenserSpawn.stopped_at)
    : null;

  const ratio = beforeLines > 0
    ? Math.max(0, (beforeLines - afterLines) / beforeLines)
    : 0;

  return {
    beforeLines,
    afterLines: Math.max(0, afterLines),
    ratio,
    condenserExitCode: condenserSpawn?.exit_code ?? null,
    condenserRuntime,
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
): void {
  execSync(`git merge --squash ${stagingBranch}`, {
    cwd: projectDir,
    stdio: "pipe",
  });

  execSync(`git commit -m "feat: ${goal} (sprint: ${sprintName})"`, {
    cwd: projectDir,
    stdio: "pipe",
  });

  // Clean up staging branch
  try {
    execSync(`git branch -D ${stagingBranch}`, { cwd: projectDir, stdio: "pipe" });
  } catch { /* best effort */ }
}
