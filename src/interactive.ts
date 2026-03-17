import readline from "readline";
import fs from "fs";
import path from "path";
import { getDb } from "./db.js";
import { normalizeHandle } from "./agents.js";
import { readBoardRC, ensureServerRunning, api, type BoardRC } from "./boardrc.js";
import {
  c,
  renderFeed,
  renderSpawnList,
  renderBriefing,
  renderLandingBrief,
  renderAgentInspect,
  renderSprintReport,
  type SpawnInfo,
} from "./render.js";
import type { RankedPost, Sprint, SprintAgent } from "./types.js";
import type { BriefingSummary } from "./supervision.js";
import type Database from "better-sqlite3";
import {
  buildLandingBrief,
  buildSprintReport,
  mergeWithTestGates,
  startSprint,
  uniqueSprintName,
  type AgentSpec,
} from "./sprint-orchestrator.js";

// ============================================================
//  CEO Console — command-style REPL with background monitoring
//
//  Input flow:
//    parseCommand(input) → route to action → print result
//
//  Background poller (10s):
//    Query running sprints → check agent liveness
//    → notify on agent stop → notify on sprint completion
// ============================================================

// === Command parser ===

export interface ParsedCommand {
  cmd: string;
  args: string;
}

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { cmd: trimmed.toLowerCase(), args: "" };
  return {
    cmd: trimmed.slice(0, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

// === Readline helpers ===

function createRL(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function notify(rl: readline.Interface, msg: string): void {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(`  ${c.yellow}▸${c.reset} ${msg}`);
  rl.prompt(true);
}

async function ensureReady(): Promise<BoardRC> {
  return ensureServerRunning();
}

// === Background sprint poller ===

interface PollerState {
  // Track which agents were alive last poll to detect transitions
  knownAlive: Set<string>;
}

function startPoller(
  db: Database.Database,
  rl: readline.Interface,
): { stop: () => void } {
  const state: PollerState = { knownAlive: new Set() };

  const poll = async () => {
    try {
      const { listSpawns, isProcessAlive } = await import("./spawner.js");

      const running = db.prepare(
        "SELECT * FROM sprints WHERE status = 'running'"
      ).all() as Sprint[];

      for (const sprint of running) {
        const agents = db.prepare(
          "SELECT * FROM sprint_agents WHERE sprint_name = ?"
        ).all(sprint.name) as SprintAgent[];

        const spawns = listSpawns(db);
        let allDone = true;
        let anyNewlyDone = false;

        for (const sa of agents) {
          const spawn = spawns.find((s) => s.agent_handle === sa.agent_handle);
          if (!spawn) continue;

          const alive = !spawn.stopped_at && isProcessAlive(spawn.pid);
          const key = `${sprint.name}:${sa.agent_handle}`;

          if (alive) {
            allDone = false;
            state.knownAlive.add(key);
          } else if (state.knownAlive.has(key)) {
            // Was alive, now dead — notify
            state.knownAlive.delete(key);
            anyNewlyDone = true;
            const exitMsg = spawn.exit_code === 0 ? "finished" : `crashed (exit ${spawn.exit_code ?? "?"})`;
            notify(rl, `${sa.agent_handle} ${exitMsg}`);
          }
        }

        if (allDone && anyNewlyDone) {
          notify(rl, `${c.green}Sprint "${sprint.name}" READY TO LAND${c.reset} — type: land`);
        }
      }
    } catch {
      // DB locked or other transient error — skip this cycle
    }
  };

  // Initial scan to populate knownAlive
  poll();

  const interval = setInterval(poll, 10_000);
  return { stop: () => clearInterval(interval) };
}

// === Actions ===

async function actionSprint(
  goal: string,
  rc: BoardRC,
  rl: readline.Interface,
  db: Database.Database,
): Promise<void> {
  const projectDir = process.cwd();

  console.log(`\n  ${c.dim}Analyzing codebase...${c.reset}`);

  const { decompose } = await import("./decomposer.js");
  let result;
  try {
    result = await decompose(goal, projectDir);
  } catch (err: any) {
    console.log(`  ${c.red}Decomposition failed: ${err.message}${c.reset}\n`);
    return;
  }

  console.log(`  ${result.tasks.length} tasks:\n`);
  for (let i = 0; i < result.tasks.length; i++) {
    const t = result.tasks[i];
    console.log(`  ${c.bold}${i + 1}.${c.reset} ${t.handle} ${c.dim}(${t.agent})${c.reset}`);
    console.log(`     ${t.mission.slice(0, 100)}${t.mission.length > 100 ? "..." : ""}`);
  }

  const answer = await ask(rl, `\n  Proceed? [Y/n] `);
  if (answer.toLowerCase() === "n") {
    console.log(`  ${c.dim}Cancelled.${c.reset}\n`);
    return;
  }

  const name = uniqueSprintName(goal, db);
  const specs: AgentSpec[] = result.tasks.map((t) => ({
    handle: t.handle,
    identity: t.agent,
    mission: t.mission,
    scope: t.scope,
  }));

  console.log(`\n  ${c.dim}Starting sprint "${name}"...${c.reset}`);

  try {
    const sprintResult = await startSprint({
      name,
      goal,
      specs,
      projectDir,
      serverUrl: rc.url,
      db,
      onSpawn: (handle, pid, branch) => {
        console.log(`  Spawned ${c.green}${handle}${c.reset} ${c.dim}PID ${pid}, ${branch}${c.reset}`);
      },
    });

    console.log(`\n  ${c.green}Sprint "${name}" launched${c.reset} — ${sprintResult.spawned.length} agents`);
    console.log(`  ${c.dim}Type "status" to check progress, "land" when ready${c.reset}\n`);
  } catch (err: any) {
    console.log(`  ${c.red}${err.message}${c.reset}\n`);
  }
}

async function actionLand(
  nameArg: string,
  rc: BoardRC,
  rl: readline.Interface,
  db: Database.Database,
): Promise<void> {
  const projectDir = process.cwd();

  // Resolve sprint name
  let sprintName = nameArg;
  if (!sprintName) {
    const running = db.prepare(
      "SELECT name FROM sprints WHERE status = 'running' ORDER BY created_at DESC"
    ).all() as { name: string }[];

    if (running.length === 0) {
      console.log(`  ${c.dim}No active sprints.${c.reset}\n`);
      return;
    }
    if (running.length === 1) {
      sprintName = running[0].name;
    } else {
      console.log(`\n  Active sprints:`);
      running.forEach((s, i) => console.log(`  ${c.bold}${i + 1}${c.reset} ${s.name}`));
      const pick = await ask(rl, `  Pick: `);
      const idx = parseInt(pick, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= running.length) return;
      sprintName = running[idx].name;
    }
  }

  console.log(`\n  ${c.dim}Building landing brief...${c.reset}\n`);

  let brief;
  try {
    brief = await buildLandingBrief(sprintName, projectDir);
  } catch (err: any) {
    console.log(`  ${c.red}${err.message}${c.reset}\n`);
    return;
  }

  console.log(renderLandingBrief(brief));

  // Interactive landing loop
  const passing = brief.agents.filter((a) => a.status === "passed");

  const landLoop = async (): Promise<void> => {
    console.log("");
    let prompt = `  ${c.bold}[enter]${c.reset} land ${passing.length} passing`;
    if (brief.summary.running > 0) prompt += `  ${c.bold}[w]${c.reset} wait`;
    for (let i = 0; i < brief.agents.length; i++) {
      prompt += `  ${c.bold}[${i + 1}]${c.reset} ${brief.agents[i].handle}`;
    }
    prompt += `  ${c.bold}[q]${c.reset} back`;
    console.log(prompt);

    const choice = await ask(rl, `  > `);

    if (choice === "q") return;

    if (choice === "w" && brief.summary.running > 0) {
      console.log(`  ${c.dim}Waiting 10 seconds...${c.reset}`);
      await new Promise((r) => setTimeout(r, 10_000));
      // Re-run land with fresh data
      await actionLand(sprintName, rc, rl, db);
      return;
    }

    const num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= brief.agents.length) {
      const agent = brief.agents[num - 1];
      console.log("\n" + renderAgentInspect(agent));
      const inspectChoice = await ask(rl, `  > `);
      if (inspectChoice === "m" && agent.status === "passed") {
        await doMerge([agent.handle], sprintName, rc, db, projectDir);
        return;
      }
      if (inspectChoice === "d" && agent.branch) {
        try {
          const { execSync } = await import("child_process");
          const diff = execSync(`git diff main..${agent.branch}`, { cwd: projectDir, encoding: "utf-8", stdio: "pipe" });
          console.log(diff);
        } catch (err: any) {
          console.log(`  ${c.red}Could not show diff: ${err.message}${c.reset}`);
        }
      }
      await landLoop();
      return;
    }

    if (choice === "") {
      if (passing.length === 0) {
        console.log(`  ${c.dim}No passing agents to merge.${c.reset}\n`);
        return;
      }
      await doMerge(passing.map((a) => a.handle), sprintName, rc, db, projectDir);
      return;
    }

    console.log(`  ${c.dim}Unknown option.${c.reset}`);
    await landLoop();
  };

  await landLoop();
}

async function doMerge(
  handles: string[],
  sprintName: string,
  rc: BoardRC,
  db: Database.Database,
  projectDir: string,
): Promise<void> {
  console.log(`\n  ${c.bold}Landing ${handles.length} agent${handles.length === 1 ? "" : "s"}...${c.reset}`);

  try {
    const result = await mergeWithTestGates(handles, projectDir, { db });

    db.prepare(
      "UPDATE sprints SET status = 'finished', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE name = ?"
    ).run(sprintName);

    console.log(`\n  ${c.green}Landed ${result.merged.length} agent${result.merged.length === 1 ? "" : "s"}.${c.reset}\n`);

    try {
      await api(rc, "POST", "/api/posts", {
        content: `Sprint "${sprintName}" landed. Merged: ${result.merged.join(", ")}.`,
        channel: "#status",
      });
    } catch { /* best effort */ }
  } catch (err: any) {
    console.error(`  ${c.red}Merge failed: ${err.message}${c.reset}\n`);
    db.prepare(
      "UPDATE sprints SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE name = ?"
    ).run(sprintName);
  }
}

async function actionStatus(nameArg: string, db: Database.Database): Promise<void> {
  // Default to latest running sprint
  let sprintName = nameArg;
  if (!sprintName) {
    const row = db.prepare(
      "SELECT name FROM sprints WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
    ).get() as { name: string } | undefined;
    if (!row) {
      console.log(`  ${c.dim}No active sprints.${c.reset}\n`);
      return;
    }
    sprintName = row.name;
  }

  try {
    const report = await buildSprintReport(sprintName, process.cwd());
    console.log("\n" + renderSprintReport(report) + "\n");
  } catch (err: any) {
    console.log(`  ${c.red}${err.message}${c.reset}\n`);
  }
}

async function actionFeed(rc: BoardRC): Promise<void> {
  try {
    const data = await api<RankedPost[]>(rc, "GET", "/api/feed?limit=20");
    console.log();
    console.log(data.length > 0 ? renderFeed(data) : `  ${c.dim}No posts yet.${c.reset}`);
    console.log();
  } catch (err: any) {
    console.log(`  ${c.red}${err.message}${c.reset}\n`);
  }
}

async function actionPS(db: Database.Database): Promise<void> {
  const { listSpawns, isProcessAlive } = await import("./spawner.js");
  const spawns = listSpawns(db);

  if (spawns.length === 0) {
    console.log(`  ${c.dim}No agents spawned.${c.reset}\n`);
    return;
  }

  const infos: SpawnInfo[] = spawns.map((s) => ({
    agent_handle: s.agent_handle,
    pid: s.pid,
    started_at: s.started_at,
    stopped_at: s.stopped_at,
    alive: s.stopped_at ? false : isProcessAlive(s.pid),
  }));

  console.log("\n" + renderSpawnList(infos) + "\n");
}

async function actionKill(handle: string, db: Database.Database): Promise<void> {
  if (!handle) {
    console.log(`  ${c.dim}Usage: kill @handle${c.reset}\n`);
    return;
  }

  const h = normalizeHandle(handle);
  const { killAgent } = await import("./spawner.js");

  try {
    killAgent(db, h, process.cwd());
    console.log(`  ${c.green}Killed ${h}${c.reset}\n`);
  } catch (err: any) {
    console.log(`  ${c.red}${err.message}${c.reset}\n`);
  }
}

async function actionSteer(args: string, db: Database.Database): Promise<void> {
  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) {
    console.log(`  ${c.dim}Usage: steer @handle message${c.reset}\n`);
    return;
  }

  const handle = normalizeHandle(args.slice(0, spaceIdx));
  const message = args.slice(spaceIdx + 1).trim();
  if (!message) {
    console.log(`  ${c.dim}Usage: steer @handle message${c.reset}\n`);
    return;
  }

  const { writeDirective } = await import("./spawner.js");
  try {
    writeDirective(process.cwd(), handle, message);
    console.log(`  ${c.green}Directive sent to ${handle}${c.reset}\n`);
  } catch (err: any) {
    console.log(`  ${c.red}${err.message}${c.reset}\n`);
  }
}

async function actionLogs(handle: string, db: Database.Database): Promise<void> {
  if (!handle) {
    console.log(`  ${c.dim}Usage: logs @handle${c.reset}\n`);
    return;
  }

  const h = normalizeHandle(handle);
  const { getSpawn } = await import("./spawner.js");
  const spawn = getSpawn(db, h);

  if (!spawn) {
    console.log(`  ${c.red}No spawn record for ${h}${c.reset}\n`);
    return;
  }
  if (!spawn.log_path || !fs.existsSync(spawn.log_path)) {
    console.log(`  ${c.red}Log file not found${c.reset}\n`);
    return;
  }

  const content = fs.readFileSync(spawn.log_path, "utf-8");
  const lines = content.split("\n").slice(-30).join("\n");
  console.log(`\n${lines}\n`);
}

async function actionBriefing(rc: BoardRC): Promise<void> {
  try {
    const data = await api<BriefingSummary>(rc, "GET", "/api/briefing");
    console.log("\n" + renderBriefing(data) + "\n");
  } catch (err: any) {
    console.log(`  ${c.red}${err.message}${c.reset}\n`);
  }
}

function showHelp(): void {
  console.log(`
  ${c.bold}Sprint commands${c.reset}
    sprint <goal>       Decompose goal and launch agents
    land [name]         Review agent work and merge
    status [name]       Show sprint progress

  ${c.bold}Agent commands${c.reset}
    ps                  List running agents
    kill @handle        Stop an agent
    steer @handle msg   Send directive to agent
    logs @handle        Tail agent logs

  ${c.bold}Feed commands${c.reset}
    feed                View activity feed
    briefing            What changed since last check

  ${c.bold}Other${c.reset}
    help                Show this help
    quit                Exit (agents keep running)
`);
}

// === Header ===

async function showHeader(rc: BoardRC, db: Database.Database): Promise<void> {
  const { listSpawns, isProcessAlive } = await import("./spawner.js");
  const active = listSpawns(db, true).filter((s) => isProcessAlive(s.pid));

  const runningSprints = db.prepare(
    "SELECT COUNT(*) as count FROM sprints WHERE status = 'running'"
  ).get() as { count: number };

  console.log(`  ${c.bold}AgentBoard${c.reset} ${c.dim}v0.2.0${c.reset}`);
  const parts: string[] = [];
  if (runningSprints.count > 0) parts.push(`${c.green}${runningSprints.count} sprint${runningSprints.count > 1 ? "s" : ""}${c.reset}`);
  if (active.length > 0) parts.push(`${c.green}${active.length} running${c.reset}`);
  else parts.push(`${c.dim}0 running${c.reset}`);
  console.log(`  ${parts.join("  ")}`);
  console.log(`  ${c.dim}Type "help" for commands${c.reset}\n`);
}

// === Main entry ===

export async function startInteractive() {
  process.stdout.write("\x1b[2J\x1b[H"); // clear
  const rc = await ensureReady();

  // Single long-lived DB connection for the entire session.
  // Spawned child processes register exit handlers that write to the DB.
  const db = getDb();
  const rl = createRL();

  // Start background sprint poller
  const poller = startPoller(db, rl);

  const cleanup = () => {
    poller.stop();
    db.close();
    rl.close();
  };

  process.on("SIGINT", () => {
    console.log(`\n  ${c.dim}Agents keep running. Type \`board\` to reconnect.${c.reset}\n`);
    cleanup();
    process.exit(0);
  });

  process.stdout.write("\x1b[2J\x1b[H"); // clear
  await showHeader(rc, db);

  // Set prompt for rl.prompt() used by notify()
  rl.setPrompt(`  ${c.bold}>${c.reset} `);

  const loop = async () => {
    const input = await ask(rl, `  ${c.bold}>${c.reset} `);

    if (!input) {
      loop();
      return;
    }

    const { cmd, args } = parseCommand(input);

    switch (cmd) {
      case "sprint":
        if (!args) {
          console.log(`  ${c.dim}Usage: sprint <goal>${c.reset}\n`);
        } else {
          await actionSprint(args, rc, rl, db);
        }
        break;
      case "land":
        await actionLand(args, rc, rl, db);
        break;
      case "status":
        await actionStatus(args, db);
        break;
      case "ps":
        await actionPS(db);
        break;
      case "kill":
        await actionKill(args, db);
        break;
      case "steer":
        await actionSteer(args, db);
        break;
      case "logs":
        await actionLogs(args, db);
        break;
      case "feed":
        await actionFeed(rc);
        break;
      case "briefing":
        await actionBriefing(rc);
        break;
      case "help":
        showHelp();
        break;
      case "quit":
      case "q":
        console.log(`\n  ${c.dim}Agents keep running. Type \`board\` to reconnect.${c.reset}\n`);
        cleanup();
        process.exit(0);
      default:
        console.log(`  ${c.dim}Unknown command: "${cmd}". Type "help" for commands.${c.reset}\n`);
    }

    loop();
  };

  loop();
}
