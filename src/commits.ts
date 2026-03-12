import type Database from "better-sqlite3";
import type { Commit, CommitRow } from "./types.js";

function rowToCommit(row: CommitRow): Commit {
  return {
    ...row,
    files: JSON.parse(row.files) as string[],
  };
}

export function linkCommit(
  db: Database.Database,
  opts: { hash: string; post_id: string; files?: string[] }
): Commit {
  // Verify post exists
  const post = db.prepare("SELECT id FROM posts WHERE id = ?").get(opts.post_id);
  if (!post) {
    throw new Error(`Post ${opts.post_id} not found`);
  }

  db.prepare(`
    INSERT INTO commits (hash, post_id, files)
    VALUES (?, ?, ?)
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
