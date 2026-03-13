import { execSync } from "child_process";
import type { Sprint, SprintAgent, SprintReport, SprintAgentReport, SprintBranch } from "./types.js";
import { parseAgentReport } from "./render.js";

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
  // If specific handles provided, filter to those; otherwise use all
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
    try {
      const numstat = execSync(`git diff --numstat main..${s.branch}`, {
        cwd: projectDir,
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
      // Branch not found — skip
    }
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

// === Sprint helper: build report for a sprint ===

export async function buildSprintReport(
  sprintName: string,
  projectDir: string,
  detail = false,
): Promise<SprintReport> {
  const { getDb } = await import("./db.js");
  const { listSpawns, isProcessAlive } = await import("./spawner.js");
  const db = getDb(projectDir);

  // Get sprint
  const sprint = db.prepare("SELECT * FROM sprints WHERE name = ?").get(sprintName) as Sprint | undefined;
  if (!sprint) {
    db.close();
    throw new Error(`Sprint not found: ${sprintName}`);
  }

  // Get sprint agents
  const sprintAgents = db.prepare("SELECT * FROM sprint_agents WHERE sprint_name = ?").all(sprintName) as SprintAgent[];
  const spawns = listSpawns(db);

  // Get escalation count since sprint started
  const escalationCount = (db.prepare(
    "SELECT COUNT(*) as count FROM posts WHERE channel = '#escalations' AND created_at >= ?"
  ).get(sprint.created_at) as { count: number }).count;

  // Build per-agent reports
  const agentReports: SprintAgentReport[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalFiles = 0;

  const { markSpawnStopped: markStopped } = await import("./spawner.js");
  for (const sa of sprintAgents) {
    const spawn = spawns.find((s) => s.agent_handle === sa.agent_handle);
    const alive = spawn && !spawn.stopped_at ? isProcessAlive(spawn.pid) : false;
    const stopped = spawn ? !!spawn.stopped_at || !alive : true;

    // Auto-mark dead agents as stopped (process exited but exit handler didn't fire)
    if (spawn && !spawn.stopped_at && !alive) {
      markStopped(db, sa.agent_handle);
    }

    // Get last post
    const lastPost = db.prepare(
      "SELECT content FROM posts WHERE author = ? ORDER BY created_at DESC LIMIT 1"
    ).get(sa.agent_handle) as { content: string } | undefined;

    // Try to find a structured report in recent posts
    let parsedReport = null;
    if (lastPost) {
      // Search recent posts for REPORT: marker
      const recentPosts = db.prepare(
        "SELECT content FROM posts WHERE author = ? ORDER BY created_at DESC LIMIT 10"
      ).all(sa.agent_handle) as { content: string }[];
      for (const p of recentPosts) {
        parsedReport = parseAgentReport(p.content);
        if (parsedReport) break;
      }
    }

    // Get diff stats
    let additions = 0, deletions = 0, filesChanged = 0;
    if (spawn?.branch) {
      try {
        const numstat = execSync(`git diff --numstat main..${spawn.branch}`, {
          cwd: projectDir, encoding: "utf-8", stdio: "pipe",
        }).trim();
        if (numstat) {
          for (const line of numstat.split("\n")) {
            const parts = line.split("\t");
            if (parts.length >= 3) {
              additions += parseInt(parts[0], 10) || 0;
              deletions += parseInt(parts[1], 10) || 0;
              filesChanged++;
            }
          }
        }
      } catch { /* branch not found */ }
    }

    totalAdditions += additions;
    totalDeletions += deletions;
    totalFiles += filesChanged;

    agentReports.push({
      handle: sa.agent_handle,
      branch: spawn?.branch || null,
      alive,
      stopped,
      exitCode: spawn?.exit_code ?? null,
      additions,
      deletions,
      filesChanged,
      mission: sa.mission,
      lastPost: lastPost?.content || null,
      report: parsedReport,
    });
  }

  db.close();

  // Get merge order + conflicts from pre-flight (skip tests for speed)
  const handles = sprintAgents.map((sa) => sa.agent_handle);
  const pf = await runPreFlight(projectDir, { skipTests: true, agentHandles: handles });

  return {
    sprint,
    agents: agentReports,
    totals: { additions: totalAdditions, deletions: totalDeletions, filesChanged: totalFiles },
    conflicts: pf.conflicts,
    escalations: escalationCount,
    mergeOrder: pf.mergeOrder,
  };
}
