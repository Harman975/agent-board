import type Database from "better-sqlite3";

const DEFAULT_LIMIT = 100;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface RateLimitConfig {
  postsPerHour: number;
  commitsPerHour: number;
}

const defaultConfig: RateLimitConfig = {
  postsPerHour: DEFAULT_LIMIT,
  commitsPerHour: DEFAULT_LIMIT,
};

// In-memory sliding window counters (reset on server restart — acceptable for local tool)
const windows = new Map<string, { count: number; windowStart: number }>();

export function checkRateLimit(
  agentHandle: string,
  limitType: "posts" | "commits",
  config: RateLimitConfig = defaultConfig
): { allowed: boolean; retryAfterMs: number } {
  const key = `${agentHandle}:${limitType}`;
  const now = Date.now();
  const limit = limitType === "posts" ? config.postsPerHour : config.commitsPerHour;

  let entry = windows.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    windows.set(key, entry);
  }

  if (entry.count >= limit) {
    const retryAfterMs = WINDOW_MS - (now - entry.windowStart);
    return { allowed: false, retryAfterMs };
  }

  entry.count++;
  return { allowed: true, retryAfterMs: 0 };
}

export function resetRateLimits(): void {
  windows.clear();
}
