# Quality, review, and landing gates

## Implementation

- Meet documented acceptance criteria without adjacent features.
- Follow `CLAUDE.md`, imported `AGENTS.md`, and nearest subtree instructions.
- Add regression tests for defects and appropriate tests for new behavior.
- Run targeted checks first, then each aggregate check affected by the diff.
- Review correctness, security, authorization, secrecy, REST/MCP drift,
  migration compatibility, dead code, and scope.
- Keep commits logical and the PR title and body accurate.

For L or XL work, maintain a checked-in or workpad plan covering boundaries,
compatibility, migration, failure behavior, rollback, and staged delivery. Split
oversized work into dependency-ordered PRs that are independently useful.

## CI

After every push:

1. Monitor checks for the latest head until terminal.
2. Treat checks cancelled by a newer push as superseded.
3. Inspect complete logs for every failure.
4. Fix branch-caused failures and rerun affected validation.
5. Rerun a credible flaky or infrastructure failure once.
6. Do not repeatedly rerun an unexplained failure.
7. Record commands and results in the workpad.

Any code change invalidates affected earlier validation.

## Review

Refresh reviews, inline comments, and unresolved threads after every push and
immediately before landing.

For each substantive human or review-bot comment:

1. Classify it as actionable, question, obsolete, or technically disputed.
2. Implement actionable feedback and validate it.
3. Reply individually with what changed or why no change is appropriate.
4. Include the relevant commit or file and validation evidence.
5. Resolve only after the reply is posted and the fix is pushed or the concern
   is conclusively answered.

Do not silently dismiss continuing legitimate disagreement. Re-request review at
most once per new head SHA. Ignore pure status notifications and duplicate bot
summaries as findings.

## Merge-ready

Verify directly that:

- acceptance criteria are complete;
- the latest commit is pushed and current with base;
- required checks are green for that commit;
- every approval required by branch protection, rulesets, or requested-review
  policy is complete;
- no requested-changes review remains;
- every substantive comment has an individual response;
- every legitimately resolvable thread is resolved;
- the diff contains no unrelated feature or cleanup;
- tests, documentation, PR text, and workpad match the final code.

The implementing worker's self-review is not independent review. When repository
policy does not require approval from a distinct GitHub actor, the Opus
coordinator's fresh documented review satisfies this quality gate; do not invent
or impersonate a GitHub approval.

## Landing

Immediately before each merge:

1. Refresh base, checks, reviews, and threads.
2. Update the branch when required.
3. Wait for checks invalidated by that update.
4. Reapply every merge-ready gate.
5. Merge with the repository's normal method.
6. Confirm the linked issue closed only when fully resolved.
7. Wait for required base-branch CI before starting another merge.

If base CI fails, stop the queue and return the regression to its owner. Repair
or revert through the normal reviewed workflow. Retain the logical owner,
branch, and worktree until base CI passes. If the worker process has exited,
re-invoke the same `issue-worker` ownership with the failure logs on a repair
branch from the failing base.

## Blocking

Block only for missing required credentials or permissions, unavailable external
systems, or product decisions that repository evidence cannot resolve.

Before blocking:

1. Exhaust documented in-scope fallbacks.
2. Verify the blocker directly.
3. Record the exact error, impact, and unblock action.
4. Preserve the branch and worktree.

After three attempts stopped by the same external condition, mark `BLOCKED`.
Difficulty, size, slow CI, and investigable uncertainty are not blockers.
