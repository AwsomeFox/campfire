# Quality, review, and landing gates

## Implementation bar

- Satisfy the issue's documented acceptance criteria without adjacent features.
- Follow `AGENTS.md` and the nearest repository instructions.
- Add regression tests for defects and appropriate tests for new behavior.
- Run targeted checks first, then every aggregate check affected by the diff.
- Self-review the complete diff for correctness, security, authorization,
  secrecy, API/MCP drift, migration compatibility, dead code, and scope.
- Keep commits logical and the PR title/body accurate.

For L or XL changes, use a checked-in or workpad execution plan covering module
boundaries, compatibility, migration, failure behavior, rollback, and staged
delivery. Split oversized work into dependency-ordered, independently useful PRs.

## CI loop

After every push:

1. Monitor checks for the latest head until terminal.
2. Treat checks cancelled by a newer push as superseded.
3. Inspect complete logs for every failure.
4. Fix branch-caused failures and rerun affected validation.
5. Rerun a credible flaky or infrastructure failure once.
6. Do not repeatedly rerun an unexplained failure.
7. Record exact commands and results in the workpad.

Any code change invalidates affected earlier validation.

## Review loop

Refresh top-level reviews, inline comments, and unresolved threads after every
push and before landing.

For each substantive human or review-bot comment:

1. Classify it as actionable, question, obsolete, or technically disputed.
2. Implement actionable feedback and validate it.
3. Reply individually with what changed or why no change is appropriate.
4. Include the relevant commit or file and validation evidence.
5. Resolve the thread only after the reply is posted and the fix is pushed or
   the concern is conclusively answered.

Do not silently dismiss continuing legitimate disagreement. Re-request review
at most once per new head SHA. Ignore pure status notifications and duplicate
automated summaries as review findings.

## MERGE_READY gate

Verify directly that:

- acceptance criteria are complete;
- the latest commit is pushed and current with the base;
- required checks are green for that commit;
- required independent approval or Codex review is complete;
- no requested-changes review remains;
- every substantive review comment has an individual response;
- every legitimately resolvable thread is resolved;
- the final diff contains no unrelated feature or cleanup;
- tests, documentation, and workpad match the final implementation.

The implementing worker's self-review is not independent approval.

## Serialized landing

Immediately before each merge:

1. Refresh the base, checks, reviews, and thread state.
2. Update the branch when needed.
3. Wait for checks invalidated by that update.
4. Reapply the full MERGE_READY gate.
5. Merge with the repository's normal method.
6. Confirm the linked issue closed only when fully resolved.
7. Wait for required base-branch CI before starting another merge.

If base CI fails, stop the queue and return the regression to the owning worker.
Repair or revert through the normal reviewed workflow.
Do not release the owner or remove its worktree until required base CI succeeds.

## Blocking

Mark BLOCKED only for missing required credentials, permissions, external-system
changes, or product decisions that repository evidence cannot resolve.

Before blocking:

1. Exhaust documented in-scope fallbacks.
2. Verify the blocker directly.
3. Record the exact error, impact, and unblock action.
4. Preserve the branch and workspace.

After three attempts stopped by the same external condition, mark BLOCKED and
release the worker. Difficulty, size, slow CI, and uncertainty that can be
investigated are not blockers.
