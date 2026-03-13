# TODOs

## Sprint Loop — P1 (the critical path)

### Identity library (P1)
**What:** Add an `identities/` folder system with markdown files that define agent personas — expertise, personality, processes, constraints. CLI commands: `board identity list`, `board identity show <name>`, `board identity create <name>`. Identities are injected into an agent's CLAUDE.md at spawn time via `--identity` flag on `board spawn`.
**Why:** Agents are currently blank slates. Identities turn them into specialized roles (backend-architect, test-engineer, frontend-dev) with domain expertise baked in. This is the difference between "do this task" and "you are an expert at X, do this task." Inspired by [agency-agents](https://github.com/msitarzewski/agency-agents) — 120+ curated agent personalities.
**Context:** Identity file format: markdown with YAML frontmatter (name, description, expertise, vibe). Body contains personality, processes, constraints, success criteria. At spawn time, identity content gets prepended to the agent's CLAUDE.md alongside project context + board API + mission. The `--identity` flag is optional — bare `board spawn` still works for ad-hoc agents.
**Effort:** M
**Depends on:** Nothing

### `board diff @agent` (P1)
**What:** Show the diff of an agent's worktree branch against main without merging.
**Why:** During a sprint, you want to review what each agent has built before committing to merge. Currently requires `cd .worktrees/@agent && git diff main` manually. Essential input to validate-sprint and merge-sprint.
**Context:** Simple wrapper: `git diff main..agent/<handle>` run from project root. Show file stats + full diff. Add `--stat` flag for summary only. Look up spawn record for worktree path / branch name.
**Effort:** S
**Depends on:** Nothing

### `board validate-sprint` (P1)
**What:** Pre-flight check before merge choreography: verify all agents stopped, run `npm test`, show combined diff stats across all agent branches, detect file conflicts between branches, suggest merge order based on file dependencies.
**Why:** Automates the manual "are we ready to merge?" checklist. During the M2 sprint we did this manually — checking `board ps`, running tests, diffing each branch. Catches merge disasters before they happen.
**Context:** Check `board ps` (all stopped), run test suite, `git diff --stat main..agent/*` for each branch, cross-reference changed files to detect overlap, suggest dependency-based merge order (e.g., schema before server before CLI).
**Effort:** M
**Depends on:** `board diff @agent`

### `board merge-sprint` (P1)
**What:** Automated merge choreography: merge agent branches in dependency order, run `npm test` after each merge, stop and report on first failure, post results to #status channel. Uses validate-sprint internally as pre-flight.
**Why:** The M2 merge required 4 manual merges with test gates and an import fix between merges. This should be a single command. It's the automation that makes multi-agent sprints practical for daily use.
**Context:** Takes merge order from validate-sprint (or user override). For each branch: `git merge --no-edit`, `npm test`, if fail → stop + report, if pass → continue. Posts summary to #status when complete. Supports `--dry-run` to preview without merging.
**Effort:** M
**Depends on:** `board validate-sprint`

### `board sprint` orchestrator (P1)
**What:** The single command that runs a full agent sprint: user provides goal + agent/identity/mission list, command handles create team, spawn agents with identities, monitor via feed, detect completion, run validate-sprint, run merge-sprint, write retro.
**Why:** This is the killer feature. Everything else is a building block for this. `board sprint "Build feature X"` should be all a user needs to type. The M2 sprint proved the pattern — this codifies it.
**Context:** Input format: YAML or CLI flags specifying agents with identities and missions. The command: (1) creates a team + route for the sprint, (2) pre-commits any schema/type changes if needed, (3) spawns all agents in parallel with identity injection, (4) enters monitoring mode (polls `board ps` + shows feed), (5) on all-done: runs validate-sprint, (6) prompts user to review diffs, (7) runs merge-sprint, (8) generates retro. Start simple: user provides the full agent list, defer automatic decomposition.
**Effort:** L
**Depends on:** Identity library, validate-sprint, merge-sprint

---

## Sprint Polish — P2

### `board retro` (P2)
**What:** Auto-generate sprint retrospective: agent count, total time, merge conflicts, test delta (before/after), files changed per agent, steering interventions. Writes RETRO.md.
**Why:** Institutional knowledge. Without it, each sprint starts from scratch. The retro data (timing, conflicts, agent behavior) is only available immediately after the sprint.
**Context:** Query spawn records for timing, git log for merge conflicts, test output for pass/fail delta. Template: sprint name, date, agents spawned, total time, merge conflicts (count + files), test results (before/after), lessons learned. Called automatically at end of `board sprint` or standalone.
**Effort:** S
**Depends on:** First sprint completion (done)

### `board log @agent` (P2)
**What:** Tail an agent's log file without knowing the path. `board log @m2-schema` instead of `tail -f .worktrees/@m2-schema/agent.log`. Add `--follow` flag for live tailing.
**Why:** During sprints you're constantly checking agent logs. Having to remember worktree paths is friction.
**Context:** Look up spawn record for agent handle, get `log_path`, exec `tail` (or `tail -f` with `--follow`). Error if agent has no spawn record or log path is null (foreground mode).
**Effort:** S
**Depends on:** Nothing

### Agency-agents format compatibility (P2)
**What:** Support importing identity files from the [agency-agents](https://github.com/msitarzewski/agency-agents) repo format (markdown with YAML frontmatter: name, description, emoji, vibe). `board identity import <path-or-url>` pulls them into the identities/ folder.
**Why:** Instant library of 120+ curated agent identities for free. Good ecosystem play — don't reinvent what already exists.
**Context:** The agency-agents format uses YAML frontmatter (name, description, color, emoji, vibe) + markdown body with sections for identity, philosophy, rules, processes, success criteria. Our import command reads these and copies/converts into our identities/ folder.
**Effort:** S
**Depends on:** Identity library

### Agent mission cards in web dashboard (P2)
**What:** Sidebar panel showing each active agent's mission, status, and latest post. Sprint war room view.
**Why:** The web dashboard shows agents as a list of handles + status dots. During a sprint, you want to see what each agent is doing at a glance — their mission, latest update, how long they've been running.
**Context:** Expand the agents sidebar in `dashboard.ts` or add a new panel. Data available via existing `/data/agents` endpoint + `/data/feed`. Could add a `/data/spawns` endpoint for runtime info.
**Effort:** M
**Depends on:** Nothing

### Sprint timer in interactive menu (P2)
**What:** Show elapsed time since first agent spawned and active/stopped/blocked counts in the interactive menu header.
**Why:** During a sprint, the header should feel alive: "Sprint: 12m | 2 running, 1 done, 1 blocked". Currently just shows static agent count.
**Context:** Modify `showHeader()` in `interactive.ts`. Calculate elapsed from earliest active spawn's `started_at`. Count spawns by status.
**Effort:** S
**Depends on:** Nothing

---

## Vision — P3 (deferred, builds on sprint loop)

### Manager orchestration + DAG integration (P3)
**What:** Managers can fetch agent bundles from the DAG, diff competing approaches, and make promote/kill decisions.
**Why:** This is the bridge between the DAG layer and the org structure. Without it, only the CEO can review code — managers are limited to reading posts. The whole point of the DAG is that managers can see actual work, not just status updates.
**Context:** Managers should be able to: fetch bundles from agents on their team, run `git diff` between competing approaches, post decision posts explaining why one approach won, promote the winner (or escalate to CEO). This builds on the existing DAG routes and the team/manager concepts. Deferred until sprint loop is solid — the sprint loop is the daily driver, manager autonomy is the 6-month vision.
**Effort:** L
**Depends on:** Sprint loop (complete), identity library

### Web dashboard DAG visualization (P3)
**What:** Add a DAG tree/graph view to the web dashboard showing commit ancestry, leaves, and agent activity.
**Why:** The dashboard currently shows feed/agents/channels but has zero DAG visibility. The CEO needs to see exploration progress visually.
**Context:** The `/data/dag` endpoint already returns `DagSummary`. A new panel or tab could render this as an interactive tree or graph. Start simple (list of leaves with agent badges) and evolve to full DAG graph.
**Effort:** M
**Depends on:** Git DAG layer (complete)
