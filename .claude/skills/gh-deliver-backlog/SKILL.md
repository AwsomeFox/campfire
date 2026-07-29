---
name: gh-deliver-backlog
description: Orchestrate unattended GitHub backlog delivery with an Opus 5 lead and up to four worktree-isolated Sonnet 5 issue workers. Drain existing pull requests, implement issues by priority, handle CI and review feedback, reply to and resolve review threads, serialize merges, and report external blockers. Invoke for end-to-end repository backlog delivery.
---

# Deliver GitHub Backlog

Act as the Opus coordinator. Keep implementation in `issue-worker` subagents and
keep queue ownership, reconciliation, merge decisions, and reporting here.

Read [agent-claim-protocol.md](../../../.agents/references/agent-claim-protocol.md),
[queue-state.md](references/queue-state.md), and
[quality-gates.md](references/quality-gates.md) completely before dispatch.
Treat `$ARGUMENTS` as an optional narrowing of scope, never an expansion.

## Establish the run

1. Read `CLAUDE.md`, its imported `AGENTS.md`, and applicable subtree guidance.
2. Verify repository identity, `gh` authentication, push access, and the remote
   base branch.
3. Fetch the remote and inventory open PRs, issues, `agent:*` labels, branches,
   worktrees, checks, reviews, review threads, and current or legacy workpads.
4. Never clean or modify an unrelated dirty checkout. Reserve occupied branches,
   worktrees, and nonterminal workpads.
5. Record a cutoff timestamp and create the authoritative task ledger.
6. Map PRs to issues, priorities, complexity, dependencies, ownership, and
   duplicate implementation before assigning work.

Treat the snapshot as the finite run. Admit only newly discovered P0/P1 items;
leave new P2/P3 work for a future run.

## Dispatch and supervise

Maintain at most four concurrent `issue-worker` subagents. Give each worker one
item with:

- issue or PR number and URL;
- priority, complexity, dependencies, and acceptance criteria;
- current branch, PR, checks, reviews, and unresolved threads;
- architecture constraints and required validation;
- instruction to retain ownership through merge readiness or a verified
  external blocker.

For each item, acquire the shared lease as tool `claude` and verify that it still
wins immediately before dispatch. Do not create an implementation branch or
worktree first. Include the winning comment ID and run ID in the assignment.
Never assign the same item, branch, or worktree twice. Backfill a runtime slot
after its worker reports `MERGE_READY` or `BLOCKED`, but retain the logical
owner, branch, and worktree through post-merge base CI. The coordinator owns
lease acquisition, renewal, release, and label cleanup. Do not delegate small
coordinator-only reads or verification.

For an existing PR, continue its writable branch when possible. If the branch
cannot be updated, preserve the original and create a linked replacement only
when necessary. For an issue without a PR, create one focused implementation.

Use `gh` for GitHub state, comments, review threads, checks, and merges. Use Git
for worktree and branch operations. Resume existing state after interruption;
do not restart completed investigation or validation.

## Land serially

Allow parallel implementation, but only one repository-wide merge may be in
flight. For each reported `MERGE_READY` item:

1. Acquire and verify the shared merge lease.
2. Independently refresh the exact head, base, diff, checks, reviews, comments,
   and unresolved threads.
3. Apply every gate in `quality-gates.md`.
4. Update the branch if required and wait for invalidated checks.
5. Merge with the repository's normal method.
6. Hold and renew the merge lease through terminal-green required base-branch
   CI, then release it.
7. If base CI fails, keep the repository-wide barrier active, pause the queue,
   and re-invoke the same logical owner with
   the failure logs on a repair branch from the failing base.

After every merge, refresh active branches and recompute dependency readiness.

## Finish

Use bounded retries with increasing delay for transient GitHub, CI, or worker
failures. Treat silence and timeouts as inconclusive until actual state is
inspected. Mark blocked only under the referenced blocking policy.

Continue until every in-scope item is merged, explicitly excluded, conclusively
duplicate or obsolete, or externally blocked. Perform a fresh GitHub scan before
stopping.

Return a concise report grouped by priority:

- merged PRs and resolved issues;
- excluded, duplicate, or obsolete items with evidence;
- blocked items and exact unblock actions;
- new out-of-scope issues;
- final base-branch CI;
- recurring maintainability risks;
- features or refactors intentionally rejected as unnecessary scope.
