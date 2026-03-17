# Auto-Researcher: Lean Codebase

_Branch: auto-lean (isolated — only advances on improvements)_
_Inspired by Karpathy's autoresearch: hill-climbing with git as memory._

## Metric
**Line count of src/ (non-test) with all tests passing.**
Lower is better. Branch only advances when: tests pass AND line count decreased.

## Baseline
8888 lines (pre-experiment, m2-platform-supervision merge point)

## Results Log
| cycle | hypothesis | action | lines_before | lines_after | tests | status | kept |
|-------|-----------|--------|-------------|------------|-------|--------|------|
| 1 | inline sprint-start handler duplicates startSprint() | replace 75-line handler with startSprint() call, remove local uniqueSprintName | 8888 | 8819 | 588 pass | -69 lines | ✅ |
| 2 | uuid dependency is unnecessary — crypto.randomUUID() is built-in | remove uuid + @types/uuid, use crypto.randomUUID() | 8819 | 8817 | 588 pass | -2 lines (+ removed dep) | ✅ |
| 3 | dead code: unused randomUUID import in teams.ts, listRoutesByTeam wrapper | remove import + 7-line wrapper, update tests | 8817 | 8808 | 588 pass | -9 lines | ✅ |
| 4 | ensureServerRunning duplicated in mcp.ts + interactive.ts | extract to boardrc.ts, both callers import | 8808 | 8759 | 588 pass | -49 lines | ✅ |
| 5 | formatRuntime in sprint-orchestrator duplicates formatDuration in render.ts | export formatDuration, alias in sprint-orchestrator | 8759 | 8748 | 588 pass | -11 lines | ✅ |
| 6 | unused path import in interactive.ts, internal-only exports | remove import, unexport isClaudeProcess + 2 interfaces | 8748 | 8710 | 588 pass | -38 lines | ✅ |

## Observations
- Biggest wins come from deduplication (exp 1: -69, exp 4: -49), not just dead code removal
- The codebase has grown organically — same logic copied into multiple files
- uuid removal was tiny line-wise (-2) but valuable for dependency hygiene
- Unexporting symbols (exp 6) catches more dead code downstream
- Total reduction so far: 178 lines (8888 → 8710), 2.0% leaner

## Active Questions
- cli.ts at 2167 lines — biggest structural target, but risky to refactor
- buildSprintReport / buildLandingBrief have overlapping logic — consolidate?
- withDb() helper in db.ts — is it used or dead?
- Frontend has 5 broken API paths (/api/ vs /data/) — separate concern but noted
