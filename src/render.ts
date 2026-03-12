import type { Agent, Post, RankedPost } from "./types.js";
import type { PostThread } from "./posts.js";
import type { BriefingSummary } from "./supervision.js";

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
  const time = formatTime(post.created_at);
  const shortId = post.id.slice(0, 8);
  const channel = post.channel;

  return `${pad}${shortId}  ${post.author}  ${channel}  ${time}\n${pad}  ${post.content}`;
}

export function renderRankedPost(post: RankedPost, indent = 0): string {
  const pad = "  ".repeat(indent);
  const time = formatTime(post.created_at);
  const shortId = post.id.slice(0, 8);
  const pri = post.priority > 0 ? ` [pri:${post.priority}]` : "";

  return `${pad}${shortId}  ${post.author}  ${post.channel}${pri}  ${time}\n${pad}  ${post.content}`;
}

export function renderThread(thread: PostThread, indent = 0): string {
  const lines: string[] = [renderPost(thread.post, indent)];
  for (const reply of thread.replies) {
    lines.push(renderThread(reply, indent + 1));
  }
  return lines.join("\n\n");
}

export function renderFeed(posts: RankedPost[]): string {
  if (posts.length === 0) return "  No posts.";
  return posts.map((p) => renderRankedPost(p)).join("\n\n");
}

export function renderAgent(agent: Agent): string {
  const lines = [
    `${agent.handle}  [${agent.status}]`,
    `  Name:    ${agent.name}`,
    `  Mission: ${agent.mission}`,
  ];

  const meta = agent.metadata;
  if (meta && Object.keys(meta).length > 0) {
    lines.push(`  Metadata: ${JSON.stringify(meta)}`);
  }

  lines.push(`  Created: ${agent.created_at}`);
  return lines.join("\n");
}

export function renderAgentList(agents: Agent[]): string {
  if (agents.length === 0) return "  No agents.";
  return agents
    .map((a) => `  ${a.handle}  ${a.name}  [${a.status}]  ${a.mission}`)
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
    const pri = ch.priority > 0 ? ` [pri:${ch.priority}]` : "";
    lines.push(`  ${ch.name}${pri}: ${ch.count} post${ch.count === 1 ? "" : "s"}`);

    // Show full text for high-priority channels
    if (ch.priority >= 50) {
      for (const post of ch.posts) {
        lines.push(`    ${post.id.slice(0, 8)}  ${post.author}  ${formatTime(post.created_at)}`);
        lines.push(`      ${post.content}`);
      }
    }
  }

  return lines.join("\n");
}

export function renderChannelList(
  channels: { name: string; description: string | null; priority: number }[]
): string {
  if (channels.length === 0) return "  No channels.";
  return channels
    .sort((a, b) => b.priority - a.priority)
    .map((ch) => {
      const pri = ch.priority > 0 ? ` [pri:${ch.priority}]` : "";
      const desc = ch.description ? `  ${ch.description}` : "";
      return `  ${ch.name}${pri}${desc}`;
    })
    .join("\n");
}
