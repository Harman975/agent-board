import fs from "fs";
import path from "path";
import { spawn as nodeSpawn } from "child_process";

// === Shared .boardrc helpers ===
// Used by cli.ts, interactive.ts, mcp.ts, and sprint-orchestrator.ts

export interface BoardRC {
  url: string;
  key: string;
  serverPid?: number;
}

const BOARDRC_FILE = ".boardrc";

export function readBoardRC(dir?: string): BoardRC | null {
  const rcPath = path.join(dir ?? process.cwd(), BOARDRC_FILE);
  if (!fs.existsSync(rcPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(rcPath, "utf-8"));
  } catch {
    return null;
  }
}

export function writeBoardRC(rc: BoardRC, dir?: string): void {
  const rcPath = path.join(dir ?? process.cwd(), BOARDRC_FILE);
  fs.writeFileSync(rcPath, JSON.stringify(rc, null, 2) + "\n");
}

// === Server lifecycle ===

async function isServerRunning(rc: BoardRC): Promise<boolean> {
  try {
    const res = await fetch(`${rc.url}/api/agents`, {
      headers: { Authorization: `Bearer ${rc.key}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function startServerBackground(rc: BoardRC, projectDir: string): number {
  const logPath = path.join(projectDir, ".board-server.log");
  const logFd = fs.openSync(logPath, "a");
  const cliPath = path.join(import.meta.dirname, "cli.js");

  const child = nodeSpawn(process.execPath, [cliPath, "serve"], {
    cwd: projectDir,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);

  rc.serverPid = child.pid!;
  writeBoardRC(rc, projectDir);
  return child.pid!;
}

/**
 * Ensure the board is initialized and server is running.
 * Shared by interactive.ts, mcp.ts, and cli.ts.
 */
export async function ensureServerRunning(projectDir?: string): Promise<BoardRC> {
  const dir = projectDir ?? process.cwd();
  const { dbExists, initBoard } = await import("./db.js");

  let rc = readBoardRC(dir);
  if (!dbExists(dir) || !rc) {
    const { adminKey } = initBoard(dir);
    rc = { url: "http://localhost:3141", key: adminKey };
    writeBoardRC(rc, dir);
  }

  if (await isServerRunning(rc)) return rc;

  startServerBackground(rc, dir);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isServerRunning(rc)) return rc;
  }

  throw new Error("Server failed to start. Check .board-server.log");
}

// === Custom presets loader ===

export interface MetricPreset {
  description: string;
  eval: string;
  metric: string;
  direction: "higher" | "lower";
  guard: string;
}

/**
 * Reads YAML files from a presets/ directory relative to `dir`.
 * Each file should have: name, description, eval, metric, direction, guard.
 * Returns Record<string, MetricPreset>. Gracefully handles missing dir, malformed YAML, missing fields.
 */
export function loadCustomPresets(dir?: string): Record<string, MetricPreset> {
  const presetsDir = path.join(dir ?? process.cwd(), "presets");
  const result: Record<string, MetricPreset> = {};

  if (!fs.existsSync(presetsDir)) return result;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(presetsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !(entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) continue;

    try {
      const content = fs.readFileSync(path.join(presetsDir, entry.name), "utf-8");
      const parsed = parseSimpleYaml(content);

      const name = parsed.name;
      if (!name || !parsed.description || !parsed.eval || !parsed.metric || !parsed.direction || !parsed.guard) {
        continue; // skip files with missing required fields
      }
      if (parsed.direction !== "higher" && parsed.direction !== "lower") {
        continue; // invalid direction
      }

      result[name] = {
        description: parsed.description,
        eval: parsed.eval,
        metric: parsed.metric,
        direction: parsed.direction as "higher" | "lower",
        guard: parsed.guard,
      };
    } catch {
      // skip malformed files
    }
  }

  return result;
}

/** Simple YAML parser for flat key: value files (no nesting, no arrays). */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// === HTTP client for Board API ===

export class ApiError extends Error {
  status: number;
  serverError: string;
  constructor(status: number, serverError: string) {
    super(`API error (${status}): ${serverError}`);
    this.name = "ApiError";
    this.status = status;
    this.serverError = serverError;
  }
}

export async function api<T>(
  rc: BoardRC,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const url = `${rc.url}${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${rc.key}`,
    "Content-Type": "application/json",
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("fetch failed")) {
      throw new ApiError(0, `Cannot connect to server at ${rc.url}. Is \`board serve\` running?`);
    }
    throw err;
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, `Server returned non-JSON response (${res.status} ${res.statusText})`);
  }

  if (!res.ok) {
    const errorMsg = (data as any)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, errorMsg);
  }

  return data as T;
}
