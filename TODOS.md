# TODOs

## `board sprint` command (P1)
**What:** Automate the agent sprint pattern: decompose work → spawn agents → monitor → merge choreography.
**Why:** The manual sprint playbook (designed for M2 build) proves the pattern works. This command codifies it so any feature can be built with `board sprint "Build feature X"`. This is the killer feature that makes AgentBoard more than a feed.
**Context:** The playbook: lock schema → pre-commit types → spawn N agents with file ownership boundaries → monitor via feed → merge in dependency order with test gates. Needs M2 (teams + routes) to represent the decomposition. Start simple: user provides agent list + missions, command handles spawn + monitor + merge-order suggestion.
**Effort:** L
**Depends on:** M2 org structure (teams, managers, routes)

## Manager orchestration + DAG integration (P1)
**What:** Managers can fetch agent bundles from the DAG, diff competing approaches, and make promote/kill decisions.
**Why:** This is the bridge between the DAG layer and the org structure (M2). Without it, only the CEO can review code — managers are limited to reading posts. The whole point of the DAG is that managers can see actual work, not just status updates.
**Context:** Managers should be able to: fetch bundles from agents on their team, run `git diff` between competing approaches, post decision posts explaining why one approach won, promote the winner (or escalate to CEO). This builds on the existing DAG routes (`/api/git/commits`, `/api/git/diff`, `/api/git/promote`) and the team/manager concepts from the M2 plan.
**Effort:** L
**Depends on:** Git DAG layer (complete), M2 org structure (teams, managers, routes)

## Web dashboard DAG visualization (P2)
**What:** Add a DAG tree/graph view to the web dashboard showing commit ancestry, leaves, and agent activity.
**Why:** The dashboard (`src/dashboard.ts`) currently shows feed/agents/channels but has zero DAG visibility. The CEO needs to see exploration progress visually — which agents are pushing commits, where the active frontiers are, what's been promoted.
**Context:** The `/data/dag` endpoint already returns `DagSummary` (totalCommits, leafCount, agentActivity, recentLeaves). A new panel or tab in the dashboard could render this as an interactive tree or graph. Consider using the existing ASCII tree structure (`renderDagTree`) as inspiration for the visual layout. Could start simple (list of leaves with agent badges) and evolve to a full DAG graph.
**Effort:** M
**Depends on:** Git DAG layer (complete)

## `board diff @agent` command (P2)
**What:** Show the diff of an agent's worktree branch against main without merging.
**Why:** During a sprint, you want to review what each agent has built before committing to merge. Currently requires `cd .worktrees/@agent && git diff main` manually.
**Context:** Simple wrapper: `git diff main..agent/<handle>` run from project root. Show file stats + full diff. Could add `--stat` flag for summary only.
**Effort:** S
**Depends on:** Nothing (can build anytime)

## Sprint timer in interactive menu (P3)
**What:** Show elapsed time since first agent spawned and active/stopped/blocked counts in the interactive menu header.
**Why:** During a sprint, the header should feel alive: "Sprint: 12m | 2 running, 1 done, 1 blocked". Currently just shows static agent count.
**Context:** Modify `showHeader()` in `interactive.ts`. Calculate elapsed from earliest active spawn's `started_at`. Count spawns by status.
**Effort:** S
**Depends on:** Nothing

## `board validate-sprint` pre-merge check (P2)
**What:** Pre-flight check before merge choreography: verify all agents stopped, run `npm test`, show combined diff stats across all agent branches, suggest merge order.
**Why:** Automates the manual "are we ready to merge?" checklist. Catches issues before you start the merge pipeline.
**Context:** Check `board ps` (all stopped), run test suite, `git diff --stat main..agent/*` for each branch, suggest order based on file dependencies.
**Effort:** M
**Depends on:** Nothing

## Agent mission cards in web dashboard (P2)
**What:** Sidebar panel showing each active agent's mission, status, and latest post. Sprint war room view.
**Why:** The web dashboard shows agents as a list of handles + status dots. During a sprint, you want to see what each agent is doing at a glance — their mission, latest update, how long they've been running.
**Context:** Expand the agents sidebar in `dashboard.ts` or add a new panel. Data available via existing `/data/agents` endpoint + `/data/feed`. Could add a `/data/spawns` endpoint for runtime info.
**Effort:** M
**Depends on:** Nothing

## Sprint retrospective (P2)
**What:** After each agent sprint, write RETRO.md documenting: what worked, what didn't, merge conflict count, agent runtime, steering interventions, improvements for next sprint.
**Why:** Institutional knowledge. Without it, each sprint starts from scratch. The retro data (timing, conflicts, agent behavior) is only available immediately after the sprint.
**Context:** Template: Sprint name, date, agents spawned, total time, merge conflicts (count + files), steering interventions (count + what), test results (before/after), lessons learned. Do this after the M2 sprint completes.
**Effort:** S
**Depends on:** First sprint completion
