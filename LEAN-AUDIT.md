# Codebase Lean Audit

_Generated: 2026-03-16_
_Files analyzed: 33 source files + 16 frontend files + 10 test files_
_Total source lines: ~6,900 (src/ non-test) + ~3,800 (tests) + ~2,300 (frontend) + ~860 (CSS) = ~13,860_

## Executive Summary

- **cli.ts is 2,167 lines** — the single largest file by far, doing CLI parsing, server management, rendering, and orchestration all in one. It should be split into at least 3 files.
- **server.ts duplicates sprint-start logic** from sprint-orchestrator.ts (lines 812-888) — a full copy-paste reimplementation of `startSprint()` that should call the shared function.
- **Server auto-start logic is duplicated 3 times** across mcp.ts, interactive.ts, and cli.ts — same spawn-server-in-background code.
- **11 exports are dead code** (never imported outside their own file/test) — immediate removals totaling ~120 lines.
- **3 duration/time formatting functions** are reimplemented independently in render.ts, sprint-orchestrator.ts, and two frontend components.

## 1. Dead Code (remove immediately)

| File | Export | Reason | Lines saved |
|------|--------|--------|-------------|
| `src/auth.ts` | `revokeKey()` | Only used in test files (db.test.ts, server.test.ts), never in production code | ~7 |
| `src/commits.ts` | `listCommitsByPost()` | Only used in db.test.ts | ~5 |
| `src/commits.ts` | `getCommit()` | Only used internally + db.test.ts, never from other production files | ~4 |
| `src/ratelimit.ts` | `resetRateLimits()` | Only used in test files | ~3 |
| `src/supervision.ts` | `getChannelPriority()` | Only used in db.test.ts, never in production code | ~6 |
| `src/supervision.ts` | `getCursor()` / `setCursor()` | Only used internally by `getBriefing()` and in db.test.ts — could be unexported | ~0 (just unexport) |
| `src/gitdag.ts` | `getDagCommit()` | Only used internally by `getLineage()` + test file | ~3 |
| `src/gitdag.ts` | `getLineage()` | Only used in gitdag.test.ts, never in production | ~16 |
| `src/routes.ts` | `listRoutesByTeam()` | Only used in m2.test.ts — it's a trivial wrapper around `listRoutes()` | ~5 |
| `src/routes.ts` | `getRoute()` | Only used internally + m2.test.ts | ~3 |
| `src/teams.ts` | `listMembers()` | Only used in m2.test.ts, never in production | ~5 |
| `src/teams.ts` | unused `randomUUID` import | Imported but never used (teams don't have UUIDs) | ~1 |
| `src/spawner.ts` | `isClaudeProcess()` | Only used internally by `killAgent()` — should be unexported | ~0 |
| `src/types.ts` | `Cursor` interface | Only imported in supervision.ts where it's used internally | ~0 (just unexport) |
| `src/types.ts` | `SprintValidation` interface | Only imported in cli.ts as a type but never instantiated — `PreFlightResult` replaced it | ~7 |
| `src/server.ts` | `LogSubscription`, `WsClient` interfaces | Exported but never imported anywhere else | ~0 (just unexport) |

**Estimated total: ~65 lines removable, ~10 exports to unexport**

## 2. Duplicate Logic (consolidate)

| Pattern | Files | Suggested Consolidation | Lines saved |
|---------|-------|------------------------|-------------|
| **Sprint start logic** | `server.ts` (lines 812-888) duplicates `sprint-orchestrator.ts:startSprint()` | server.ts `/data/sprint/start` handler should call `startSprint()` from sprint-orchestrator.ts instead of reimplementing agent creation, key gen, spawn, and rollback | ~70 |
| **Server auto-start** | `mcp.ts` (lines 66-109), `interactive.ts` (lines 60-142), `cli.ts` (board serve auto-start) | Extract into `boardrc.ts`: `ensureServerRunning(rc): Promise<BoardRC>` — all three do the same fetch-test, spawn-server, wait-for-ready loop | ~80 |
| **Duration formatting** | `render.ts:formatDuration()`, `sprint-orchestrator.ts:formatRuntime()` | Identical logic (parse ISO dates, compute diff, format as "Xh Ym"). Consolidate to one shared function | ~12 |
| **`elapsed()` in frontend** | `ActionBar.tsx:elapsed()`, `Sidebar.tsx:elapsed()` | Identical function duplicated across two components | ~8 |
| **`uniqueSprintName()`** | `sprint-orchestrator.ts` (goal-based slugify), `server.ts` (date-based random) | Two completely different implementations with the same name. server.ts should use the sprint-orchestrator version | ~8 |
| **Dynamic SQL builder pattern** | `agents.ts:listAgents()`, `posts.ts:listPosts()`, `supervision.ts:getFeed()`, `gitdag.ts:listDagCommits()`, `teams.ts:listTeams()`, `routes.ts:listRoutes()` | All use identical `WHERE 1=1` + conditional append pattern. A tiny `buildQuery()` helper would reduce boilerplate | ~30 |
| **Channel normalize pattern** | `posts.ts` (inline), `channels.ts:normalizeChannel()`, `supervision.ts` (inline) | Channel name normalization (#-prefix) is done inline in multiple places. Use a shared `normalizeChannel()` | ~10 |
| **Agent normalize inline** | `posts.ts` (line 23, inline @-prefix), `agents.ts:normalizeHandle()` | `posts.ts:createPost()` does its own @-prefix normalization instead of calling `normalizeHandle()` | ~2 |

**Estimated total: ~220 lines consolidatable**

## 3. Unused Dependencies (remove from package.json)

### Backend (`package.json`)

| Dependency | Status | Evidence |
|-----------|--------|----------|
| `uuid` | **Replace with `crypto.randomUUID()`** | Only used once in `posts.ts` as `v4 as uuid`. Node 19+ has `crypto.randomUUID()` built in (already used in `routes.ts`). Removes a dependency entirely. |
| All others | Used | `better-sqlite3`, `commander`, `hono`, `@hono/node-server`, `ws`, `@modelcontextprotocol/sdk` are all used in production code |

### Frontend (`frontend/package.json`)

| Dependency | Status | Evidence |
|-----------|--------|----------|
| All deps | Used | `react`, `react-dom` are core. Dev deps are all active (vite, vitest, testing-library, typescript) |

**Action: Remove `uuid` from backend dependencies, replace with `crypto.randomUUID()`**

## 4. Oversized Files (candidates for splitting)

| File | Lines | Suggestion |
|------|-------|------------|
| `src/cli.ts` | 2,167 | **Critical.** Split into: (1) `cli-commands.ts` — individual command handlers, (2) `cli-server.ts` — serve command + server management, (3) `cli.ts` — just the commander program definition + routing. Most functions are self-contained. |
| `src/server.ts` | 1,035 | Split into: (1) `server-routes.ts` — API routes, (2) `server-data.ts` — /data/* routes, (3) `server-ws.ts` — WebSocket streaming, (4) `server.ts` — createApp assembly. The `buildSprintState()` helper + numstat cache are independent modules. |
| `src/render.ts` | 730 | Tolerable but could split: (1) `render-core.ts` — colors, basic post/agent rendering, (2) `render-sprint.ts` — sprint report/landing/portfolio, (3) `render-dag.ts` — DAG tree/log/summary. |
| `src/spawner.ts` | 690 | Split: (1) `worktree.ts` — createWorktree, removeWorktree, installScopeHook, (2) `directives.ts` — writeDirective, clearDirectives, (3) `spawner.ts` — core spawn/kill/merge + DB ops. |
| `src/interactive.ts` | 670 | Reasonable size for a REPL but action functions could be extracted. |
| `src/sprint-orchestrator.ts` | 582 | Fine as-is. |
| `src/frontend/src/styles/index.css` | 861 | Single CSS file for entire frontend. Consider splitting by component if it grows further. |

### Oversized Functions (>50 lines)

| File | Function | Lines | Notes |
|------|----------|-------|-------|
| `spawner.ts` | `_spawnProcess()` | ~100 | Worktree + CLAUDE.md + subprocess + DB + exit handler. Could extract CLAUDE.md gen. |
| `spawner.ts` | `generateAgentClaudeMd()` | ~60 | Template string builder — acceptable but long |
| `spawner.ts` | `installScopeHook()` | ~60 | Mostly a bash script template — acceptable |
| `spawner.ts` | `mergeAgent()` | ~65 | Multiple git operations — could be tighter |
| `sprint-orchestrator.ts` | `buildSprintReport()` | ~90 | Heavy DB queries + stat gathering. Could extract agent-report-building into a helper. |
| `sprint-orchestrator.ts` | `buildLandingBrief()` | ~90 | Very similar to `buildSprintReport()` — high overlap |
| `render.ts` | `renderDagTree()` | ~50 | Tree-rendering with recursion — inherently complex |
| `server.ts` | `buildSprintState()` | ~50 | Could be shared with sprint-orchestrator |
| `server.ts` | `/data/sprint/start` handler | ~75 | Copy of startSprint() — should be deleted |

## 5. Redundant Abstractions (simplify)

1. **`listRoutesByTeam()` in routes.ts** — A one-liner wrapper: `return listRoutes(db, { team_name: teamName, status: opts?.status })`. Just call `listRoutes()` directly. Only used in tests.

2. **`withDb()` in db.ts** — Exported helper that opens DB, runs fn, closes. But the codebase never uses it in production (only in coverage.test.ts). The pattern everywhere is `getDb()` + manual close. Either use it consistently or remove it.

3. **`safeJsonParse()` export from agents.ts** — Used by posts.ts and supervision.ts. It's fine as a shared utility, but it's oddly placed in the agents module. Could live in a `utils.ts` or just be inlined (it's 5 lines).

4. **`SprintValidation` vs `PreFlightResult`** — `SprintValidation` in types.ts is nearly identical to `PreFlightResult` in sprint-orchestrator.ts. `SprintValidation` appears only as a type import in cli.ts but is never actually instantiated. `PreFlightResult` is the one used. Remove `SprintValidation`.

5. **`buildSprintReport()` vs `buildLandingBrief()`** — These two functions in sprint-orchestrator.ts share ~70% of their code (query sprint, query agents, query spawns, get stats, parse reports). They should share a core `gatherSprintData()` function and diverge only in final assembly.

6. **`Executor` type in both decomposer.ts and spawner.ts** — Two different `Executor` types with different signatures. Confusing but not consolidatable since they serve different purposes (exec vs spawn). Consider renaming one.

## 6. Frontend Optimization

### Component Issues

1. **`LandingBrief.tsx` fetches from `/api/sprint/:name/brief`** but the API endpoint is actually `/data/sprint/:name/brief`. The component may be broken (wrong URL prefix).

2. **`SprintLauncher.tsx` fetches from `/api/sprint/suggest` and `/api/sprint/start`** but the actual endpoints are `/data/sprint/suggest` and `/data/sprint/start`. Same issue — likely broken.

3. **`LogsPanel.tsx` fetches from `/api/logs/:handle`** but the actual endpoint is `/data/logs/:handle`. Broken.

4. **`FeedPanel.tsx` fetches from `/api/feed`** — this one actually exists behind auth middleware. It would fail without auth headers. The unauthed version is `/data/feed`.

5. **`App.tsx` fetches sprint state from `/api/feed`** (line 27) which returns posts, not sprint state. Should be `/data/sprint/latest`.

### Type Mismatch

- `frontend/src/types.ts:SprintTask.scope` is typed as `string` but the backend sends `string[]`. Type mismatch.

### Duplicate `elapsed()` Function
- Identical in both `ActionBar.tsx` and `Sidebar.tsx`. Extract to a shared `utils.ts`.

### CSS
- The 861-line CSS file is monolithic but well-organized. No obvious unused styles found since every class maps to a component. Could eventually adopt CSS modules.

### No heavy dependencies
- Frontend only uses react and react-dom. Very lean already.

## 7. Test Cleanup

| File | Lines | Notes |
|------|-------|-------|
| `sprint.test.ts` | 1,999 | Largest test file. Tests sprint orchestration, decomposer, identities, and CEO amplification. Could be split by concern. |
| `server.test.ts` | 1,332 | Comprehensive but monolithic. Tests all API endpoints in one file. |
| `m2.test.ts` | 1,144 | Tests teams, routes, and org rendering. Well-scoped. |
| `db.test.ts` | 1,064 | Tests foundation + supervision data layer. Well-scoped. |
| `spawner.test.ts` | 741 | Uses DI for mocking. Well-designed. |
| `gitdag.test.ts` | 621 | Good coverage. |
| `render.test.ts` | 477 | Tests render functions. |
| `decomposer.test.ts` | 446 | Tests decomposition. |
| `bucket-engine.test.ts` | 343 | Good isolation with mock GitOps. |
| `coverage.test.ts` | 224 | Explicitly tests previously-untested exports (withDb, insertSpawn, updateSpawn, renderOrg). **This file exists solely to boost coverage** — the tested functions should have coverage from their natural callers. |

### Specific Issues

1. **coverage.test.ts is a coverage hack** — Tests `withDb`, `insertSpawn`, `updateSpawn`, `renderOrg` in isolation just because they lacked coverage. If these functions were used properly elsewhere (or removed as dead code), this file could be deleted entirely. (~224 lines)

2. **sprint.test.ts tests too many concerns** — Has decomposer tests, identity tests, sprint orchestration tests, and CEO amplification tests in one file. Split into separate files by module.

3. **Test setup duplication** — Every test file creates its own temp dir and initializes a DB with nearly identical boilerplate. A shared `test-helpers.ts` with `setupTestDb()` would reduce ~15 lines per test file across 10 files (~150 lines total).

## 8. Quick Wins (< 5 min each)

1. **Remove `randomUUID` import from teams.ts** — Imported but never used (teams use string PKs, not UUIDs).

2. **Remove `uuid` npm dependency** — Replace the one usage in posts.ts with `crypto.randomUUID()` (already used in routes.ts).

3. **Unexport `LogSubscription`, `WsClient`** from server.ts — Only used internally.

4. **Unexport `getCursor`, `setCursor`** from supervision.ts — Only used internally by `getBriefing()`.

5. **Remove `SprintValidation` type** from types.ts — Superseded by `PreFlightResult`.

6. **Delete `listRoutesByTeam()`** from routes.ts — Trivial wrapper, only used in tests.

7. **Fix frontend API endpoint paths** — LandingBrief, SprintLauncher, LogsPanel use `/api/` prefix but should use `/data/` for unauthenticated endpoints.

8. **Extract `elapsed()` in frontend** — Move from ActionBar.tsx and Sidebar.tsx to a shared `frontend/src/utils.ts`.

9. **Replace server.ts local `uniqueSprintName()`** with import from sprint-orchestrator.ts.

10. **Unexport `isClaudeProcess()`** from spawner.ts — Only used internally.

## 9. Bigger Refactors (worth considering)

1. **Split cli.ts (~2,167 lines) into 3-4 files** — Estimated effort: 1-2 hours. Biggest single improvement to maintainability. Split by: (a) commander program definition + routing, (b) individual command action handlers, (c) serve command + server management.

2. **Consolidate server auto-start into boardrc.ts** — Estimated effort: 30 min. mcp.ts and interactive.ts both have ~40 lines of identical server-start code. Extract `ensureServerRunning()`.

3. **Replace server.ts sprint-start handler with `startSprint()` call** — Estimated effort: 20 min. Lines 812-888 of server.ts are a direct copy of sprint-orchestrator.ts logic. Call the shared function instead.

4. **Merge `buildSprintReport()` and `buildLandingBrief()` shared core** — Estimated effort: 30 min. Extract `gatherSprintAgentData()` that both functions call, reducing ~60 lines of duplication.

5. **Split server.ts into route modules** — Estimated effort: 1 hour. Foundation routes, supervision routes, DAG routes, sprint data routes, and WebSocket streaming each become their own file.

6. **Split render.ts by domain** — Estimated effort: 30 min. Core rendering, sprint rendering, DAG rendering, org rendering.

7. **Create shared test setup** — Estimated effort: 30 min. Extract DB init + temp dir creation into `test-helpers.ts`, saving ~150 lines across 10 test files.

8. **Delete coverage.test.ts** — Estimated effort: 5 min after dead code removal. If `withDb` is removed/unexported and spawn DB ops are properly tested via spawner tests, this file serves no purpose.

## Line Count Impact

| Category | Lines removable |
|----------|----------------|
| Dead code removal | ~65 |
| Duplicate sprint-start in server.ts | ~70 |
| Duplicate server auto-start consolidation | ~80 |
| Duplicate duration formatting | ~20 |
| `coverage.test.ts` deletion (post-cleanup) | ~224 |
| Shared test setup extraction | ~150 |
| Frontend elapsed() dedup | ~8 |
| `SprintValidation` type + `listRoutesByTeam` | ~12 |
| **Total removable** | **~630 lines** |

Additionally, splitting cli.ts and server.ts wouldn't reduce lines but would dramatically improve navigability and reduce cognitive load. The codebase is reasonably lean for its feature set — the biggest wins are in deduplication and file organization rather than wholesale feature removal.
