import type { Agent, DagCommit, Post, RankedPost, Team, TeamMember, Route, Sprint, SprintReport, SprintAgentReport, Alert, AgentBrief, LandingBrief, CompressionReport } from "./types.js";
import type { PostThread } from "./posts.js";
import type { BriefingSummary } from "./supervision.js";
import type { DagSummary, PromoteResult } from "./gitdag.js";

// === ANSI colors — respects NO_COLOR env var ===

const useColor = !process.env.NO_COLOR;

export const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  red: useColor ? "\x1b[31m" : "",
  green: useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  gray: useColor ? "\x1b[90m" : "",
};

function colorHandle(handle: string): string {
  return `${c.green}${handle}${c.reset}`;
}

function colorChannel(channel: string): string {
  return `${c.cyan}${channel}${c.reset}`;
}

function colorTime(time: string): string {
  return `${c.gray}${time}${c.reset}`;
}

function colorPriority(pri: number): string {
  if (pri >= 50) return `${c.red}[pri:${pri}]${c.reset}`;
  if (pri > 0) return `${c.yellow}[pri:${pri}]${c.reset}`;
  return "";
}

function colorStatus(status: string): string {
  if (status === "active") return `${c.green}${status}${c.reset}`;
  if (status === "blocked") return `${c.red}${status}${c.reset}`;
  if (status === "stopped") return `${c.dim}${status}${c.reset}`;
  return `${c.yellow}${status}${c.reset}`;
}

