# TODOs

## Done

### ~~Identity library~~ ✓
Built: `identities/` folder with YAML frontmatter markdown files. `loadIdentity()`, `listIdentities()`, `saveIdentity()`, `parseIdentityFrontmatter()` in `src/identities.ts`. Researcher identity ships as `identities/researcher.md`. Injected into CLAUDE.md at spawn time.

### ~~Auto-research system~~ ✓
Built: Karpathy-style autonomous self-improvement loop. `board research start/stop/status/focus/presets`. Researcher identity with templated metrics (`{{EVAL_COMMAND}}`, `{{METRIC_COMMAND}}`, `{{DIRECTION}}`, `{{GUARD_COMMAND}}`). User-definable metrics at launch — like Karpathy's val_bpb but configurable per session. Five built-in presets: tests, lean, coverage, speed, security. Worktree isolation with node_modules symlink. Results tracked in `results.md`, findings posted to `#research` channel.

### ~~Worktree node_modules symlink~~ ✓
Built: `spawner.ts` `createWorktree()` symlinks `node_modules` from project root into every worktree so agents can run tests/builds without `npm install`.

### ~~`board diff @agent`~~ ✓
Built: cli.ts:1103-1137. `git diff main..{branch}` with `--stat` flag. Looks up spawn record for branch name.

### ~~`board validate-sprint`~~ ✓
Built: cli.ts:1172-1299. Checks all agents stopped, runs `npm test`, shows diff stats per branch, detects file conflicts (files changed by multiple branches), suggests merge order (fewest files first), outputs JSON validation result.

### ~~`board merge @agent`~~ ✓
Built: cli.ts:706-728, spawner.ts:416-488. Merges agent branch into main with `--cleanup` flag to remove worktree + branch after.

### ~~`board log @agent`~~ ✓
Built: cli.ts:1140-1169. Tails agent log file with `--follow` flag for live tailing.

### ~~Ship as npm package~~ ✓ (config done)
Config complete: shebang via tsup banner, `"files": ["dist"]` in package.json, bin entry `"board": "./dist/cli.js"`. Just needs `npm publish` when ready.

---

## Sprint Loop — P1 (the critical path)

### `board merge-sprint` (P1)
**What:** Automated sequential merge of all agent branches with test gates between each merge. Calls validate-sprint internally as pre-flight, then merges in suggested order, runs `npm test` after each, stops and reports on first failure, posts results to #status channel.
**Why:** The M2 merge required 4 manual merges with test gates and an import fix between merges. This should be a single command. `board merge` exists for individual agents but there's no automated multi-merge with test gates.
**Context:** Uses existing `validate-sprint` for pre-flight + merge order. Uses existing `mergeAgent()` from spawner.ts for each merge. New logic: sequential loop with test gate between each. Supports `--dry-run` to preview. Posts summary to #status. If a merge fails tests, stops and reports which agent's merge broke things.
**Effort:** M
**Depends on:** validate-sprint (done), merge @agent (done)

### `board sprint` orchestrator (P1)
**What:** Single command that runs a full agent sprint: user provides goal + agent/identity/mission list, command handles spawn agents with identities, monitor via feed, detect completion, run validate-sprint, prompt to review diffs, run merge-sprint, generate retro.
**Why:** This is the killer feature. `board sprint "Build feature X"` should be all a user needs. The M2 sprint proved the pattern — this codifies it.
**Context:** Input format: YAML or CLI flags specifying agents with identities and missions. The command: (1) spawns all agents in parallel with identity injection, (2) enters monitoring mode (polls `board ps` + shows feed), (3) on all-done: runs validate-sprint, (4) prompts user to review diffs, (5) runs merge-sprint, (6) generates retro. Start simple: user provides the full agent list, defer automatic task decomposition.
**Effort:** L
**Depends on:** merge-sprint

### `board init` polish (P1)
**What:** Enhance the existing `board init` with starter identities and clearer next-step messaging. Current init (cli.ts:110-167) already creates DB, admin agent, #general channel, admin key, .dag/ repo, .boardrc, and auto-starts server.
**Why:** First-run experience needs to end with "try `board research start`" or "try `board sprint`". Scaffolding starter identities gives users something to work with immediately.
**Context:** Add: (1) scaffold `identities/` with 3-4 starter identities (backend-architect, test-engineer, code-reviewer), (2) print clear next steps pointing to sprint/research commands, (3) check if identities/ already exists before scaffolding.
**Effort:** S
**Depends on:** Nothing

