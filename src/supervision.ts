import type Database from "better-sqlite3";
import type { ChannelPriority, Post, PostRow, RankedPost } from "./types.js";
import { safeJsonParse, normalizeHandle } from "./agents.js";
import { normalizeChannel } from "./channels.js";

// === Channel Priority (supervision table) ===

export function setChannelPriority(
  db: Database.Database,
  channelName: string,
  priority: number
): void {
  channelName = normalizeChannel(channelName);

  // Verify channel exists in foundation
  const ch = db.prepare("SELECT name FROM channels WHERE name = ?").get(channelName);
  if (!ch) {
    throw new Error(`Channel ${channelName} not found`);
  }

  db.prepare(`
    INSERT INTO channel_priority (channel_name, priority) VALUES (?, ?)
    ON CONFLICT(channel_name) DO UPDATE SET priority = excluded.priority
  `).run(channelName, priority);
}

export function getChannelPriority(db: Database.Database, channelName: string): number {
  channelName = normalizeChannel(channelName);
  const row = db
    .prepare("SELECT priority FROM channel_priority WHERE channel_name = ?")
    .get(channelName) as { priority: number } | undefined;
  return row?.priority ?? 0;
}

export function listChannelPriorities(db: Database.Database): ChannelPriority[] {
  return db
    .prepare("SELECT * FROM channel_priority ORDER BY priority DESC")
    .all() as ChannelPriority[];
}

// === Feed (reads foundation posts, joins with supervision priority) ===

export function getFeed(
  db: Database.Database,
  opts?: { channel?: string; since?: string; author?: string; limit?: number }
): RankedPost[] {
  let sql = `
    SELECT p.*, COALESCE(cp.priority, 0) as priority
    FROM posts p
    LEFT JOIN channel_priority cp ON p.channel = cp.channel_name
    WHERE p.parent_id IS NULL
  `;
  const params: unknown[] = [];

  if (opts?.channel) {
    const channel = normalizeChannel(opts.channel);
    sql += " AND p.channel = ?";
    params.push(channel);
  }
  if (opts?.author) {
    sql += " AND p.author = ?";
    params.push(normalizeHandle(opts.author));
  }
  if (opts?.since) {
    sql += " AND p.created_at >= ?";
    params.push(opts.since);
  }

  sql += " ORDER BY priority DESC, p.created_at DESC";

  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  const rows = db.prepare(sql).all(...params) as (PostRow & { priority: number })[];
  return rows.map((r) => ({
    id: r.id,
    author: r.author,
    channel: r.channel,
    content: r.content,
    parent_id: r.parent_id,
    metadata: safeJsonParse(r.metadata),
    created_at: r.created_at,
    priority: r.priority,
  }));
}

// === Briefing (cursor-based catch-up) ===

function getCursor(db: Database.Database, name: string): string | null {
  const row = db
    .prepare("SELECT timestamp FROM cursors WHERE name = ?")
    .get(name) as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

function setCursor(db: Database.Database, name: string, timestamp: string): void {
  db.prepare(`
    INSERT INTO cursors (name, timestamp) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET timestamp = excluded.timestamp
  `).run(name, timestamp);
}

export interface BriefingSummary {
  since: string | null;
  channels: {
    name: string;
    priority: number;
    count: number;
    posts: Post[];
  }[];
  total: number;
}

export function getBriefing(db: Database.Database): BriefingSummary {
  const cursorTime = getCursor(db, "last_briefing");

  let sql = `
    SELECT p.*, COALESCE(cp.priority, 0) as priority
    FROM posts p
    LEFT JOIN channel_priority cp ON p.channel = cp.channel_name
    WHERE p.parent_id IS NULL
  `;
  const params: unknown[] = [];

  if (cursorTime) {
    sql += " AND p.created_at > ?";
    params.push(cursorTime);
  }

  sql += " ORDER BY priority DESC, p.created_at DESC";

  const rows = db.prepare(sql).all(...params) as (PostRow & { priority: number })[];

  // Group by channel
  const channelMap = new Map<string, { priority: number; posts: Post[] }>();
  for (const row of rows) {
    const existing = channelMap.get(row.channel) ?? { priority: row.priority, posts: [] };
    existing.posts.push({
      id: row.id,
      author: row.author,
      channel: row.channel,
      content: row.content,
      parent_id: row.parent_id,
      metadata: safeJsonParse(row.metadata),
      created_at: row.created_at,
    });
    channelMap.set(row.channel, existing);
  }

  // Sort channels by priority
  const channels = Array.from(channelMap.entries())
    .map(([name, data]) => ({
      name,
      priority: data.priority,
      count: data.posts.length,
      posts: data.posts,
    }))
    .sort((a, b) => b.priority - a.priority);

  // Advance cursor to now
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  setCursor(db, "last_briefing", now);

  return {
    since: cursorTime,
    channels,
    total: rows.length,
  };
}

// === Duration parsing ===

export function parseDuration(duration: string): string | null {
  const match = duration.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const now = new Date();
  switch (unit) {
    case "m":
      now.setMinutes(now.getMinutes() - value);
      break;
    case "h":
      now.setHours(now.getHours() - value);
      break;
    case "d":
      now.setDate(now.getDate() - value);
      break;
  }

  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}