function formatTime(iso: string): string {
  // Ensure UTC parsing — append Z if missing
  const normalized = iso.endsWith("Z") ? iso : iso + "Z";
  const d = new Date(normalized);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export function renderPost(post: Post | RankedPost, indent = 0): string {
  const pad = "  ".repeat(indent);
  const time = colorTime(formatTime(post.created_at));
  const shortId = `${c.dim}${post.id.slice(0, 8)}${c.reset}`;
  const author = colorHandle(post.author);
  const channel = colorChannel(post.channel);
  const pri = "priority" in post && post.priority > 0 ? ` ${colorPriority(post.priority)}` : "";

  return `${pad}${shortId}  ${author}  ${channel}${pri}  ${time}\n${pad}  ${post.content}`;
}

export const renderRankedPost = renderPost;

export function renderThread(thread: PostThread, indent = 0): string {
  const lines: string[] = [renderPost(thread.post, indent)];
  for (const reply of thread.replies) {
    lines.push(renderThread(reply, indent + 1));
  }
  return lines.join("\n\n");
}

export function renderFeed(posts: RankedPost[]): string {
  if (posts.length === 0) return `  ${c.dim}No posts.${c.reset}`;
  return posts.map((p) => renderRankedPost(p)).join("\n\n");
}

export function renderAgent(agent: Agent): string {
  const lines = [
    `${colorHandle(agent.handle)}  [${colorStatus(agent.status)}]`,
    `  Name:    ${agent.name}`,
    `  Mission: ${agent.mission}`,
  ];

  const meta = agent.metadata;
  if (meta && Object.keys(meta).length > 0) {
    lines.push(`  Metadata: ${JSON.stringify(meta)}`);
  }

  lines.push(`  Created: ${colorTime(agent.created_at)}`);
  return lines.join("\n");
}

export function renderAgentList(agents: Agent[]): string {
  if (agents.length === 0) return `  ${c.dim}No agents.${c.reset}`;
  return agents
    .map((a) => `  ${colorHandle(a.handle)}  ${a.name}  [${colorStatus(a.status)}]  ${a.mission}`)
    .join("\n");
}

export function renderProfile(agent: Agent, posts: Post[]): string {
  const lines = [
    "--- Profile ---",
    renderAgent(agent),
    "",
    `--- Posts (${posts.length}) ---`,
  ];
  if (posts.length === 0) {
    lines.push("  No posts.");
  } else {
    lines.push(posts.map((p) => renderPost(p)).join("\n\n"));
  }
  return lines.join("\n");
}

export function renderBriefing(briefing: BriefingSummary): string {
  if (briefing.total === 0) {
    const since = briefing.since ? ` since ${formatTime(briefing.since)}` : "";
    return `  Nothing new${since}.`;
  }

  const lines: string[] = [];
  const since = briefing.since ? formatTime(briefing.since) : "the beginning";
  lines.push(`  ${briefing.total} posts since ${since}:`);
  lines.push("");

  for (const ch of briefing.channels) {
    const pri = ch.priority > 0 ? ` ${colorPriority(ch.priority)}` : "";
    lines.push(`  ${colorChannel(ch.name)}${pri}: ${ch.count} post${ch.count === 1 ? "" : "s"}`);

    // Show full text for high-priority channels
    if (ch.priority >= 50) {
      for (const post of ch.posts) {
        lines.push(`    ${c.dim}${post.id.slice(0, 8)}${c.reset}  ${colorHandle(post.author)}  ${colorTime(formatTime(post.created_at))}`);
        lines.push(`      ${post.content}`);
      }
    }
  }

  return lines.join("\n");
}

export function renderChannelList(
  channels: { name: string; description: string | null; priority: number }[]
): string {
  if (channels.length === 0) return `  ${c.dim}No channels.${c.reset}`;
  return channels
    .sort((a, b) => b.priority - a.priority)
    .map((ch) => {
      const pri = ch.priority > 0 ? ` ${colorPriority(ch.priority)}` : "";
      const desc = ch.description ? `  ${c.dim}${ch.description}${c.reset}` : "";
      return `  ${colorChannel(ch.name)}${pri}${desc}`;
    })
    .join("\n");
}

// === Spawn rendering ===

export interface SpawnInfo {
  agent_handle: string;
  pid: number;
  started_at: string;
  stopped_at: string | null;
  alive: boolean;
}

export function renderSpawnList(spawns: SpawnInfo[]): string {
  if (spawns.length === 0) return `  ${c.dim}No spawned agents.${c.reset}`;
  return spawns
    .map((s) => {
      const status = s.stopped_at
        ? `${c.dim}stopped${c.reset}`
        : s.alive
          ? `${c.green}running${c.reset}`
          : `${c.red}dead${c.reset}`;
      const time = colorTime(formatTime(s.started_at));
      return `  ${colorHandle(s.agent_handle)}  PID ${s.pid}  [${status}]  ${time}`;
    })
    .join("\n");
}

export function renderStatus(info: {
  agents: { total: number; active: number; blocked: number; stopped: number };
  posts: number;
  channels: { name: string; priority: number }[];
  spawns: SpawnInfo[];
}): string {
  const lines: string[] = [];
  lines.push(`${c.bold}AgentBoard Status${c.reset}`);
  lines.push("");
  lines.push(`  Agents:  ${info.agents.total} total (${c.green}${info.agents.active} active${c.reset}, ${c.red}${info.agents.blocked} blocked${c.reset}, ${c.dim}${info.agents.stopped} stopped${c.reset})`);
  lines.push(`  Posts:   ${info.posts}`);
  lines.push("");
  lines.push(`  Channels:`);
  for (const ch of info.channels) {
    const pri = ch.priority > 0 ? ` ${colorPriority(ch.priority)}` : "";
    lines.push(`    ${colorChannel(ch.name)}${pri}`);
  }
  if (info.spawns.length > 0) {
    lines.push("");
    lines.push(`  Spawned:`);
    lines.push(renderSpawnList(info.spawns));
  }
  return lines.join("\n");
}

// === DAG rendering ===

function colorHash(hash: string): string {
  return `${c.yellow}${hash.slice(0, 8)}${c.reset}`;
}

export function renderDagCommit(commit: DagCommit): string {
  const time = colorTime(formatTime(commit.created_at));
  const parent = commit.parent_hash ? `${c.dim}← ${commit.parent_hash.slice(0, 8)}${c.reset}` : `${c.dim}(root)${c.reset}`;
  return `  ${colorHash(commit.hash)}  ${colorHandle(commit.agent_handle)}  ${parent}  ${time}\n    ${commit.message}`;
}

export function renderDagLog(commits: DagCommit[]): string {
  if (commits.length === 0) return `  ${c.dim}No DAG commits.${c.reset}`;
  return commits.map(renderDagCommit).join("\n\n");
}

/**
 * Render a DAG tree showing commit ancestry.
 *
 *   ● abc12345  @auth-mgr  "Implement JWT validation"
 *   │
 *   ├── def67890  @auth-mgr  "Add token refresh"
 *   └── 11223344  @auth-mgr  "Try session-based instead"  ★ leaf
 */
export function renderDagTree(
  commits: DagCommit[],
  leaves: Set<string>
): string {
  if (commits.length === 0) return `  ${c.dim}No DAG commits.${c.reset}`;

  // Build parent→children map
  const childrenMap = new Map<string, DagCommit[]>();
  const roots: DagCommit[] = [];

  for (const commit of commits) {
    if (!commit.parent_hash) {
      roots.push(commit);
    } else {
      const children = childrenMap.get(commit.parent_hash) ?? [];
      children.push(commit);
      childrenMap.set(commit.parent_hash, children);
    }
  }

  function renderNode(commit: DagCommit, prefix: string, isLast: boolean): string[] {
    const connector = prefix === "" ? "●" : isLast ? "└──" : "├──";
    const leaf = leaves.has(commit.hash) ? `  ${c.green}★ leaf${c.reset}` : "";
    const line = `${prefix}${connector} ${colorHash(commit.hash)}  ${colorHandle(commit.agent_handle)}  "${commit.message}"${leaf}`;

    const lines = [line];
    const children = childrenMap.get(commit.hash) ?? [];
    const childPrefix = prefix === "" ? "" : prefix + (isLast ? "    " : "│   ");

    if (children.length > 0 && prefix === "") {
      lines.push(`${childPrefix}│`);
    }

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const last = i === children.length - 1;
      lines.push(...renderNode(child, childPrefix, last));
    }

    return lines;
  }

  const allLines: string[] = [];
  for (const root of roots) {
    allLines.push(...renderNode(root, "", true));
    allLines.push("");
  }

  return allLines.join("\n");
}

