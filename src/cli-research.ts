import type { Command } from "commander";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { readBoardRC, api } from "./boardrc.js";
import { die } from "./cli-shared.js";
import {
  c,
  renderResearchHistory,
  type ResearchSession,
} from "./render.js";

// === Metric presets ===

interface MetricPreset {
  description: string;
  eval: string;
  metric: string;
  direction: "higher" | "lower";
  guard: string;
}

const METRIC_PRESETS: Record<string, MetricPreset> = {
  tests: {
    description: "Maximize test count with zero failures",
    eval: "npm test",
    metric: "grep '^ℹ tests' eval.log | awk '{print $3}'",
    direction: "higher",
    guard: "grep '^ℹ fail' eval.log | awk '{print $3}' | xargs test 0 -eq",
  },
  lean: {
    description: "Minimize source lines of code (tests must pass)",
    eval: "find src -name '*.ts' ! -name '*.test.ts' | xargs wc -l",
    metric: "tail -1 eval.log | awk '{print $1}'",
    direction: "lower",
    guard: "npm test > /dev/null 2>&1",
  },
  coverage: {
    description: "Maximize test coverage percentage",
    eval: "npx c8 --reporter=text npm test",
    metric: "grep 'All files' eval.log | awk '{print $4}' | tr -d '%'",
    direction: "higher",
    guard: "grep '^ℹ fail' eval.log | awk '{print $3}' | xargs test 0 -eq",
  },
  speed: {
    description: "Minimize test duration (tests must pass)",
    eval: "npm test",
    metric: "grep '^ℹ duration_ms' eval.log | awk '{print $3}'",
    direction: "lower",
    guard: "grep '^ℹ fail' eval.log | awk '{print $3}' | xargs test 0 -eq",
  },
  security: {
    description: "Minimize security issues found by grep audit",
    eval: "grep -rn 'eval(\\|exec(\\|execSync(\\|innerHTML\\|dangerouslySetInnerHTML\\|__proto__\\|constructor.prototype' src/ --include='*.ts' || true",
    metric: "wc -l < eval.log | tr -d ' '",
    direction: "lower",
    guard: "npm test > /dev/null 2>&1",
  },
  condense: {
    description: "Structural code condensation — merge files, inline functions, eliminate dead exports (uses condenser identity)",
    eval: "find src -name '*.ts' ! -name '*.test.ts' | xargs wc -l",
    metric: "tail -1 eval.log | awk '{print $1}'",
    direction: "lower",
    guard: "npm test > /dev/null 2>&1",
  },
  explore: {
    description: "Branching exploration — try 3 approaches per round, pick the best (uses explorer identity)",
    eval: "find src -name '*.ts' ! -name '*.test.ts' | xargs wc -l",
    metric: "tail -1 eval.log | awk '{print $1}'",
    direction: "lower",
    guard: "npm test > /dev/null 2>&1",
  },
};

/** Load custom presets from .boardrc if available, merge with built-ins. */
function loadMergedPresets(): { presets: Record<string, MetricPreset>; customNames: Set<string> } {
  const customNames = new Set<string>();
  const rc = readBoardRC();
  if (rc) {
    try {
      const rcPath = path.join(process.cwd(), ".boardrc");
      const rcData = JSON.parse(fs.readFileSync(rcPath, "utf-8"));
      if (rcData.presets && typeof rcData.presets === "object") {
        for (const name of Object.keys(rcData.presets)) {
          customNames.add(name);
        }
        return { presets: { ...METRIC_PRESETS, ...rcData.presets }, customNames };
      }
    } catch { /* ignore parse errors */ }
  }
  return { presets: { ...METRIC_PRESETS }, customNames };
}

