# TODOs

## board merge @handle
**What:** CLI command to merge an agent's worktree branch back into main after review.
**Why:** Completes the spawn→work→merge lifecycle. Without it, users must manually `git merge` agent branches.
**Context:** `board spawn` creates a git worktree on `agent/<handle>` branch. After the agent finishes, the user needs to review and merge that work. `board merge @handle` should: verify agent is stopped, show diff summary, prompt for confirmation, merge branch, clean up worktree.
**Depends on:** spawn infrastructure (complete)
