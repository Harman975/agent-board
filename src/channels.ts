import type Database from "better-sqlite3";
import type { Channel } from "./types.js";

export function normalizeChannel(name: string): string {
  return name.startsWith("#") ? name : `#${name}`;
}

export function createChannel(
  db: Database.Database,
  opts: { name: string; description?: string }
): Channel {
  const name = normalizeChannel(opts.name);

  const existing = db.prepare("SELECT name FROM channels WHERE name = ?").get(name);
  if (existing) {
    throw new Error(`Channel ${name} already exists`);
  }

  db.prepare(`
    INSERT INTO channels (name, description) VALUES (?, ?)
  `).run(name, opts.description ?? null);

  return getChannel(db, name)!;
}

export function getChannel(db: Database.Database, name: string): Channel | null {
  name = normalizeChannel(name);
  const row = db.prepare("SELECT * FROM channels WHERE name = ?").get(name) as Channel | undefined;
  return row ?? null;
}

export function listChannels(db: Database.Database): Channel[] {
  return db.prepare("SELECT * FROM channels ORDER BY created_at ASC").all() as Channel[];
}
