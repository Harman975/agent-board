import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { Post, PostRow } from "./types.js";
import { safeJsonParse, normalizeHandle } from "./agents.js";
import { normalizeChannel } from "./channels.js";

function rowToPost(row: PostRow): Post {
  return {
    ...row,
    metadata: safeJsonParse(row.metadata),
  };
}

export function createPost(
  db: Database.Database,
  opts: {
    author: string;
    channel: string;
    content: string;
    parent_id?: string;
    metadata?: Record<string, unknown>;
  }
): Post {
  const author = normalizeHandle(opts.author);
  const channel = normalizeChannel(opts.channel);
  const id = randomUUID();

  const agent = db.prepare("SELECT handle FROM agents WHERE handle = ?").get(author);
  if (!agent) {
    throw new Error(`Agent ${author} not found`);
  }

  const ch = db.prepare("SELECT name FROM channels WHERE name = ?").get(channel);
  if (!ch) {
    throw new Error(`Channel ${channel} not found`);
  }

  if (opts.parent_id) {
    const parent = db.prepare("SELECT id FROM posts WHERE id = ?").get(opts.parent_id);
    if (!parent) {
      throw new Error(`Parent post ${opts.parent_id} not found`);
    }
  }

  db.prepare(`
    INSERT INTO posts (id, author, channel, content, parent_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, author, channel, opts.content, opts.parent_id ?? null, JSON.stringify(opts.metadata ?? {}));

  return getPost(db, id)!;
}

export function getPost(db: Database.Database, id: string): Post | null {
  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRow | undefined;
  return row ? rowToPost(row) : null;
}

export function listPosts(
  db: Database.Database,
  opts?: {
    author?: string;
    channel?: string;
    since?: string;
    limit?: number;
    parent_id?: string | null;
  }
): Post[] {
  let sql = "SELECT * FROM posts WHERE 1=1";
  const params: unknown[] = [];

  if (opts?.author) {
    sql += " AND author = ?";
    params.push(normalizeHandle(opts.author));
  }
  if (opts?.channel) {
    sql += " AND channel = ?";
    params.push(normalizeChannel(opts.channel));
  }
  if (opts?.since) {
    sql += " AND created_at >= ?";
    params.push(opts.since);
  }
  if (opts?.parent_id !== undefined) {
    if (opts.parent_id === null) {
      sql += " AND parent_id IS NULL";
    } else {
      sql += " AND parent_id = ?";
      params.push(opts.parent_id);
    }
  }

  sql += " ORDER BY created_at DESC";

  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  const rows = db.prepare(sql).all(...params) as PostRow[];
  return rows.map(rowToPost);
}

export interface PostThread {
  post: Post;
  replies: PostThread[];
}

export function getThread(db: Database.Database, postId: string): PostThread | null {
  const post = getPost(db, postId);
  if (!post) return null;

  // Find the root post (with cycle protection)
  let root = post;
  const visited = new Set<string>([root.id]);
  while (root.parent_id) {
    if (visited.has(root.parent_id)) break;
    visited.add(root.parent_id);
    const parent = getPost(db, root.parent_id);
    if (!parent) break;
    root = parent;
  }

  return buildThread(db, root, new Set());
}

function buildThread(db: Database.Database, post: Post, visited: Set<string>): PostThread {
  visited.add(post.id);
  const replies = db
    .prepare("SELECT * FROM posts WHERE parent_id = ? ORDER BY created_at ASC")
    .all(post.id) as PostRow[];

  return {
    post,
    replies: replies
      .map((r) => rowToPost(r))
      .filter((r) => !visited.has(r.id))
      .map((r) => buildThread(db, r, visited)),
  };
}
