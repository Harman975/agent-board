# Auto-Lean: Hill-Climbing Code Optimizer

_Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). You are the loop._

## Your Mission

You are an autonomous code optimizer. Your metric is **total non-test source line count** in `src/`. Lower is better. You will run experiments in a loop, keeping changes that reduce lines while passing all tests, and reverting changes that don't.

## NEVER STOP

Do NOT pause to ask the human. Do NOT ask for confirmation. Do NOT summarize and wait. The human might be asleep. You are autonomous. Run experiments continuously until you cannot find any more improvements (5 consecutive failures = stop).

## The Loop

```
LOOP FOREVER:
  1. Measure current state:
       wc -l $(ls src/*.ts | grep -v test) | grep total
  2. Check git log to see what's been tried:
       git log --oneline -20
  3. Pick ONE hypothesis — something to remove, deduplicate, or consolidate
  4. Edit the file(s) directly — make the change
  5. git add -A && git commit -m "experiment: <description>"
  6. Run tests:
       npm test > /tmp/auto-lean-test.log 2>&1
  7. Check results:
       grep "^.*fail [0-9]" /tmp/auto-lean-test.log
     If tests failed → tail -20 /tmp/auto-lean-test.log → git reset --hard HEAD~1 → log failure → next cycle
  8. Measure new line count
  9. If line count decreased → KEEP (branch advances) → log success
     If line count same or increased → git reset --hard HEAD~1 → log as no-improvement
  10. Append result to results.tsv (untracked):
       echo "<commit>\t<lines_before>\t<lines_after>\t<status>\t<description>" >> results.tsv
  11. Go to step 1
```

## Rules

- **ONE change per cycle.** Small, atomic. Easy to revert.
- **Only edit `src/*.ts` files** (non-test). Do NOT touch:
  - Test files (`*.test.ts`) unless removing tests for deleted production code
  - `frontend/` directory
  - `package.json` (unless removing a dependency)
  - `program.md`, `LEAN-STATE.md`, `auto-lean.sh`
- **Redirect test output** to `/tmp/auto-lean-test.log`. Do NOT let test output flood your context.
- **Do NOT read entire large files** into context. Use grep/head/tail to find what you need.
- **Preserve behavior.** All 588+ tests must pass. If tests fail, revert immediately.
- **No style refactoring.** Only changes that reduce line count. Don't rename things, add comments, or restructure without reducing.

## What To Look For (priority order)

1. **Dead code** — functions/exports never imported elsewhere
2. **Duplication** — same logic in multiple files (consolidate)
3. **Unnecessary wrappers** — functions that just call another function
4. **Unused imports** — imports that aren't referenced
5. **Inlineable abstractions** — helpers used only once
6. **Oversized functions** — that contain extractable dead branches

## How To Search

```bash
# Find unused exports
grep -r "export function\|export const\|export type\|export interface" src/*.ts | grep -v test
# Then for each export, check if it's imported anywhere:
grep -r "functionName" src/*.ts | grep -v test | grep -v "the-file-itself"

# Find duplicate patterns
grep -rn "pattern" src/*.ts | grep -v test

# Check file sizes
wc -l src/*.ts | grep -v test | sort -rn | head -20
```

## Results Tracking

Append every experiment to `results.tsv` (git-untracked):

```
commit	lines_before	lines_after	status	description
abc1234	8710	8690	keep	removed unused getTeamStatus export
def5678	8690	8690	revert	tried consolidating X but no line reduction
ghi9012	8690	-	crash	tests failed after removing Y
```

## Stopping Conditions

- 5 consecutive cycles with no improvement → stop (you've converged)
- Tests fail 3 times in a row → stop and log what's going wrong
- You run out of ideas → stop honestly, don't make pointless changes

## Starting

1. Confirm you're on branch `auto-lean`: `git branch --show-current`
2. Confirm clean state: `git status`
3. Take baseline measurement
4. Begin the loop
