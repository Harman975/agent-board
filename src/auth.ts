import crypto from "crypto";
import type Database from "better-sqlite3";
import type { ApiKey } from "./types.js";

export function hashKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function generateKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function storeKey(
  db: Database.Database,
  rawKey: string,
  agentHandle: string | null
): void {
  db.prepare(`
    INSERT INTO api_keys (key_hash, agent_handle) VALUES (?, ?)
  `).run(hashKey(rawKey), agentHandle);
}

export function validateKey(
  db: Database.Database,
  rawKey: string
): ApiKey | null {
  const hash = hashKey(rawKey);
  const row = db
    .prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .get(hash) as ApiKey | undefined;
  return row ?? null;
}

export function isAdminKey(apiKey: ApiKey): boolean {
  return apiKey.agent_handle === null;
}

export function revokeKey(db: Database.Database, rawKey: string): void {
  db.prepare(`
    UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE key_hash = ? AND revoked_at IS NULL
  `).run(hashKey(rawKey));
}
