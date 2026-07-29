---
name: gh-deliver-backlog
description: Orchestrate unattended GitHub backlog delivery with four gpt-5.6-terra workers by draining existing pull requests, implementing issues by priority, handling CI and review feedback, replying to and resolving review threads, serializing merges, and reporting external blockers. Use when Codex is asked to process multiple GitHub PRs or issues end to end, clear a repository backlog, or autonomously deliver a prioritized issue queue.
---

# Deliver GitHub Backlog

## Establish the run

Act as the coordinator. Keep implementation out of the primary thread. Use the
primary for queue ownership, dispatch, reconciliation, review gates, and landing.

Before dispatching work:

1. Read the root `AGENTS.md` and applicable repository instructions.
2. Read
   [agent-claim-protocol.md](../../references/agent-claim-protocol.md),
   [queue-state.md](references/queue-state.md), and
   [quality-gates.md](references/quality-gates.md) completely.
3. Verify repository identity and GitHub access.
4. Fetch the remote base and inventory the shared checkout, branches, worktrees,
   `agent:*` labels, and all current or legacy workpad claims. Never modify or
   clean a shared dirty checkout.
   Create dedicated coordinator and worker worktrees from the current remote base
   and reserve existing branches/worktrees before making new ones.
5. Record a cutoff timestamp and inventory every open PR and issue.
6. Map PRs to issues, priorities, complexities, dependencies, branch
   writability, checks, reviews, and unresolved threads.
7. Detect duplicates before assigning any implementation.

Treat the snapshot as the finite run scope. Admit new P0/P1 issues discovered
during the run; leave new P2/P3 issues for the next run.

## Dispatch four workers

Maintain a logical pool of four `issue_worker` subagents using their fixed
`gpt-5.6-terra` and `high` configuration. Run all four concurrently when the
runtime has four spawned-agent slots; otherwise schedule the same four-worker
pool within the available capacity. Give each worker one item, one unique branch,
and one isolated worktree.

Include in every assignment:

- issue or PR number and URL;
- priority, complexity, dependencies, and acceptance criteria;
- existing branch, PR, CI, and review state;
- worktree and branch;
- relevant architecture constraints and required validation;
- instruction to retain ownership until merge or true external blocking.

For each item, acquire the shared lease as tool `codex` and verify that it still
wins immediately before dispatch. Do not create an implementation branch or
worktree first. Record the winning comment ID and run ID in the assignment.
Never let two workers touch the same item, branch, or worktree. Do not give a
waiting worker another item.

## Drive each item

Require every worker to maintain exactly one `## Agent Workpad` comment using the
template in [queue-state.md](references/queue-state.md). On retry or continuation,
resume from the workpad and existing workspace instead of restarting.

The coordinator owns lease acquisition, renewal, and release. Renew during long
CI and review waits and before merge. A worker that reports a lost or conflicting
claim must stop without touching implementation state.

For existing PRs, inspect the complete diff, linked issue, checks, reviews, and
threads before changing code. Push to an external contributor branch only when
GitHub explicitly permits maintainer edits; otherwise use a linked replacement
PR only when necessary.

For new issues, implement the smallest coherent solution and open one focused PR
with the normal closing reference. File out-of-scope discoveries separately;
do not expand the current PR or add the follow-up to this run unless it is P0/P1.

Prefer the connected GitHub tools for issue and PR reads/writes, review threads,
replies, resolution, checks, and merges. Use local Git for commits and pushes.
Do not assume the standalone `gh` CLI is authenticated.

Use the installed GitHub workflows when their prerequisites are available:

- `github:gh-fix-ci` for failing GitHub Actions checks;
- `github:gh-address-comments` for review threads and inline feedback;
- `github:yeet` for intentional commit, push, and PR publication.

Keep workers active through the check-address-verify loop and required
post-merge base CI. A worker is done only when the item is stably MERGED or
BLOCKED under the referenced policy.

## Land serially

Allow parallel implementation but only one repository-wide merge in flight.
Acquire and verify the shared merge lease immediately before landing, re-read
the PR state, and apply every gate in
[quality-gates.md](references/quality-gates.md).

After merging, wait for required base-branch CI. Stop the merge queue if it
fails, return the regression to the owning worker, and resume only after the
base branch is healthy. Hold and renew the repository-wide merge lease through
that exact terminal-green base run, including any repair or revert; only then
release it. Refresh all other active branches after each merge.

## Reconcile and finish

Use bounded retries with increasing delay for transient failures. Treat timeouts
or worker silence as inconclusive; inspect actual state before interrupting or
duplicating work.

Continue until every in-scope item is merged, explicitly excluded by existing
terminal labels, conclusively duplicate or obsolete, or externally blocked.
Perform a fresh GitHub scan before stopping.

Return a compact report grouped by priority:

- merged PRs and resolved issues;
- duplicate, obsolete, or excluded items with evidence;
- blocked items and exact unblock requirements;
- new out-of-scope issues;
- base-branch CI status;
- recurring maintainability problems and proposed durable guardrails;
- features or refactors intentionally rejected as unnecessary scope.
