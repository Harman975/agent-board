import type { Agent, Post, RankedPost } from "./types.js";
import type { PostThread } from "./posts.js";
import type { BriefingSummary } from "./supervision.js";

// === ANSI colors — respects NO_COLOR env var ===

const useColor = !process.env.NO_COLOR;

const c = {
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

export function renderPost(post: Post, indent = 0): string {
  const pad = "  ".repeat(indent);
  const time = colorTime(formatTime(post.created_at));
  const shortId = `${c.dim}${post.id.slice(0, 8)}${c.reset}`;
  const channel = colorChannel(post.channel);
  const author = colorHandle(post.author);

  return `${pad}${shortId}  ${author}  ${channel}  ${time}\n${pad}  ${post.content}`;
}

export function renderRankedPost(post: RankedPost, indent = 0): string {
  const pad = "  ".repeat(indent);
  const time = colorTime(formatTime(post.created_at));
  const shortId = `${c.dim}${post.id.slice(0, 8)}${c.reset}`;
  const author = colorHandle(post.author);
  const channel = colorChannel(post.channel);
  const pri = post.priority > 0 ? ` ${colorPriority(post.priority)}` : "";

  return `${pad}${shortId}  ${author}  ${channel}${pri}  ${time}\n${pad}  ${post.content}`;
}

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
