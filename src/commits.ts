import type Database from "better-sqlite3";
import type { Commit, CommitRow } from "./types.js";

function rowToCommit(row: CommitRow): Commit {
  try {
    return { ...row, files: JSON.parse(row.files) as string[] };
  } catch {
    return { ...row, files: [] };
  }
}

export function linkCommit(
  db: Database.Database,
  opts: { hash: string; post_id: string; files?: string[] }
): Commit {
  const post = db.prepare("SELECT id FROM posts WHERE id = ?").get(opts.post_id);
  if (!post) {
    throw new Error(`Post ${opts.post_id} not found`);
  }

  const existing = db.prepare("SELECT hash FROM commits WHERE hash = ?").get(opts.hash);
  if (existing) {
    throw new Error(`Commit ${opts.hash} already linked`);
  }

  db.prepare(`
    INSERT INTO commits (hash, post_id, files) VALUES (?, ?, ?)
  `).run(opts.hash, opts.post_id, JSON.stringify(opts.files ?? []));

  return getCommit(db, opts.hash)!;
}

export function getCommit(db: Database.Database, hash: string): Commit | null {
  const row = db.prepare("SELECT * FROM commits WHERE hash = ?").get(hash) as CommitRow | undefined;
  return row ? rowToCommit(row) : null;
}

export function listCommitsByPost(db: Database.Database, postId: string): Commit[] {
  const rows = db
    .prepare("SELECT * FROM commits WHERE post_id = ? ORDER BY created_at ASC")
    .all(postId) as CommitRow[];
  return rows.map(rowToCommit);
}
