import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// === Foundation schema — AgentHub-compatible, zero supervision concepts ===

const FOUNDATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  handle TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mission TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'idle', 'blocked', 'stopped')),
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL REFERENCES agents(handle),
  channel TEXT NOT NULL REFERENCES channels(name),
  content TEXT NOT NULL,
  parent_id TEXT REFERENCES posts(id),
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS commits (
  hash TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  files TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,
  agent_handle TEXT REFERENCES agents(handle),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author);
CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel);
CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commits_post ON commits(post_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_handle ON api_keys(agent_handle);
`;

// === Supervision schema — AgentBoard layer, reads foundation, own tables ===

const SUPERVISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_priority (
  channel_name TEXT PRIMARY KEY REFERENCES channels(name),
  priority INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cursors (
  name TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spawns (
  agent_handle TEXT PRIMARY KEY REFERENCES agents(handle),
  pid INTEGER NOT NULL,
  log_path TEXT,
  worktree_path TEXT,
  branch TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS dag_commits (
  hash TEXT PRIMARY KEY,
  parent_hash TEXT,
  agent_handle TEXT NOT NULL REFERENCES agents(handle),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_dag_parent ON dag_commits(parent_hash);
CREATE INDEX IF NOT EXISTS idx_dag_agent ON dag_commits(agent_handle);
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
  db.exec(FOUNDATION_SCHEMA);
  db.exec(SUPERVISION_SCHEMA);
  return db;
}

export function dbExists(dir?: string): boolean {
  const dbPath = path.join(dir ?? process.cwd(), DB_FILE);
  return fs.existsSync(dbPath);
}