export function renderPromoteSummary(result: PromoteResult): string {
  return [
    `${c.bold}Promoted to main${c.reset}`,
    `  DAG commit:  ${colorHash(result.originalHash)}`,
    `  Main commit: ${colorHash(result.newHash)}`,
    `  Message:     ${result.message}`,
  ].join("\n");
}

// === Team & Route rendering ===

function colorTeamStatus(status: string): string {
  if (status === "building") return `${c.green}${status}${c.reset}`;
  if (status === "blocked") return `${c.red}${status}${c.reset}`;
  if (status === "done") return `${c.dim}${status}${c.reset}`;
  return `${c.yellow}${status}${c.reset}`;
}

function colorRouteStatus(status: string): string {
  if (status === "chosen") return `${c.green}${status}${c.reset}`;
  if (status === "abandoned") return `${c.dim}${status}${c.reset}`;
  return `${c.yellow}${status}${c.reset}`;
}

export function renderTeam(team: Team & { members?: TeamMember[] }): string {
  const lines = [
    `${c.bold}${team.name}${c.reset}  [${colorTeamStatus(team.status)}]`,
    `  Mission: ${team.mission}`,
    `  Manager: ${colorHandle(team.manager)}`,
  ];
  if (team.members && team.members.length > 0) {
    lines.push(`  Members: ${team.members.map((m) => colorHandle(m.agent_handle)).join(", ")}`);
  } else {
    lines.push(`  Members: ${c.dim}none${c.reset}`);
  }
  lines.push(`  Created: ${colorTime(formatTime(team.created_at))}`);
  return lines.join("\n");
}

export function renderTeamList(teams: Team[]): string {
  if (teams.length === 0) return `  ${c.dim}No teams.${c.reset}`;
  return teams
    .map((t) => `  ${c.bold}${t.name}${c.reset}  [${colorTeamStatus(t.status)}]  ${c.dim}${t.mission}${c.reset}`)
    .join("\n");
}

export function renderRoute(route: Route): string {
  const lines = [
    `${c.bold}${route.name}${c.reset}  [${colorRouteStatus(route.status)}]`,
    `  Agent: ${colorHandle(route.agent_handle)}`,
    `  Team:  ${route.team_name}`,
    `  Created: ${colorTime(formatTime(route.created_at))}`
  ];
  return lines.join("\n");
}

export function renderRouteList(routes: Route[]): string {
  if (routes.length === 0) return `  ${c.dim}No routes.${c.reset}`;
  return routes
    .map((r) => `  ${c.bold}${r.name}${c.reset}  [${colorRouteStatus(r.status)}]  ${colorHandle(r.agent_handle)}  ${c.dim}${r.team_name}${c.reset}`)
    .join("\n");
}

export function renderOrg(teams: (Team & { members?: TeamMember[] })[], routes: Route[]): string {
  const lines: string[] = [];
  lines.push(`${c.bold}Organization${c.reset}`);
  lines.push("");

  if (teams.length === 0) {
    lines.push(`  ${c.dim}No teams.${c.reset}`);
  } else {
    for (const team of teams) {
      const members = team.members && team.members.length > 0
        ? team.members.map((m) => colorHandle(m.agent_handle)).join(", ")
        : `${c.dim}none${c.reset}`;
      lines.push(`  ${c.bold}${team.name}${c.reset}  [${colorTeamStatus(team.status)}]  mgr:${colorHandle(team.manager)}`);
      lines.push(`    ${c.dim}${team.mission}${c.reset}`);
      lines.push(`    Members: ${members}`);

      const teamRoutes = routes.filter((r) => r.team_name === team.name);
      if (teamRoutes.length > 0) {
        lines.push(`    Routes:`);
        for (const r of teamRoutes) {
          lines.push(`      ${c.bold}${r.name}${c.reset}  [${colorRouteStatus(r.status)}]  ${colorHandle(r.agent_handle)}`);
        }
      }
      lines.push("");
    }
  }

  // Show orphan routes (not belonging to any listed team)
  const teamNames = new Set(teams.map((t) => t.name));
  const orphanRoutes = routes.filter((r) => !teamNames.has(r.team_name));
  if (orphanRoutes.length > 0) {
    lines.push(`  ${c.dim}Unassigned routes:${c.reset}`);
    for (const r of orphanRoutes) {
      lines.push(`    ${c.bold}${r.name}${c.reset}  [${colorRouteStatus(r.status)}]  ${colorHandle(r.agent_handle)}  ${c.dim}${r.team_name}${c.reset}`);
    }
  }

  return lines.join("\n");
}

export function renderDagSummary(summary: DagSummary): string {
  const lines: string[] = [];
  lines.push(`${c.bold}DAG Summary${c.reset}`);
  lines.push(`  Commits: ${summary.totalCommits}  Leaves: ${summary.leafCount}`);

  if (summary.agentActivity.length > 0) {
    lines.push("");
    lines.push("  Activity:");
    for (const a of summary.agentActivity) {
      lines.push(`    ${colorHandle(a.handle)}: ${a.commits} commit${a.commits === 1 ? "" : "s"}`);
    }
  }

  if (summary.recentLeaves.length > 0) {
    lines.push("");
    lines.push("  Recent leaves:");
    for (const leaf of summary.recentLeaves) {
      lines.push(`    ${colorHash(leaf.hash)}  ${colorHandle(leaf.agent_handle)}  "${leaf.message}"`);
    }
  }

  return lines.join("\n");
}