---

## Auto-Research Enhancements — P2

### Custom metric presets via file (P2)
**What:** Let users define custom presets in a `presets/` folder (or `.board/presets/`) as YAML/JSON files, loaded alongside the built-in presets. `board research presets` shows both built-in and custom.
**Why:** The 5 built-in presets cover common cases, but teams will want project-specific metrics (e.g., bundle size, API response time, lint score). Currently they have to pass `--eval/--metric/--direction/--guard` every time.
**Context:** Built-in presets live in `METRIC_PRESETS` in cli.ts. Custom presets would be files like `presets/bundle-size.yml` with the same fields. `board research presets` merges both sets.
**Effort:** S
**Depends on:** Nothing

### Research session history (P2)
**What:** `board research history` shows past research sessions — tag, preset used, metric values at start/end, experiments run, kept/discarded ratio.
**Why:** After running several research sessions, you want to see which ones were productive and what presets worked best. Currently results.md is per-session and in the worktree.
**Context:** Could query spawn records + read results.md from worktree paths. Or store summary in DB when researcher stops.
**Effort:** S
**Depends on:** Nothing

### DRY refactor: spawn logic in CLI (P2)
**What:** Extract duplicated spawn logic from `board spawn`, `board research start`, and future sprint commands into a shared helper.
**Why:** Three commands all do: check .boardrc, init DB, load identity, create agent, generate key, call spawnAgent. Copy-pasted with minor variations. Adding a 4th caller will make this worse.
**Context:** Extract a `prepareAndSpawn()` helper that takes handle, mission, identity name, and options. Each CLI command becomes a thin wrapper.
**Effort:** S
**Depends on:** Nothing

---

## Sprint Polish — P2

### `board retro` (P2)
**What:** Auto-generate sprint retrospective: agent count, total time, merge conflicts, test delta (before/after), files changed per agent, steering interventions. Writes RETRO.md.
**Why:** Institutional knowledge. Without it, each sprint starts from scratch. The retro data (timing, conflicts, agent behavior) is only available immediately after the sprint.
**Context:** Query spawn records for timing, git log for merge conflicts, test output for pass/fail delta. Template: sprint name, date, agents spawned, total time, merge conflicts (count + files), test results (before/after), lessons learned. Called automatically at end of `board sprint` or standalone.
**Effort:** S
**Depends on:** Nothing

### Agency-agents format compatibility (P2)
**What:** Support importing identity files from the [agency-agents](https://github.com/msitarzewski/agency-agents) repo format (markdown with YAML frontmatter: name, description, emoji, vibe). `board identity import <path-or-url>` pulls them into the identities/ folder.
**Why:** Instant library of 120+ curated agent identities for free. Good ecosystem play — don't reinvent what already exists.
**Context:** The agency-agents format uses YAML frontmatter (name, description, color, emoji, vibe) + markdown body with sections for identity, philosophy, rules, processes, success criteria. Our import command reads these and copies/converts into our identities/ folder.
**Effort:** S
**Depends on:** Nothing

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
**Depends on:** Sprint loop (complete)

### Web dashboard DAG visualization (P3)
**What:** Add a DAG tree/graph view to the web dashboard showing commit ancestry, leaves, and agent activity.
**Why:** The dashboard currently shows feed/agents/channels but has zero DAG visibility. The CEO needs to see exploration progress visually.
**Context:** The `/data/dag` endpoint already returns `DagSummary`. A new panel or tab could render this as an interactive tree or graph. Start simple (list of leaves with agent badges) and evolve to full DAG graph.
**Effort:** M
**Depends on:** Git DAG layer (complete)

### Multi-researcher orchestration (P3)
**What:** Run multiple researchers in parallel on different presets, then merge the best results. E.g., one researcher optimizing test count while another minimizes LOC — both constrained by tests passing.
**Why:** Different optimization targets can conflict (more tests = more code). Running them in parallel on separate branches and merging non-conflicting wins is more productive than sequential sessions.
**Context:** Each researcher already runs in its own worktree/branch via `--tag`. The missing piece is a coordinator that compares results across sessions and merges compatible improvements.
**Effort:** L
**Depends on:** Auto-research system (complete)
