#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# auto-lean.sh — Karpathy-style hill-climbing code optimizer
#
# The outer loop is dumb: measure → ask Claude for a hypothesis → apply →
# test → keep if improved, revert if not → log → repeat forever.
#
# Usage:
#   chmod +x auto-lean.sh
#   ./auto-lean.sh              # run forever
#   ./auto-lean.sh --cycles 5   # run N cycles then stop
# ============================================================================

BRANCH="auto-lean"
MAX_CYCLES="${1:---cycles}"
if [[ "$MAX_CYCLES" == "--cycles" ]]; then
  MAX_CYCLES="${2:-0}"  # 0 = infinite
fi

LOG_FILE="LEAN-STATE.md"
METRIC_CMD='wc -l $(ls src/*.ts | grep -v test) 2>/dev/null | grep total | awk "{print \$1}"'

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $1"; }
ok()  { echo -e "${GREEN}[$(date +%H:%M:%S)] ✓${NC} $1"; }
err() { echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $1"; }
warn(){ echo -e "${YELLOW}[$(date +%H:%M:%S)] ⚠${NC} $1"; }

# ── Preflight ────────────────────────────────────────────────────────────────

current_branch=$(git branch --show-current)
if [[ "$current_branch" != "$BRANCH" ]]; then
  err "Must be on branch '$BRANCH' (currently on '$current_branch')"
  exit 1
fi

if ! command -v claude &>/dev/null; then
  err "claude CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  err "Uncommitted changes detected. Commit or stash first."
  exit 1
fi

measure() {
  eval "$METRIC_CMD"
}

run_tests() {
  npm test 2>&1
}

# ── The Prompt ───────────────────────────────────────────────────────────────

SYSTEM_PROMPT='You are a code optimizer for a TypeScript project. Your ONLY job: find ONE concrete way to reduce line count in src/*.ts (non-test files) without breaking functionality.

Rules:
- Make exactly ONE change per cycle
- The change must reduce total non-test line count
- All existing tests (npm test) must still pass after your change
- Do NOT touch test files unless removing tests for deleted code
- Do NOT touch frontend/ directory
- Do NOT add new files — only edit or delete existing ones
- Prefer: removing dead code, deduplicating logic, removing unused exports/imports, consolidating similar functions
- Do NOT refactor for style — only reduce lines while preserving behavior

Output format — you MUST output ONLY a git patch (unified diff) that can be applied with `git apply`. No explanation, no markdown fences, just the raw patch. If you cannot find anything to remove, output exactly: NOTHING_FOUND'

# ── Main Loop ────────────────────────────────────────────────────────────────

cycle=0
consecutive_failures=0

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║       auto-lean: Karpathy-style hill climber        ║"
echo "║                                                     ║"
echo "║  Branch: $BRANCH                               ║"
echo "║  Metric: non-test src/ line count (lower = better)  ║"
echo "║  Press Ctrl+C to stop                               ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

while true; do
  cycle=$((cycle + 1))

  if [[ "$MAX_CYCLES" -gt 0 && "$cycle" -gt "$MAX_CYCLES" ]]; then
    ok "Completed $MAX_CYCLES cycles. Stopping."
    break
  fi

  echo ""
  log "━━━ Cycle $cycle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # 1. Measure baseline
  lines_before=$(measure)
  log "Current: ${lines_before} lines"

  # 2. Build context for Claude — recent git log + file listing
  recent_log=$(git log --oneline -10)
  file_sizes=$(wc -l src/*.ts 2>/dev/null | grep -v test | sort -rn | head -20)

  context="Recent experiments (avoid redoing these):
${recent_log}

Largest non-test files:
${file_sizes}

Current total: ${lines_before} lines.
Find ONE thing to remove or deduplicate. Output ONLY the git patch."

  # 3. Ask Claude for a hypothesis + patch
  log "Asking Claude for hypothesis..."
  patch_output=$(claude --print --model sonnet -s "$SYSTEM_PROMPT" "$context" 2>/dev/null) || {
    err "Claude call failed. Retrying in 30s..."
    sleep 30
    continue
  }

  # 4. Check if Claude found anything
  if [[ "$patch_output" == *"NOTHING_FOUND"* ]]; then
    warn "Claude found nothing to optimize. Trying again with fresh eyes in 60s..."
    consecutive_failures=$((consecutive_failures + 1))
    if [[ "$consecutive_failures" -ge 5 ]]; then
      ok "5 consecutive NOTHING_FOUND — codebase is likely optimized. Stopping."
      break
    fi
    sleep 60
    continue
  fi

  consecutive_failures=0

  # 5. Try to apply the patch
  log "Applying patch..."
  echo "$patch_output" > /tmp/auto-lean-patch.diff

  if ! git apply /tmp/auto-lean-patch.diff 2>/dev/null; then
    # Try stripping markdown fences if Claude wrapped it
    cleaned=$(echo "$patch_output" | sed '/^```/d')
    echo "$cleaned" > /tmp/auto-lean-patch.diff
    if ! git apply /tmp/auto-lean-patch.diff 2>/dev/null; then
      err "Patch failed to apply. Skipping."
      continue
    fi
  fi

  # 6. Run tests
  log "Running tests..."
  test_output=$(run_tests 2>&1)
  test_exit=$?

  if echo "$test_output" | grep -q "fail [1-9]"; then
    test_exit=1
  fi

  if [[ $test_exit -ne 0 ]]; then
    err "Tests failed. Reverting."
    git checkout -- .
    git clean -fd src/ 2>/dev/null || true

    # Log the failure
    echo "| $cycle | (tests failed) | reverted | $lines_before | - | FAIL | reverted | ❌ |" >> /tmp/auto-lean-results.log
    continue
  fi

  # 7. Measure result
  lines_after=$(measure)
  delta=$((lines_before - lines_after))

  if [[ "$delta" -le 0 ]]; then
    warn "No improvement ($lines_before → $lines_after). Reverting."
    git checkout -- .
    git clean -fd src/ 2>/dev/null || true

    echo "| $cycle | (no improvement) | reverted | $lines_before | $lines_after | PASS | +$((delta * -1)) | ❌ |" >> /tmp/auto-lean-results.log
    continue
  fi

  # 8. SUCCESS — commit and keep
  ok "Improvement: ${lines_before} → ${lines_after} (-${delta} lines)"

  git add -A
  git commit -m "experiment: auto-lean cycle $cycle (-${delta} lines, ${lines_after} total)" --no-verify

  echo "| $cycle | auto | applied | $lines_before | $lines_after | PASS | -${delta} | ✅ |" >> /tmp/auto-lean-results.log

  ok "Committed. Branch advanced."

  # Brief pause between cycles
  sleep 5
done

echo ""
echo "═══════════════════════════════════════════════════════"
log "Auto-lean complete. $cycle cycles run."
log "Results logged to /tmp/auto-lean-results.log"
log "Review: git log --oneline auto-lean"
echo "═══════════════════════════════════════════════════════"
