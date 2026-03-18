import type { Command } from "commander";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { readBoardRC, api } from "./boardrc.js";
import { CliError, requireRC, die } from "./cli-shared.js";
import { normalizeHandle } from "./agents.js";
import { normalizeChannel } from "./channels.js";
import {
  c,
  renderSprintReport,
  renderSprintList,
  renderLandingBrief,
  renderAgentInspect,
  renderPortfolio,
  renderAlerts,
  renderRetro,
  renderRetroMarkdown,
  formatDuration,
  type RetroAgent,
  type RetroData,
} from "./render.js";
import type { Sprint, SprintAgent, SprintBranch, Alert } from "./types.js";
import {
  runPreFlight,
  buildSprintReport,
  buildLandingBrief,
  startSprint,
  startSprintCompression,
  bypassSprintCompression,
  squashMergeToMain,
  type AgentSpec,
} from "./sprint-orchestrator.js";

export function registerSprintCommands(program: Command): void {
  // --- board validate-sprint ---
  program
    .command("validate-sprint")
    .description("Validate sprint: check agents stopped, run tests, detect conflicts")
    .action(async () => {
      console.log("Running pre-flight checks...\n");
      const pf = await runPreFlight(process.cwd());

      if (!pf.allStopped) {
        console.log(`\u26a0 Running agents: ${pf.running.map((s) => s.agent_handle).join(", ")}`);
      } else {
        console.log("All agents stopped.");
      }

      console.log(pf.testsPass ? "Tests passed." : "Tests failed.");

      for (const b of pf.branches) {
        console.log(`\n--- ${b.agent_handle} (${b.branch}) ---`);
        console.log(`  +${b.additions} -${b.deletions} (${b.filesChanged} files)`);
      }

      if (pf.conflicts.length > 0) {
        console.log("\nConflicts detected:");
        for (const cf of pf.conflicts) {
          console.log(`  - ${cf}`);
        }
      } else {
        console.log("\nNo file conflicts detected.");
      }

      if (pf.mergeOrder.length > 0) {
        console.log("\nSuggested merge order:");
        pf.mergeOrder.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
      }

      const validation = {
        allStopped: pf.allStopped,
        testsPass: pf.testsPass,
        branches: pf.branches,
        conflicts: pf.conflicts.map((cf) => cf.split(" (")[0]),
        suggestedOrder: pf.mergeOrder,
      };

      console.log("\n" + JSON.stringify(validation, null, 2));
    });

  // --- board sprint ---
  const sprint = program.command("sprint").description("Sprint orchestrator — manage parallel agent work");

  sprint
    .command("suggest <goal>")
    .description("Smart task decomposition — analyzes codebase, calls Claude to generate a sprint plan")
    .option("--auto", "Call Claude CLI automatically instead of printing the prompt")
    .option("--save <path>", "Save the decomposition result to a JSON file")
    .action(async (goal: string, opts: { auto?: boolean; save?: string }) => {
      const projectDir = process.cwd();
      const {
        analyzeImports,
        findCouplingClusters,
        getFileContext,
        buildDecompositionPrompt,
        parseDecompositionResponse,
      } = await import("./decomposer.js");
      const { listIdentities, loadIdentity: loadId } = await import("./identities.js");

      console.log("Analyzing codebase...");

      const imports = analyzeImports(projectDir);
      const clusters = findCouplingClusters(imports);

      const fileContexts = new Map<string, import("./decomposer.js").FileContext>();
      const allFiles: string[] = [];
      for (const [file] of imports) {
        allFiles.push(file);
        const absPath = path.resolve(projectDir, file);
        fileContexts.set(file, getFileContext(absPath));
      }

      const identityNames = listIdentities(projectDir);
      const identities: { name: string; description: string }[] = [];
      for (const name of identityNames) {
        try {
          const id = loadId(name, projectDir);
          identities.push({ name: id.name, description: id.description });
        } catch { /* skip malformed */ }
      }

      console.log(`  ${allFiles.length} files, ${clusters.length} coupling clusters, ${identities.length} identities`);

      const prompt = buildDecompositionPrompt({
        goal,
        fileTree: allFiles,
        clusters,
        fileContexts,
        identities,
      });

      if (!opts.auto) {
        console.log("\n--- Decomposition Prompt ---\n");
        console.log(prompt);
        console.log("\nRun with --auto to call Claude CLI automatically.");
        return;
      }

      console.log("Calling Claude for task decomposition...");
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      let raw: string;
      try {
        raw = execSync(`claude -p '${escapedPrompt}'`, {
          cwd: projectDir,
          timeout: 120000,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (err: any) {
        die(`Claude CLI failed: ${err.message}`);
      }

      const result = parseDecompositionResponse(raw);
      console.log(`\nDecomposition: ${result.tasks.length} tasks\n`);
      for (const task of result.tasks) {
        console.log(`  ${task.handle} (${task.agent})`);
        console.log(`    Mission: ${task.mission.slice(0, 100)}${task.mission.length > 100 ? "..." : ""}`);
        console.log(`    Scope: ${task.scope.join(", ")}`);
        console.log();
      }

      if (opts.save) {
        fs.writeFileSync(opts.save, JSON.stringify(result, null, 2));
        console.log(`Plan saved to ${opts.save}`);
        console.log(`Start with: board sprint start --name my-sprint --goal "${goal}" --plan ${opts.save}`);
      }
    });

  sprint
    .command("run <goal>")
    .description("End-to-end sprint: decompose goal → confirm plan → spawn agents")
    .requiredOption("--name <name>", "Sprint name (slug)")
    .action(async (goal: string, opts: { name: string }) => {
      const projectDir = process.cwd();
      const rc = requireRC();
      const { decompose } = await import("./decomposer.js");

      console.log("Analyzing codebase and decomposing task...\n");

      let result;
      try {
        result = await decompose(goal, projectDir);
      } catch (err: any) {
        die(`Decomposition failed: ${err.message}`);
      }

      console.log(`Goal: ${result.goal}`);
      console.log(`Tasks: ${result.tasks.length}\n`);
      for (let i = 0; i < result.tasks.length; i++) {
        const t = result.tasks[i];
        console.log(`  ${i + 1}. ${t.handle} (${t.agent})`);
        console.log(`     ${t.mission.slice(0, 120)}${t.mission.length > 120 ? "..." : ""}`);
        console.log(`     Scope: ${t.scope.join(", ")}`);
        console.log();
      }

      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question("Proceed? [Y/n/edit] ", resolve);
      });
      rl.close();

      if (answer.toLowerCase() === "n") {
        console.log("Cancelled.");
        return;
      }

      if (answer.toLowerCase() === "edit") {
        const planPath = path.join(projectDir, `sprint-${opts.name}.json`);
        fs.writeFileSync(planPath, JSON.stringify(result, null, 2));
        console.log(`Plan saved to ${planPath}. Edit it, then run:`);
        console.log(`  board sprint start --name ${opts.name} --goal "${goal}" --plan ${planPath}`);
        return;
      }

      const planPath = path.join(projectDir, `sprint-${opts.name}.json`);
      fs.writeFileSync(planPath, JSON.stringify(result, null, 2));

      const escapedGoal = goal.replace(/"/g, '\\"');
      execSync(
        `npx tsx src/cli.ts sprint start --name ${opts.name} --goal "${escapedGoal}" --plan ${planPath}`,
        { cwd: projectDir, stdio: "inherit" }
      );

      const port = rc.url.match(/:(\d+)/)?.[1] ?? "3141";
      console.log(`\nKanban: http://localhost:${port}/app/`);
    });

  sprint
    .command("start")
    .description("Start a new sprint with multiple agents")
    .requiredOption("--name <name>", "Sprint name (slug)")
    .requiredOption("--goal <goal>", "Sprint goal description")
    .option("--plan <path>", "Path to JSON sprint plan file (simple mode)")
    .option("--agents <specs>", "Agent specs as JSON array: [{\"handle\":\"@x\",\"identity\":\"researcher\",\"mission\":\"...\"}]")
    .option("--yaml <path>", "Path to YAML sprint definition file")
    .action(async (opts: { name: string; goal: string; plan?: string; agents?: string; yaml?: string }) => {
      const rc = requireRC();
      const { getDb } = await import("./db.js");
      const db = getDb();

      let agentSpecs: AgentSpec[] = [];

      if (opts.plan) {
        const planPath = path.resolve(opts.plan);
        if (!fs.existsSync(planPath)) { db.close(); die(`Plan file not found: ${planPath}`); }
        let plan: {
          goal: string;
          tasks: {
            agent: string;
            handle: string;
            mission: string;
            scope: string[];
            track?: string;
            approachGroup?: string;
            approachLabel?: string;
          }[];
        };
        try { plan = JSON.parse(fs.readFileSync(planPath, "utf-8")); }
        catch (err: any) { db.close(); die(`Invalid JSON in plan file: ${err.message}`); }
        if (!plan.tasks || !Array.isArray(plan.tasks)) { db.close(); die("Plan must contain a 'tasks' array."); }
        agentSpecs = plan.tasks.map((t) => ({
          handle: t.handle,
          identity: t.agent,
          mission: t.mission,
          scope: t.scope,
          track: t.track,
          approachGroup: t.approachGroup,
          approachLabel: t.approachLabel,
        }));
      } else if (opts.yaml) {
        const content = fs.readFileSync(opts.yaml, "utf-8");
        try {
          const parsed = JSON.parse(content);
          agentSpecs = parsed.agents || [];
          if (!opts.name && parsed.name) opts.name = parsed.name;
          if (!opts.goal && parsed.goal) opts.goal = parsed.goal;
        } catch { db.close(); die(`Failed to parse sprint file: ${opts.yaml}`); }
      } else if (opts.agents) {
        try { agentSpecs = JSON.parse(opts.agents); }
        catch { db.close(); die("Invalid --agents JSON. Expected: [{\"handle\":\"@x\",\"mission\":\"...\"}]"); }
      } else {
        db.close();
        die("Provide --plan, --agents, or --yaml to define sprint agents.");
      }

      if (agentSpecs.length === 0) { db.close(); die("No agents defined for this sprint."); }

      console.log(`Starting sprint: ${opts.goal}`);
      console.log(`Tasks: ${agentSpecs.length}\n`);

      try {
        const result = await startSprint({
          name: opts.name,
          goal: opts.goal,
          specs: agentSpecs,
          projectDir: process.cwd(),
          serverUrl: rc.url,
          db,
          onSpawn: (handle, pid, branch) => {
            console.log(`  Spawned ${handle} (PID ${pid}, branch: ${branch})`);
          },
        });

        console.log(`\nSprint "${opts.name}" started with ${result.spawned.length} agents.`);
        console.log(`  board sprint status ${opts.name}  — check progress`);
        console.log(`  board sprint land ${opts.name}    — review and merge`);
        console.log(`  board alerts                      — check for issues`);
      } catch (err: any) {
        throw new CliError(err.message);
      } finally {
        db.close();
      }
    });

  sprint
    .command("list")
    .description("List all sprints")
    .action(async () => {
      const { getDb } = await import("./db.js");
      const db = getDb();
      const sprints = db.prepare("SELECT * FROM sprints ORDER BY created_at DESC").all() as Sprint[];
      console.log(renderSprintList(sprints));
      db.close();
    });

  sprint
    .command("status <name>")
    .description("Show sprint status with agent tiles")
    .option("--detail", "Show expanded tiles with full reports")
    .action(async (name: string, opts: { detail?: boolean }) => {
      try {
        const report = await buildSprintReport(name, process.cwd());
        console.log(renderSprintReport(report, opts.detail));
      } catch (err: any) {
        die(err.message);
      }
    });

  sprint
    .command("compress <name>")
    .description("Start or resume sprint synthesis/compression")
    .action(async (name: string) => {
      const rc = requireRC();
      const { getDb } = await import("./db.js");
      const db = getDb();

      try {
        const result = await startSprintCompression({
          sprintName: name,
          projectDir: process.cwd(),
          serverUrl: rc.url,
          db,
        });

        if (result.launched) {
          console.log(`Started synthesis for "${name}".`);
          if (result.merged.length > 0 || result.conflicted.length > 0) {
            console.log(`  merged: ${result.merged.length}, conflicted: ${result.conflicted.length}`);
          }
        } else {
          console.log(`Synthesis already in progress or ready for "${name}".`);
        }
      } catch (err: any) {
        die(err.message);
      } finally {
        db.close();
      }
    });

  sprint
    .command("land <name>")
    .description("CEO landing experience — review agent work in English, synthesize, and squash-merge")
    .option("--yes", "Skip interactive prompts and land the synthesized sprint once ready")
    .option("--wait", "Wait for workers/synthesis instead of returning immediately")
    .option("--bypass-compression <reason>", "Land even if synthesis failed, recording the reason")
    .action(async (name: string, opts: { yes?: boolean; wait?: boolean; bypassCompression?: string }) => {
      const projectDir = process.cwd();
      const readline = await import("readline");
      const { getDb } = await import("./db.js");
      const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      async function runLanding(): Promise<void> {
        const db = getDb();
        try {
          while (true) {
            console.log(`\n${c.dim}Building landing brief...${c.reset}\n`);

            const sprintRow = db.prepare(
              "SELECT * FROM sprints WHERE name = ?"
            ).get(name) as Sprint | undefined;
            if (!sprintRow) die(`Sprint not found: ${name}`);

            if (sprintRow.status === "running") {
              const pendingBrief = await buildLandingBrief(name, projectDir);
              console.log(renderLandingBrief(pendingBrief));

              if (pendingBrief.summary.running > 0) {
                if (!opts.wait) {
                  console.log(`\n  ${c.yellow}Agents are still running. Wait for them to finish before landing, or re-run with --wait.${c.reset}`);
                  return;
                }
                console.log(`\n  ${c.dim}Waiting for workers to finish...${c.reset}`);
                await sleep(2000);
                continue;
              }

              const rc = requireRC();
              const started = await startSprintCompression({
                sprintName: name,
                projectDir,
                serverUrl: rc.url,
                db,
              });
              console.log(`Started synthesis for "${name}".`);
              if (started.conflicted.length > 0) {
                console.log(`  ${started.conflicted.length} merge conflict bundle(s) handed to the condenser.`);
              }
              if (!opts.wait) {
                return;
              }
              console.log(`  ${c.dim}Waiting for synthesis to finish...${c.reset}`);
              await sleep(2000);
              continue;
            }

            const brief = await buildLandingBrief(name, projectDir);
            console.log(renderLandingBrief(brief));

            if (brief.sprint.status === "compressing" || brief.compression?.status === "running") {
              if (!opts.wait) {
                console.log(`\n  ${c.yellow}Synthesis is still running. Re-run land in a moment, or use board sprint land ${name} --wait.${c.reset}`);
                return;
              }
              console.log(`\n  ${c.dim}Waiting for synthesis to finish...${c.reset}`);
              await sleep(2000);
              continue;
            }

            if (opts.yes) {
              await doLand(brief, db, opts.bypassCompression);
              return;
            }

            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

            try {
              await interactiveLoop(brief, rl, ask, db);
            } finally {
              rl.close();
            }
            return;
          }
        } catch (err: any) {
          die(err.message);
        } finally {
          db.close();
        }
      }

      async function interactiveLoop(
        brief: Awaited<ReturnType<typeof buildLandingBrief>>,
        rl: import("readline").Interface,
        ask: (q: string) => Promise<string>,
        db: import("better-sqlite3").Database,
      ): Promise<void> {
        const synthesisFailed = brief.compression?.status === "failed";
        const needsBypass = synthesisFailed && !opts.bypassCompression;

        console.log("");
        let prompt = `  ${c.bold}[enter]${c.reset} ${needsBypass ? "land (requires bypass)" : "land synthesized result"}`;
        if (brief.compression?.status === "failed") prompt += `  ${c.bold}[b]${c.reset} bypass`;
        for (let i = 0; i < brief.agents.length; i++) {
          prompt += `  ${c.bold}[${i + 1}]${c.reset} ${brief.agents[i].handle}`;
        }
        prompt += `  ${c.bold}[q]${c.reset} quit`;
        console.log(prompt);

        const choice = await ask("  > ");

        if (choice === "q") return;

        if (choice === "b" && brief.compression?.status === "failed") {
          const reason = await ask("  bypass reason: ");
          await doLand(brief, db, reason);
          return;
        }

        const num = parseInt(choice, 10);
        if (!isNaN(num) && num >= 1 && num <= brief.agents.length) {
          const agent = brief.agents[num - 1];
          console.log("");
          console.log(renderAgentInspect(agent));

          const inspectChoice = await ask("  > ");

          if (inspectChoice === "d" && agent.branch) {
            try {
              const diff = execSync(`git diff main..${agent.branch}`, {
                cwd: projectDir, encoding: "utf-8", stdio: "pipe",
              });
              console.log(diff);
            } catch (err: any) {
              console.log(`  ${c.red}Could not show diff: ${err.message}${c.reset}`);
            }
          }

          await interactiveLoop(brief, rl, ask, db);
          return;
        }

        if (choice === "") {
          await doLand(brief, db, opts.bypassCompression);
          return;
        }

        console.log(`  ${c.dim}Unknown option.${c.reset}`);
        await interactiveLoop(brief, rl, ask, db);
      }

      async function doLand(
        brief: Awaited<ReturnType<typeof buildLandingBrief>>,
        db: import("better-sqlite3").Database,
        bypassReason?: string,
      ): Promise<void> {
        console.log(`\n  ${c.bold}Landing synthesized sprint...${c.reset}`);

        if (!brief.compression?.stagingBranch) {
          throw new CliError(`Sprint "${name}" is not ready to land — no staging branch recorded.`);
        }

        if (brief.compression.status === "failed" && !bypassReason?.trim()) {
          throw new CliError("Synthesis failed. Use --bypass-compression <reason> or choose [b] interactively.");
        }

        try {
          if (brief.compression.status === "failed" && bypassReason?.trim()) {
            bypassSprintCompression(db, name, bypassReason);
          }

          squashMergeToMain(
            projectDir,
            brief.compression.stagingBranch,
            name,
            brief.sprint.goal,
            brief.compression.stagingWorktreePath,
          );

          db.prepare(
            "UPDATE sprints SET status = 'finished', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE name = ?"
          ).run(name);

          console.log(`\n  ${c.green}Landed synthesized sprint "${name}".${c.reset}`);

          try {
            const rc = requireRC();
            await api(rc, "POST", "/api/posts", {
              content: `Sprint "${name}" landed as a synthesized squash commit.`,
              channel: "#status",
            });
            console.log(`  ${c.dim}Posted to #status${c.reset}`);
          } catch { /* best effort */ }
        } catch (err: any) {
          console.error(`  ${c.red}Merge failed: ${err.message}${c.reset}`);
          db.prepare(
            "UPDATE sprints SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE name = ?"
          ).run(name);
        }
      }

      await runLanding();
    });

  // --- board steer ---
  program
    .command("steer <handle> [message]")
    .description("Send a directive to a running agent, or clear directives with --clear")
    .option("--clear", "Clear all directives for this agent")
    .action(async (handle: string, message: string | undefined, opts: { clear?: boolean }) => {
      const h = normalizeHandle(handle);
      const projectDir = process.cwd();

      if (opts.clear) {
        const { clearDirectives } = await import("./spawner.js");
        try {
          clearDirectives(projectDir, h);
          console.log(`Cleared directives for ${h}`);
        } catch (err: any) {
          die(err.message);
        }
        return;
      }

      if (!message) {
        die("Message is required (or use --clear)");
      }

      const { writeDirective } = await import("./spawner.js");
      try {
        writeDirective(projectDir, h, message);
        console.log(`Wrote directive to ${h}`);
      } catch (err: any) {
        die(err.message);
      }

      const rc = readBoardRC();
      if (rc) {
        try {
          await api(rc, "POST", "/api/posts", {
            content: `@${h.replace("@", "")} DIRECTIVE: ${message}`,
            channel: "#work",
            author: "@admin",
          });
          console.log(`Posted directive to #work`);
        } catch {
          // Best effort — agent reads CLAUDE.md regardless
        }
      }
    });

  // --- board cleanup ---
  program
    .command("cleanup")
    .description("Delete merged agent branches and prune worktrees")
    .option("--dry-run", "Show what would be deleted without doing it")
    .action(async (opts: { dryRun?: boolean }) => {
      const projectDir = process.cwd();
      const { listSpawns } = await import("./spawner.js");
      const { getDb } = await import("./db.js");
      const db = getDb();
      const spawns = listSpawns(db);
      db.close();

      const parseBranches = (output: string) =>
        output.split("\n").map((b) => b.trim().replace(/^[*+] /, "")).filter((b) => b.startsWith("agent/"));

      const allBranches = parseBranches(
        execSync("git branch", { cwd: projectDir, encoding: "utf-8" })
      );

      const mergedSet = new Set(parseBranches(
        execSync("git branch --merged", { cwd: projectDir, encoding: "utf-8" })
      ));

      const activeBranches = new Set(
        spawns.filter((s) => !s.stopped_at && s.branch).map((s) => s.branch!)
      );

      const toDelete = allBranches.filter((b) => mergedSet.has(b) && !activeBranches.has(b));
      const remaining = allBranches.filter((b) => !toDelete.includes(b));

      if (toDelete.length === 0) {
        console.log("No merged agent branches to clean up.");
        return;
      }

      console.log(`Found ${toDelete.length} merged agent branch${toDelete.length === 1 ? "" : "es"}:`);
      for (const b of toDelete) {
        const agentHandle = "@" + b.replace("agent/", "");
        const worktreePath = path.join(projectDir, ".worktrees", agentHandle);
        console.log(`  ${opts.dryRun ? "[dry-run] " : ""}delete ${b}`);
        if (!opts.dryRun) {
          if (fs.existsSync(worktreePath)) {
            try {
              execSync(`git worktree remove "${worktreePath}" --force`, { cwd: projectDir, stdio: "pipe" });
            } catch {
              try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
            }
          }
          try {
            execSync(`git branch -D ${b}`, { cwd: projectDir, stdio: "pipe" });
          } catch {
            console.error(`    Failed to delete ${b}`);
          }
        }
      }

      if (!opts.dryRun) {
        try {
          execSync("git worktree prune", { cwd: projectDir, stdio: "pipe" });
        } catch { /* ignore */ }
        console.log("Done.");
      }

      if (remaining.length > 0) {
        console.log(`\n${remaining.length} unmerged branch${remaining.length === 1 ? "" : "es"} kept: ${remaining.join(", ")}`);
      }
    });

  // --- board portfolio ---
  program
    .command("portfolio")
    .description("Bird's-eye view of all sprints")
    .action(async () => {
      const { getDb } = await import("./db.js");
      const { listSpawns, isProcessAlive } = await import("./spawner.js");
      const db = getDb();

      const sprints = db.prepare("SELECT * FROM sprints ORDER BY created_at DESC").all() as Sprint[];
      const spawns = listSpawns(db);

      const portfolioData = sprints.map((s) => {
        const agents = db.prepare("SELECT * FROM sprint_agents WHERE sprint_name = ?").all(s.name) as SprintAgent[];
        let running = 0;
        let stopped = 0;
        for (const a of agents) {
          const spawn = spawns.find((sp) => sp.agent_handle === a.agent_handle);
          if (spawn && !spawn.stopped_at && isProcessAlive(spawn.pid)) {
            running++;
          } else {
            stopped++;
          }
        }
        return { sprint: s, agentCount: agents.length, running, stopped };
      });

      console.log(renderPortfolio(portfolioData));
      db.close();
    });

  // --- board alerts ---
  program
    .command("alerts")
    .description("Show alerts derived from escalations, crashes, and stale agents")
    .action(async () => {
      const { getDb } = await import("./db.js");
      const { listSpawns, isProcessAlive } = await import("./spawner.js");
      const db = getDb();

      const alerts: Alert[] = [];

      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const escalations = db.prepare(
        "SELECT author, content, created_at FROM posts WHERE channel = '#escalations' AND created_at >= ? ORDER BY created_at DESC"
      ).all(oneDayAgo) as { author: string; content: string; created_at: string }[];

      for (const e of escalations) {
        alerts.push({
          type: "escalation",
          agent: e.author,
          message: e.content.length > 100 ? e.content.slice(0, 97) + "..." : e.content,
          time: e.created_at,
        });
      }

      const { markSpawnStopped } = await import("./spawner.js");
      const spawns = listSpawns(db);
      for (const s of spawns) {
        if (s.stopped_at) {
          if (s.exit_code !== null && s.exit_code > 0) {
            alerts.push({
              type: "crashed",
              agent: s.agent_handle,
              message: `Exited with code ${s.exit_code} (started ${s.started_at})`,
              time: s.stopped_at,
            });
          }
          continue;
        }
        if (!isProcessAlive(s.pid)) {
          markSpawnStopped(db, s.agent_handle);
          alerts.push({
            type: "crashed",
            agent: s.agent_handle,
            message: `Process ${s.pid} is dead (started ${s.started_at})`,
            time: s.started_at,
          });
        }
      }

      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      for (const s of spawns) {
        if (s.stopped_at || !isProcessAlive(s.pid)) continue;
        const recentPost = db.prepare(
          "SELECT created_at FROM posts WHERE author = ? AND created_at >= ? LIMIT 1"
        ).get(s.agent_handle, thirtyMinAgo) as { created_at: string } | undefined;

        if (!recentPost) {
          alerts.push({
            type: "stale",
            agent: s.agent_handle,
            message: "Running but no posts in 30+ minutes",
            time: s.started_at,
          });
        }
      }

      console.log(renderAlerts(alerts));
      db.close();
    });

  // --- board retro ---
  program
    .command("retro <sprint-name>")
    .description("Auto-generate sprint retrospective")
    .action(async (sprintName: string) => {
      const { initDb } = await import("./db.js");
      const { getSpawn, isProcessAlive } = await import("./spawner.js");
      const { parseNumstat } = await import("./sprint-orchestrator.js");

      const db = initDb(process.cwd());
      const projectDir = process.cwd();

      const sprintRow = db.prepare("SELECT * FROM sprints WHERE name = ?").get(sprintName) as { name: string; goal: string; status: string; created_at: string; finished_at: string | null } | undefined;
      if (!sprintRow) {
        db.close();
        die(`Sprint not found: ${sprintName}`);
      }

      const sprintAgents = db.prepare("SELECT * FROM sprint_agents WHERE sprint_name = ?").all(sprintName) as { sprint_name: string; agent_handle: string; identity_name: string | null; mission: string | null }[];

      const retroAgents: RetroAgent[] = [];
      let totalConflicts = 0;

      for (const sa of sprintAgents) {
        const spawn = getSpawn(db, sa.agent_handle);
        const runtime = spawn ? formatDuration(spawn.started_at, spawn.stopped_at) : "?";
        const exitCode = spawn?.exit_code ?? null;
        const branch = spawn?.branch ?? null;

        let additions = 0, deletions = 0, filesChanged = 0;
        if (branch) {
          const numstat = parseNumstat(projectDir, branch);
          if (numstat) {
            additions = numstat.additions;
            deletions = numstat.deletions;
            filesChanged = numstat.filesChanged;
          }
        }

        retroAgents.push({
          handle: sa.agent_handle,
          branch,
          runtime,
          exitCode,
          filesChanged,
          additions,
          deletions,
        });
      }

      try {
        const conflictLog = execSync("git log --all --oneline --grep='conflict' 2>/dev/null || true", {
          cwd: projectDir,
          encoding: "utf-8",
          stdio: "pipe",
        }).trim();
        totalConflicts = conflictLog ? conflictLog.split("\n").length : 0;
      } catch { /* ignore */ }

      const retro: RetroData = {
        sprintName: sprintRow.name,
        goal: sprintRow.goal,
        created_at: sprintRow.created_at,
        finished_at: sprintRow.finished_at,
        agents: retroAgents,
        conflicts: totalConflicts,
        testDelta: null,
      };

      const retroMd = renderRetroMarkdown(retro);
      fs.writeFileSync(path.join(projectDir, "RETRO.md"), retroMd);

      console.log(renderRetro(retro));
      console.log(`\n  ${c.dim}Written to RETRO.md${c.reset}`);
      db.close();
    });
}