// === Sprint orchestrator rendering ===

export function formatDuration(startIso: string, endIso?: string | null): string {
  const start = new Date(startIso.endsWith("Z") ? startIso : startIso + "Z");
  const end = endIso ? new Date(endIso.endsWith("Z") ? endIso : endIso + "Z") : new Date();
  const diffMs = end.getTime() - start.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function sprintStatusColor(status: Sprint["status"]): string {
  if (status === "running") return c.green;
  if (status === "compressing") return c.yellow;
  if (status === "ready") return c.cyan;
  if (status === "failed") return c.red;
  return c.dim;
}

function groupAgentsByApproach<T extends {
  handle: string;
  track: string | null;
  approachGroup: string | null;
  approachLabel: string | null;
}>(agents: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const agent of agents) {
    const key = agent.approachGroup ?? `__solo__:${agent.handle}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(agent);
    groups.set(key, bucket);
  }
  return Array.from(groups.values());
}

function renderApproachHeader(group: {
  track: string | null;
  approachGroup: string | null;
  approachLabel: string | null;
}[]): string | null {
  const first = group[0];
  if (!first.approachGroup) return null;
  const labels = group
    .map((agent) => agent.approachLabel)
    .filter((label): label is string => !!label);
  const uniqueLabels = Array.from(new Set(labels));
  const track = first.track ? `${c.dim}[track:${first.track}]${c.reset} ` : "";
  const suffix = uniqueLabels.length > 0 ? ` ${c.dim}${uniqueLabels.join(" vs ")}${c.reset}` : "";
  return `  ${track}${c.bold}Approach Group:${c.reset} ${first.approachGroup}${suffix}`;
}

function agentStatusLabel(agent: SprintAgentReport): string {
  if (agent.stopped && agent.exitCode === 0) return `${c.green}\u2713 completed${c.reset}`;
  if (agent.stopped && agent.exitCode !== null && agent.exitCode > 0) return `${c.red}crashed (${agent.exitCode})${c.reset}`;
  if (agent.stopped) return `${c.green}\u2713 stopped${c.reset}`;
  if (agent.alive) return `${c.green}running${c.reset}`;
  return `${c.red}dead${c.reset}`;
}

function renderAgentTileCompact(agent: SprintAgentReport): string {
  const status = agentStatusLabel(agent);
  const stats = `+${agent.additions}/-${agent.deletions}`;
  const files = `${agent.filesChanged} file${agent.filesChanged === 1 ? "" : "s"}`;
  const summary = agent.approachLabel || agent.report?.summary || agent.lastPost || agent.mission || "";
  const truncated = summary.length > 60 ? summary.slice(0, 57) + "..." : summary;
  const suffix = agent.commitCount > 0 ? `  ${c.dim}${agent.commitCount} commits${c.reset}` : "";

  return [
    `  \u250c\u2500 ${colorHandle(agent.handle)} \u2500\u2500 ${status} \u2500\u2500 ${stats} \u2500\u2500 ${files}${suffix} \u2500\u2510`,
    `  \u2502  ${truncated}`,
    `  \u2514${"─".repeat(60)}\u2518`,
  ].join("\n");
}

function renderAgentTileDetailed(agent: SprintAgentReport): string {
  const status = agentStatusLabel(agent);
  const stats = `+${agent.additions}/-${agent.deletions}`;
  const files = `${agent.filesChanged} file${agent.filesChanged === 1 ? "" : "s"}`;

  const lines = [
    `  \u250c\u2500 ${colorHandle(agent.handle)} \u2500\u2500 ${status} \u2500\u2500 ${stats} \u2500\u2500 ${files} \u2500\u2510`,
  ];

  if (agent.mission) {
    lines.push(`  \u2502  ${c.dim}Mission:${c.reset} ${agent.mission}`);
  }
  if (agent.track || agent.approachGroup || agent.approachLabel) {
    const parts = [
      agent.track ? `track:${agent.track}` : null,
      agent.approachGroup ? `group:${agent.approachGroup}` : null,
      agent.approachLabel ? `label:${agent.approachLabel}` : null,
    ].filter(Boolean);
    lines.push(`  \u2502  ${c.dim}${parts.join("  ")}${c.reset}`);
  }
  if (agent.commitCount > 0 || agent.lastDagPushMessage) {
    lines.push(`  \u2502  ${c.dim}Branch:${c.reset} ${agent.commitCount} commit${agent.commitCount === 1 ? "" : "s"}`);
    if (agent.lastDagPushMessage) {
      lines.push(`  \u2502  ${c.dim}DAG:${c.reset} ${agent.lastDagPushMessage}`);
    }
  }

  const report = agent.report;
  if (report) {
    lines.push(`  \u2502  ${c.bold}${report.summary}${c.reset}`);
    if (report.hypothesis) {
      lines.push(`  \u2502`);
      lines.push(`  \u2502  ${c.bold}HYPOTHESIS${c.reset}`);
      for (const line of report.hypothesis.split("\n")) {
        lines.push(`  \u2502    ${line}`);
      }
    }
    if (report.reused) {
      lines.push(`  \u2502`);
      lines.push(`  \u2502  ${c.bold}REUSED${c.reset}`);
      for (const line of report.reused.split("\n")) {
        lines.push(`  \u2502    ${line}`);
      }
    }
    if (report.whyNotExistingCode) {
      lines.push(`  \u2502`);
      lines.push(`  \u2502  ${c.bold}WHY NOT EXISTING CODE${c.reset}`);
      for (const line of report.whyNotExistingCode.split("\n")) {
        lines.push(`  \u2502    ${line}`);
      }
    }
    if (report.whySurvives) {
      lines.push(`  \u2502`);
      lines.push(`  \u2502  ${c.bold}WHY SURVIVES${c.reset}`);
      for (const line of report.whySurvives.split("\n")) {
        lines.push(`  \u2502    ${line}`);
      }
    }
    if (report.newFiles) {
      lines.push(`  \u2502`);
      lines.push(`  \u2502  ${c.bold}NEW FILES${c.reset}`);
      for (const line of report.newFiles.split("\n")) {
        lines.push(`  \u2502    ${line}`);
      }
    }
    if (report.architecture) {
      lines.push(`  \u2502`);
      lines.push(`  \u2502  ${c.bold}ARCHITECTURE${c.reset}`);
      for (const line of report.architecture.split("\n")) {
        lines.push(`  \u2502    ${line}`);
      }
    }
    if (report.dataFlow) {
      lines.push(`  \u2502`);
      lines.push(`  \u2502  ${c.bold}DATA FLOW${c.reset}`);
      for (const line of report.dataFlow.split("\n")) {
        lines.push(`  \u2502    ${line}`);
      }
    }
    if (report.edgeCases) {
      lines.push(`  \u2502`);
      lines.push(`  \u2502  ${c.bold}EDGE CASES${c.reset}`);
      for (const line of report.edgeCases.split("\n")) {
        lines.push(`  \u2502    ${line}`);
      }
    }
    if (report.tests) {
      lines.push(`  \u2502`);
      lines.push(`  \u2502  ${c.bold}TESTS${c.reset}`);
      for (const line of report.tests.split("\n")) {
        lines.push(`  \u2502    ${line}`);
      }
    }
  } else if (agent.lastPost) {
    lines.push(`  \u2502  ${c.dim}Last:${c.reset} ${agent.lastPost}`);
  }

  lines.push(`  \u2514${"─".repeat(60)}\u2518`);
  return lines.join("\n");
}

export function renderSprintReport(report: SprintReport, detail = false): string {
  const lines: string[] = [];
  const duration = formatDuration(report.sprint.created_at, report.sprint.finished_at);
  const statusColor = sprintStatusColor(report.sprint.status);

  lines.push(`${c.bold}SPRINT REPORT: ${report.sprint.name}${c.reset}`);
  lines.push(`Goal: ${report.sprint.goal}  |  Duration: ${duration}  |  Agents: ${report.agents.length}  |  [${statusColor}${report.sprint.status}${c.reset}]`);
  lines.push("");

  const renderTile = detail ? renderAgentTileDetailed : renderAgentTileCompact;
  for (const group of groupAgentsByApproach(report.agents)) {
    const header = renderApproachHeader(group);
    if (header) {
      lines.push(header);
    }
    for (const agent of group) {
      lines.push(renderTile(agent));
    }
  }

  lines.push("");
  lines.push(`  Totals: +${report.totals.additions}/-${report.totals.deletions} across ${report.totals.filesChanged} files`);
  lines.push(`  Conflicts: ${report.conflicts.length === 0 ? "none" : report.conflicts.join(", ")}`);
  lines.push(`  Escalations: ${report.escalations}`);
  if (report.compression) {
    const pct = Math.round(report.compression.ratio * 100);
    lines.push(`  Synthesis: [${report.compression.status}] +${report.compression.beforeLines} -> +${report.compression.afterLines} lines (${pct}% retained reduction)`);
  }

  if (report.mergeOrder.length > 0) {
    lines.push(`  Merge order: ${report.mergeOrder.join(" \u2192 ")}`);
  }

  if (!detail) {
    lines.push(`\n  ${c.dim}Use --detail to expand tiles.${c.reset}`);
  }

  return lines.join("\n");
}

export function renderSprintList(sprints: Sprint[]): string {
  if (sprints.length === 0) return `  ${c.dim}No sprints.${c.reset}`;
  return sprints
    .map((s) => {
      const statusColor = sprintStatusColor(s.status);
      const duration = formatDuration(s.created_at, s.finished_at);
      return `  ${c.bold}${s.name}${c.reset}  [${statusColor}${s.status}${c.reset}]  ${duration}  ${c.dim}${s.goal}${c.reset}`;
    })
    .join("\n");
}

export function renderPortfolio(sprints: { sprint: Sprint; agentCount: number; running: number; stopped: number }[]): string {
  if (sprints.length === 0) return `  ${c.dim}No sprints.${c.reset}`;

  const lines: string[] = [];
  lines.push(`${c.bold}Portfolio${c.reset}  (${sprints.length} sprint${sprints.length === 1 ? "" : "s"})`);
  lines.push("");

  for (const s of sprints) {
    const statusColor = sprintStatusColor(s.sprint.status);
    const duration = formatDuration(s.sprint.created_at, s.sprint.finished_at);
    const agents = `${s.agentCount} agents (${c.green}${s.running} running${c.reset}, ${c.dim}${s.stopped} stopped${c.reset})`;
    lines.push(`  ${c.bold}${s.sprint.name}${c.reset}  [${statusColor}${s.sprint.status}${c.reset}]  ${duration}`);
    lines.push(`    ${s.sprint.goal}`);
    lines.push(`    ${agents}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function renderAlerts(alerts: Alert[]): string {
  if (alerts.length === 0) return `  ${c.green}No alerts. All clear.${c.reset}`;

  const lines: string[] = [];
  lines.push(`${c.bold}${c.red}Alerts${c.reset}  (${alerts.length})`);
  lines.push("");

  for (const a of alerts) {
    const icon = a.type === "escalation" ? "\u26a0" : a.type === "crashed" ? "\u2717" : "\u29d7";
    const typeColor = a.type === "escalation" ? c.yellow : c.red;
    const time = colorTime(formatTime(a.time));
    lines.push(`  ${icon} ${typeColor}[${a.type}]${c.reset}  ${colorHandle(a.agent)}  ${time}`);
    lines.push(`    ${a.message}`);
  }

  return lines.join("\n");
}

// === Report parsing — extracts structured sections from agent posts ===

export function parseAgentReport(content: string): {
  summary: string;
  hypothesis: string | null;
  reused: string | null;
  whyNotExistingCode: string | null;
  whySurvives: string | null;
  newFiles: string | null;
  architecture: string | null;
  dataFlow: string | null;
  edgeCases: string | null;
  tests: string | null;
} | null {
  const reportMatch = content.match(/REPORT:\s*(.+)/);
  if (!reportMatch) return null;

  const summary = reportMatch[1].trim();
  const labels = [
    "HYPOTHESIS",
    "REUSED",
    "WHY NOT EXISTING CODE",
    "WHY SURVIVES",
    "NEW FILES",
    "ARCHITECTURE",
    "DATA FLOW",
    "EDGE CASES",
    "TESTS",
  ];
  const labelPattern = labels
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  function extractSection(label: string): string | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}:\\s*([\\s\\S]*?)(?=(?:${labelPattern}):|$)`, "i");
    const match = content.match(regex);
    if (!match || !match[1].trim()) return null;
    return match[1].trim();
  }

  return {
    summary,
    hypothesis: extractSection("HYPOTHESIS"),
    reused: extractSection("REUSED"),
    whyNotExistingCode: extractSection("WHY NOT EXISTING CODE"),
    whySurvives: extractSection("WHY SURVIVES"),
    newFiles: extractSection("NEW FILES"),
    architecture: extractSection("ARCHITECTURE"),
    dataFlow: extractSection("DATA FLOW"),
    edgeCases: extractSection("EDGE CASES"),
    tests: extractSection("TESTS"),
  };
}

// === Landing Brief rendering ===

function agentStatusIcon(status: "passed" | "crashed" | "running"): string {
  if (status === "passed") return `${c.green}✓${c.reset}`;
  if (status === "crashed") return `${c.red}✗${c.reset}`;
  return `${c.yellow}○${c.reset}`;
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + "...";
}

function landingStatusLabel(brief: LandingBrief): string {
  if (brief.sprint.status === "compressing" || brief.compression?.status === "running") return `${c.yellow}COMPRESSING${c.reset}`;
  if (brief.compression?.status === "failed") return `${c.red}SYNTHESIS FAILED${c.reset}`;
  if (brief.compression?.status === "bypassed") return `${c.yellow}BYPASS REQUIRED${c.reset}`;
  if (brief.summary.running > 0) return `${c.yellow}IN PROGRESS${c.reset}`;
  if (brief.summary.crashed > 0 && brief.summary.passed === 0) return `${c.red}ALL CRASHED${c.reset}`;
  if (brief.summary.crashed > 0) return `${c.yellow}PARTIAL${c.reset}`;
  return `${c.green}READY TO LAND${c.reset}`;
}

function formatClockTime(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "pm" : "am";
  return `${h % 12 || 12}:${m}${ampm}`;
}

export function renderLandingBrief(brief: LandingBrief): string {
  const lines: string[] = [];

  const statusLabel = landingStatusLabel(brief);
  const startTime = formatClockTime(brief.sprint.created_at);
  const endTime = brief.sprint.finished_at ? formatClockTime(brief.sprint.finished_at) : "now";
  const duration = formatDuration(brief.sprint.created_at, brief.sprint.finished_at);

  lines.push(`  Sprint "${brief.sprint.name}" — ${statusLabel}`);
  lines.push(`  Started ${startTime} · Done ${endTime} · ${duration}`);
  lines.push("");

  for (const group of groupAgentsByApproach(brief.agents)) {
    const header = renderApproachHeader(group);
    if (header) {
      lines.push(header);
    }
    for (const agent of group) {
      const icon = agentStatusIcon(agent.status);
      const handle = agent.handle.padEnd(10);

      let summaryText = agent.approachLabel ? `${agent.approachLabel} — ` : "";
      if (agent.status === "crashed") {
        const lastContent = agent.lastPosts[0]?.content ?? "Unknown error";
        summaryText += `Crashed: ${truncate(lastContent, 40)}`;
      } else if (agent.report) {
        summaryText += truncate(agent.report.summary, 50);
      } else if (agent.lastPosts.length > 0) {
        summaryText += truncate(agent.lastPosts[0].content, 50);
      } else if (agent.mission) {
        summaryText += truncate(agent.mission, 50);
      }

      const testPart = agent.testCount !== null ? ` ${agent.testCount} tests.` : "";
      const runtimePart = agent.runtime ? ` ${agent.runtime}` : "";
      const branchPart = agent.commitCount > 0 ? ` ${c.dim}${agent.commitCount} commits${c.reset}` : "";

      lines.push(`  ${handle} ${icon}  ${summaryText}.${testPart}${runtimePart}${branchPart}`);
    }
  }

  lines.push("");

  // Compression badge
  if (brief.compression) {
    const pct = Math.round(brief.compression.ratio * 100);
    const badge = pct > 0
      ? `${c.green}+${brief.compression.beforeLines} → +${brief.compression.afterLines} lines (${pct}% compressed)${c.reset}`
      : `+${brief.compression.afterLines} lines (no compression)`;
    lines.push(`  Synthesis: [${brief.compression.status}] ${badge}`);
    if (brief.compression.condenserRuntime) {
      lines.push(`  ${c.dim}Condenser ran for ${brief.compression.condenserRuntime}${c.reset}`);
    }
    if (brief.compression.errorMessage) {
      lines.push(`  ${c.red}${brief.compression.errorMessage}${c.reset}`);
    }
    if (brief.compression.bypassReason) {
      lines.push(`  ${c.yellow}Bypass:${c.reset} ${brief.compression.bypassReason}`);
    }
    lines.push("");
  }

  const testsPart = brief.summary.totalTests > 0 ? ` · ${brief.summary.totalTests} tests added` : "";
  const conflictsPart = ` · ${brief.conflicts.length} conflicts`;
  lines.push(`  ${brief.summary.passed}/${brief.agents.length} passed${testsPart}${conflictsPart}`);

  return lines.join("\n");
}

// === Research history rendering ===

export interface ResearchSession {
  handle: string;
  tag: string;
  preset: string | null;
  branch: string | null;
  started_at: string;
  stopped_at: string | null;
  experiments: number | null;
  kept: number | null;
  discarded: number | null;
}

export function renderResearchHistory(sessions: ResearchSession[]): string {
  if (sessions.length === 0) return `  ${c.dim}No research sessions found.${c.reset}`;

  const lines: string[] = [];
  lines.push(`${c.bold}Research History${c.reset}  (${sessions.length} session${sessions.length === 1 ? "" : "s"})`);
  lines.push("");

  for (const s of sessions) {
    const tag = s.tag || "(default)";
    const status = s.stopped_at ? `${c.dim}stopped${c.reset}` : `${c.green}running${c.reset}`;
    const duration = formatDuration(s.started_at, s.stopped_at);
    const branch = s.branch ? `${c.dim}${s.branch}${c.reset}` : `${c.dim}no branch${c.reset}`;

    lines.push(`  ${colorHandle(s.handle)}  tag:${c.bold}${tag}${c.reset}  [${status}]  ${duration}  ${branch}`);

    if (s.preset) {
      lines.push(`    preset: ${s.preset}`);
    }

    if (s.experiments !== null) {
      lines.push(`    experiments: ${s.experiments} total — ${s.kept ?? 0} kept, ${s.discarded ?? 0} discarded`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// === Retro rendering ===

export interface RetroAgent {
  handle: string;
  branch: string | null;
  runtime: string;
  exitCode: number | null;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface RetroData {
  sprintName: string;
  goal: string;
  created_at: string;
  finished_at: string | null;
  agents: RetroAgent[];
  conflicts: number;
  testDelta: number | null;
}

export function renderRetro(retro: RetroData): string {
  const lines: string[] = [];
  const duration = formatDuration(retro.created_at, retro.finished_at);
  const status = retro.finished_at ? `${c.dim}finished${c.reset}` : `${c.green}running${c.reset}`;

  lines.push(`${c.bold}RETROSPECTIVE: ${retro.sprintName}${c.reset}  [${status}]`);
  lines.push(`Goal: ${retro.goal}`);
  lines.push(`Duration: ${duration}  |  Agents: ${retro.agents.length}`);
  lines.push("");

  for (const a of retro.agents) {
    const exitLabel = a.exitCode === null ? `${c.yellow}running${c.reset}` : a.exitCode === 0 ? `${c.green}exit 0${c.reset}` : `${c.red}exit ${a.exitCode}${c.reset}`;
    const stats = `+${a.additions}/-${a.deletions} in ${a.filesChanged} file${a.filesChanged === 1 ? "" : "s"}`;
    const branch = a.branch ? `${c.dim}${a.branch}${c.reset}` : "";
    lines.push(`  ${colorHandle(a.handle)}  ${exitLabel}  ${a.runtime}  ${stats}  ${branch}`);
  }

  lines.push("");
  lines.push(`  Merge conflicts: ${retro.conflicts}`);
  if (retro.testDelta !== null) {
    const sign = retro.testDelta >= 0 ? "+" : "";
    lines.push(`  Test delta: ${sign}${retro.testDelta}`);
  }

  return lines.join("\n");
}

export function renderRetroMarkdown(retro: RetroData): string {
  const lines: string[] = [];
  const duration = formatDuration(retro.created_at, retro.finished_at);

  lines.push(`# Retrospective: ${retro.sprintName}`);
  lines.push("");
  lines.push(`- **Goal:** ${retro.goal}`);
  lines.push(`- **Date:** ${retro.created_at.split("T")[0]}`);
  lines.push(`- **Duration:** ${duration}`);
  lines.push(`- **Agents:** ${retro.agents.length}`);
  lines.push(`- **Merge conflicts:** ${retro.conflicts}`);
  if (retro.testDelta !== null) {
    const sign = retro.testDelta >= 0 ? "+" : "";
    lines.push(`- **Test delta:** ${sign}${retro.testDelta}`);
  }
  lines.push("");
  lines.push("## Agents");
  lines.push("");
  lines.push("| Handle | Exit | Runtime | Files | +/- | Branch |");
  lines.push("|--------|------|---------|-------|-----|--------|");

  for (const a of retro.agents) {
    const exit = a.exitCode === null ? "running" : String(a.exitCode);
    lines.push(`| ${a.handle} | ${exit} | ${a.runtime} | ${a.filesChanged} | +${a.additions}/-${a.deletions} | ${a.branch ?? "-"} |`);
  }

  lines.push("");
  return lines.join("\n");
}

export function renderAgentInspect(agent: AgentBrief): string {
  const lines: string[] = [];

  lines.push(`  ${agent.handle} — inspect`);
  lines.push("");

  if (agent.mission) {
    lines.push(`  Mission: ${agent.mission}`);
    lines.push("");
  }
  if (agent.track || agent.approachGroup || agent.approachLabel) {
    const parts = [
      agent.track ? `track:${agent.track}` : null,
      agent.approachGroup ? `group:${agent.approachGroup}` : null,
      agent.approachLabel ? `label:${agent.approachLabel}` : null,
    ].filter(Boolean);
    lines.push(`  ${parts.join("  ")}`);
    lines.push("");
  }
  if (agent.commitCount > 0 || agent.lastDagPushMessage) {
    lines.push(`  Branch summary: ${agent.commitCount} commit${agent.commitCount === 1 ? "" : "s"}`);
    if (agent.lastDagPushMessage) {
      lines.push(`  Last DAG push: ${agent.lastDagPushMessage}`);
    }
    lines.push("");
  }

  if (agent.report) {
    lines.push(`  ${c.bold}REPORT:${c.reset} ${agent.report.summary}`);
    if (agent.report.hypothesis) lines.push(`  ${c.bold}HYPOTHESIS:${c.reset} ${agent.report.hypothesis}`);
    if (agent.report.reused) lines.push(`  ${c.bold}REUSED:${c.reset} ${agent.report.reused}`);
    if (agent.report.whyNotExistingCode) lines.push(`  ${c.bold}WHY NOT EXISTING CODE:${c.reset} ${agent.report.whyNotExistingCode}`);
    if (agent.report.whySurvives) lines.push(`  ${c.bold}WHY SURVIVES:${c.reset} ${agent.report.whySurvives}`);
    if (agent.report.newFiles) lines.push(`  ${c.bold}NEW FILES:${c.reset} ${agent.report.newFiles}`);
    if (agent.report.architecture) lines.push(`  ${c.bold}ARCHITECTURE:${c.reset} ${agent.report.architecture}`);
    if (agent.report.dataFlow) lines.push(`  ${c.bold}DATA FLOW:${c.reset} ${agent.report.dataFlow}`);
    if (agent.report.edgeCases) lines.push(`  ${c.bold}EDGE CASES:${c.reset} ${agent.report.edgeCases}`);
    if (agent.report.tests) lines.push(`  ${c.bold}TESTS:${c.reset} ${agent.report.tests}`);
  } else {
    lines.push(`  No completion report posted.`);
    if (agent.exitCode !== null) lines.push(`  Exit code: ${agent.exitCode}`);
    if (agent.runtime) lines.push(`  Runtime: ${agent.runtime}`);
  }

  lines.push("");

  if (agent.lastPosts.length > 0) {
    lines.push(`  Recent posts:`);
    for (const p of [...agent.lastPosts].reverse()) {
      const time = formatClockTime(p.created_at);
      lines.push(`  ${time}  ${truncate(p.content, 60)}`);
    }
  }

  lines.push("");
  lines.push(`  ${c.bold}[m]${c.reset} merge  ${c.bold}[b]${c.reset} back  ${c.bold}[d]${c.reset} diff (advanced)`);

  return lines.join("\n");
}
