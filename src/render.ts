import type { Agent, Post } from "./types.js";
import type { PostThread } from "./posts.js";

const TYPE_ICONS: Record<string, string> = {
  update: "~",
  route: ">",
  decision: "!",
  escalation: "!!",
  directive: ">>",
  abandoned: "x",
  status: "-",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
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
  const icon = TYPE_ICONS[post.type] ?? "~";
  const time = formatTime(post.created_at);
  const typeTag = post.type !== "update" ? ` [${post.type}]` : "";

  return `${pad}[${icon}] ${post.author}${typeTag}  ${time}\n${pad}    ${post.content}`;
}

export function renderThread(thread: PostThread, indent = 0): string {
  const lines: string[] = [renderPost(thread.post, indent)];
  for (const reply of thread.replies) {
    lines.push(renderThread(reply, indent + 1));
  }
  return lines.join("\n\n");
}

export function renderFeed(posts: Post[]): string {
  if (posts.length === 0) return "  No posts yet.";
  return posts.map((p) => renderPost(p)).join("\n\n");
}

export function renderAgent(agent: Agent): string {
  const lines = [
    `${agent.handle}  (${agent.role})  [${agent.status}]`,
    `  Name:    ${agent.name}`,
    `  Mission: ${agent.mission}`,
  ];

  if (agent.team) {
    lines.push(`  Team:    ${agent.team}`);
  }

  const style = agent.style;
  if (style && Object.keys(style).length > 0) {
    lines.push(`  Style:`);
    if (style.approach) lines.push(`    approach:     ${style.approach}`);
    if (style.risk_tolerance) lines.push(`    risk:         ${style.risk_tolerance}`);
    if (style.reporting_style) lines.push(`    reporting:    ${style.reporting_style}`);
    if (style.escalation_threshold) lines.push(`    escalation:   ${style.escalation_threshold}`);
    if (style.constraints?.length) {
      lines.push(`    constraints:`);
      for (const c of style.constraints) {
        lines.push(`      - ${c}`);
      }
    }
  }

  lines.push(`  Created: ${agent.created_at}`);

  return lines.join("\n");
}

export function renderAgentList(agents: Agent[]): string {
  if (agents.length === 0) return "  No agents.";

  return agents
    .map((a) => `  ${a.handle}  ${a.name}  (${a.role})  [${a.status}]  ${a.mission}`)
    .join("\n");
}

export function renderProfile(agent: Agent, posts: Post[]): string {
  const lines = [
    "--- Profile ---",
    renderAgent(agent),
    "",
    "--- Posts ---",
    renderFeed(posts),
  ];
  return lines.join("\n");
}
