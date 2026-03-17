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
