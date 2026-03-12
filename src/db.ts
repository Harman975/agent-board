import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  handle TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('manager', 'worker')),
  team TEXT,
  mission TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'idle', 'blocked', 'stopped')),
  style TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL REFERENCES agents(handle),
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'update' CHECK(type IN ('update', 'route', 'decision', 'escalation', 'directive', 'abandoned', 'status')),
  parent_id TEXT REFERENCES posts(id),
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commits (
  hash TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  files TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author);
CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type);
CREATE INDEX IF NOT EXISTS idx_commits_post ON commits(post_id);
`;

const DB_FILE = "board.db";

export function getDb(dir?: string): Database.Database {
  const dbPath = path.join(dir ?? process.cwd(), DB_FILE);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function initDb(dir?: string): Database.Database {
  const db = getDb(dir);
  db.exec(SCHEMA);
  return db;
}

export function dbExists(dir?: string): boolean {
  const dbPath = path.join(dir ?? process.cwd(), DB_FILE);
  return fs.existsSync(dbPath);
}
