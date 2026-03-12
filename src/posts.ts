import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import type { Post, PostRow, PostType } from "./types.js";

function rowToPost(row: PostRow): Post {
  return {
    ...row,
    type: row.type as PostType,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

export function createPost(
  db: Database.Database,
  opts: {
    author: string;
    content: string;
    type?: PostType;
    parent_id?: string;
    metadata?: Record<string, unknown>;
  }
): Post {
  const author = opts.author.startsWith("@") ? opts.author : `@${opts.author}`;
  const id = uuid();

  // Verify author exists
  const agent = db.prepare("SELECT handle FROM agents WHERE handle = ?").get(author);
  if (!agent) {
    throw new Error(`Agent ${author} not found`);
  }

  // Verify parent exists if specified
  if (opts.parent_id) {
    const parent = db.prepare("SELECT id FROM posts WHERE id = ?").get(opts.parent_id);
    if (!parent) {
      throw new Error(`Parent post ${opts.parent_id} not found`);
    }
  }

  db.prepare(`
    INSERT INTO posts (id, author, content, type, parent_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    author,
    opts.content,
    opts.type ?? "update",
    opts.parent_id ?? null,
    JSON.stringify(opts.metadata ?? {})
  );

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
    type?: PostType;
    since?: string;
    limit?: number;
    parent_id?: string | null;
  }
): Post[] {
  let sql = "SELECT * FROM posts WHERE 1=1";
  const params: unknown[] = [];

  if (opts?.author) {
    const author = opts.author.startsWith("@") ? opts.author : `@${opts.author}`;
    sql += " AND author = ?";
    params.push(author);
  }
  if (opts?.type) {
    sql += " AND type = ?";
    params.push(opts.type);
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

  // Find the root post
  let root = post;
  while (root.parent_id) {
    const parent = getPost(db, root.parent_id);
    if (!parent) break;
    root = parent;
  }

  return buildThread(db, root);
}

function buildThread(db: Database.Database, post: Post): PostThread {
  const replies = db
    .prepare("SELECT * FROM posts WHERE parent_id = ? ORDER BY created_at ASC")
    .all(post.id) as PostRow[];

  return {
    post,
    replies: replies.map((r) => buildThread(db, rowToPost(r))),
  };
}