export function registerResearchCommands(program: Command): void {
  const research = program.command("research").description("Auto-research: self-improving background agent");

  research
    .command("start")
    .description("Start the auto-research agent (Karpathy-style self-improving loop)")
    .option("--tag <tag>", "Run tag for this session (e.g. 'mar13-security'). Creates branch agent/researcher-<tag>")
    .option("--preset <name>", "Use a metric preset: tests, lean, coverage, speed, security")
    .option("--focus <topic>", "Focus the researcher on a specific area (e.g. 'security', 'test coverage')")
    .option("--scope <files>", "Comma-separated list of in-scope files (e.g. 'src/server.ts,src/routes.ts')")
    .option("--eval <command>", "Eval command (overrides preset)")
    .option("--metric <command>", "Shell command to extract metric from eval.log (overrides preset)")
    .option("--direction <dir>", "Optimize direction: 'higher' or 'lower' (overrides preset)")
    .option("--guard <command>", "Guard command that must exit 0 for KEEP (overrides preset)")
    .option("--identity <name>", "Identity to use (default: researcher, condense preset uses condenser)")
    .option("--width <n>", "Exploration width for explorer identity — approaches per round (default: 3)")
    .option("--foreground", "Run in foreground instead of background")
    .action(async (opts: { tag?: string; preset?: string; focus?: string; scope?: string; eval?: string; metric?: string; direction?: string; guard?: string; identity?: string; width?: string; foreground?: boolean }) => {
      const { initDb } = await import("./db.js");
      const { loadIdentity } = await import("./identities.js");
      const { createAgent, getAgent } = await import("./agents.js");
      const { generateKey, storeKey } = await import("./auth.js");
      const { spawnAgent, respawnAgent, getSpawn, isProcessAlive } = await import("./spawner.js");

      const rc = readBoardRC();
      if (!rc) {
        die("No .boardrc found. Run `board init` first.");
      }

      const { presets: mergedPresets } = loadMergedPresets();
      const presetName = opts.preset || "tests";
      const preset = mergedPresets[presetName];
      if (opts.preset && !preset) {
        die(`Unknown preset: ${opts.preset}. Available: ${Object.keys(mergedPresets).join(", ")}`);
      }
      const resolvedMetric = {
        eval: opts.eval || preset.eval,
        metric: opts.metric || preset.metric,
        direction: opts.direction || preset.direction,
        guard: opts.guard ?? preset.guard,
      };

      const db = initDb(process.cwd());
      const handle = opts.tag ? `researcher-${opts.tag}` : "researcher";
      const normalizedHandle = `@${handle}`;

      const existingSpawn = getSpawn(db, normalizedHandle);
      if (existingSpawn && !existingSpawn.stopped_at && isProcessAlive(existingSpawn.pid)) {
        db.close();
        die(`Researcher is already running (PID ${existingSpawn.pid}). Use \`board research stop${opts.tag ? ` --tag ${opts.tag}` : ""}\` first.`);
      }

      const identityName = opts.identity || (presetName === "condense" ? "condenser" : presetName === "explore" ? "explorer" : "researcher");
      let identity;
      try {
        identity = loadIdentity(identityName, process.cwd());
      } catch {
        db.close();
        die(`Identity not found at identities/${identityName}.md`);
      }

      let mission = "Autonomously scan and improve this codebase. Follow the experiment loop in your identity: scan → improve → test → commit → report → repeat. Never stop.";

      if (opts.focus) {
        mission += `\n\nFOCUS: Prioritize improvements related to: ${opts.focus}`;
      }

      if (opts.scope) {
        const files = opts.scope.split(",").map(f => f.trim());
        mission += `\n\nIN-SCOPE FILES (only modify these):\n${files.map(f => `- ${f}`).join("\n")}`;
      }

      const metricConfig: Record<string, string> = {
        EVAL_COMMAND: resolvedMetric.eval,
        METRIC_COMMAND: resolvedMetric.metric,
        DIRECTION: resolvedMetric.direction,
        GUARD_COMMAND: resolvedMetric.guard,
        WIDTH: opts.width || "3",
      };

      if (identity) {
        let content = identity.content;
        for (const [key, value] of Object.entries(metricConfig)) {
          content = content.replaceAll(`{{${key}}}`, value);
        }
        identity = { ...identity, content };
      }

      const existing = getAgent(db, normalizedHandle);
      try {
        if (existing && existingSpawn) {
          const result = respawnAgent(db, normalizedHandle, {
            mission,
            serverUrl: rc.url,
            projectDir: process.cwd(),
            foreground: opts.foreground,
          });
          console.log(`Researcher respawned (PID ${result.pid})`);
          console.log(`  Tag: ${opts.tag || "(default)"}`);
          console.log(`  Branch: ${result.branch}`);
          console.log(`  Worktree: ${result.worktreePath}`);
        } else {
          if (!existing) {
            createAgent(db, { handle, name: `Auto-Researcher${opts.tag ? ` (${opts.tag})` : ""}`, role: "worker", mission });
          }
          const apiKey = generateKey();
          storeKey(db, apiKey, normalizedHandle);

          const result = spawnAgent(db, {
            handle: normalizedHandle,
            mission,
            apiKey,
            serverUrl: rc.url,
            projectDir: process.cwd(),
            foreground: opts.foreground,
            identity,
          });
          console.log(`Researcher started (PID ${result.pid})`);
          console.log(`  Tag: ${opts.tag || "(default)"}`);
          console.log(`  Branch: ${result.branch}`);
          console.log(`  Worktree: ${result.worktreePath}`);
        }
      } catch (err: any) {
        db.close();
        die(`Failed to start researcher: ${err.message}`);
      }

      if (opts.focus) console.log(`  Focus: ${opts.focus}`);
      if (opts.scope) console.log(`  Scope: ${opts.scope}`);
      console.log(`  Preset: ${presetName}${preset ? ` — ${preset.description}` : ""}`);
      console.log(`  Eval: ${resolvedMetric.eval}`);
      console.log(`  Metric: ${resolvedMetric.metric}`);
      console.log(`  Direction: ${resolvedMetric.direction}`);
      if (resolvedMetric.guard) console.log(`  Guard: ${resolvedMetric.guard}`);

      if (!opts.foreground) {
        const h = opts.tag ? `@researcher-${opts.tag}` : "@researcher";
        console.log("\nResearcher is running in the background.");
        console.log(`  board research status${opts.tag ? ` --tag ${opts.tag}` : ""}  — check progress`);
        console.log("  board feed -c #research    — see findings");
        console.log(`  board diff ${h}     — review changes`);
        console.log(`  board research stop${opts.tag ? ` --tag ${opts.tag}` : ""}   — stop the researcher`);
      }

      db.close();
    });

  research
    .command("presets")
    .description("List available metric presets (including custom from .boardrc)")
    .action(() => {
      const { presets, customNames } = loadMergedPresets();
      console.log("Available presets:\n");
      for (const [name, preset] of Object.entries(presets)) {
        const tag = customNames.has(name) ? ` ${c.cyan}[custom]${c.reset}` : "";
        console.log(`  ${name}${tag}`);
        console.log(`    ${preset.description}`);
        console.log(`    eval:      ${preset.eval}`);
        console.log(`    metric:    ${preset.metric}`);
        console.log(`    direction: ${preset.direction}`);
        console.log(`    guard:     ${preset.guard}`);
        console.log();
      }
      console.log("Usage: board research start --preset <name>");
      console.log("Override any field: board research start --preset lean --guard 'npm test'");
    });

  research
    .command("stop")
    .description("Stop the auto-research agent")
    .option("--tag <tag>", "Run tag to stop (default: no tag)")
    .action(async (opts: { tag?: string }) => {
      const { initDb } = await import("./db.js");
      const { killAgent } = await import("./spawner.js");

      const db = initDb(process.cwd());
      const handle = opts.tag ? `@researcher-${opts.tag}` : "@researcher";

      try {
        killAgent(db, handle, process.cwd());
        console.log(`Researcher${opts.tag ? ` (${opts.tag})` : ""} stopped.`);
      } catch (err: any) {
        console.error(err.message);
      }

      db.close();
    });

  research
    .command("status")
    .description("Show auto-research agent status and recent findings")
    .option("--tag <tag>", "Run tag to check (default: no tag)")
    .action(async (opts: { tag?: string }) => {
      const { initDb } = await import("./db.js");
      const { getSpawn, isProcessAlive } = await import("./spawner.js");
      const { listPosts } = await import("./posts.js");
      const { getChannel } = await import("./channels.js");

      const db = initDb(process.cwd());
      const handle = opts.tag ? `@researcher-${opts.tag}` : "@researcher";

      const spawn = getSpawn(db, handle);
      if (!spawn) {
        console.log(`No researcher${opts.tag ? ` (${opts.tag})` : ""} has been started. Run \`board research start${opts.tag ? ` --tag ${opts.tag}` : ""}\`.`);
        db.close();
        return;
      }

      const alive = !spawn.stopped_at && isProcessAlive(spawn.pid);
      console.log(`Researcher${opts.tag ? ` (${opts.tag})` : ""}: ${alive ? "RUNNING" : "STOPPED"}`);
      console.log(`  PID: ${spawn.pid}`);
      console.log(`  Branch: ${spawn.branch || "(none)"}`);
      console.log(`  Started: ${spawn.started_at}`);
      if (spawn.stopped_at) console.log(`  Stopped: ${spawn.stopped_at}`);

      if (spawn.worktree_path) {
        const resultsPath = path.join(spawn.worktree_path, "results.md");
        if (fs.existsSync(resultsPath)) {
          const results = fs.readFileSync(resultsPath, "utf-8").trim();
          const lines = results.split("\n");
          const experiments = lines.filter(l => l.startsWith("|") && !l.includes("commit") && !l.includes("---")).length;
          const kept = lines.filter(l => l.includes("| keep |")).length;
          const discarded = lines.filter(l => l.includes("| discard |")).length;
          const crashed = lines.filter(l => l.includes("| crash |")).length;

          console.log(`\nExperiments: ${experiments} total — ${kept} kept, ${discarded} discarded, ${crashed} crashed`);

          const dataLines = lines.filter(l => l.startsWith("|") && !l.includes("commit") && !l.includes("---"));
          const recent = dataLines.slice(-5);
          if (recent.length > 0) {
            console.log("\nRecent experiments:");
            for (const line of recent) {
              console.log(`  ${line}`);
            }
          }
        }
      }

      if (getChannel(db, "#research")) {
        const posts = listPosts(db, { channel: "#research", limit: 5 });
        if (posts.length > 0) {
          console.log(`\nRecent posts (${posts.length}):`);
          for (const p of posts) {
            const preview = p.content.substring(0, 120).replace(/\n/g, " ");
            console.log(`  ${p.created_at.substring(11, 16)} — ${preview}`);
          }
        }
      }

      if (spawn.branch) {
        try {
          const stat = execSync(`git diff --stat main..${spawn.branch}`, {
            cwd: process.cwd(),
            encoding: "utf-8",
            stdio: "pipe",
          });
          if (stat.trim()) {
            console.log(`\nAccumulated changes vs main:`);
            console.log(stat);
          }
        } catch { /* branch may not exist yet */ }
      }

      db.close();
    });

  research
    .command("focus <topic>")
    .description("Steer the researcher to focus on a specific area")
    .action(async (topic: string) => {
      const rc = readBoardRC();
      if (!rc) {
        die("No .boardrc found. Run `board init` first.");
      }

      await api(rc, "POST", "/api/posts", {
        content: `focus: ${topic}`,
        channel: "#research",
      });
      console.log(`Focus directive posted: "${topic}"`);
      console.log("The researcher will pick this up in its next cycle.");
    });

  research
    .command("history")
    .description("Show past research sessions")
    .action(async () => {
      const { initDb } = await import("./db.js");

      const db = initDb(process.cwd());

      const spawns = db.prepare(
        "SELECT * FROM spawns WHERE agent_handle LIKE '@researcher%' ORDER BY started_at DESC"
      ).all() as { agent_handle: string; pid: number; log_path: string | null; worktree_path: string | null; branch: string | null; started_at: string; stopped_at: string | null; exit_code: number | null }[];

      const sessions: ResearchSession[] = spawns.map((s) => {
        const tag = s.agent_handle.replace(/^@researcher-?/, "") || "(default)";

        let experiments: number | null = null;
        let kept: number | null = null;
        let discarded: number | null = null;

        if (s.worktree_path && fs.existsSync(s.worktree_path)) {
          const resultsPath = path.join(s.worktree_path, "results.md");
          if (fs.existsSync(resultsPath)) {
            const content = fs.readFileSync(resultsPath, "utf-8");
            const lines = content.split("\n");
            const dataLines = lines.filter(l => l.startsWith("|") && !l.includes("commit") && !l.includes("---"));
            experiments = dataLines.length;
            kept = lines.filter(l => l.includes("| keep |")).length;
            discarded = lines.filter(l => l.includes("| discard |")).length;
          }
        }

        return {
          handle: s.agent_handle,
          tag,
          preset: null,
          branch: s.branch,
          started_at: s.started_at,
          stopped_at: s.stopped_at,
          experiments,
          kept,
          discarded,
        };
      });

      console.log(renderResearchHistory(sessions));
      db.close();
    });
}
