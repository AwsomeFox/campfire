---
name: gh-deliver-backlog
description: Orchestrate unattended GitHub backlog delivery in ZCode with GLM-5.2 and up to four worktree-isolated general-purpose workers. Use to drain existing pull requests, implement issues by priority, handle CI and review feedback, resolve review threads, and merge the queue serially.
---

# Deliver GitHub Backlog

Act as the GLM-5.2 coordinator. Use Max thought level and Goal mode for the run.
Keep queue ownership, claim arbitration, reconciliation, merge decisions, and
reporting in the main agent.

Before dispatch, read root `AGENTS.md`,
[agent-claim-protocol.md](../../../.agents/references/agent-claim-protocol.md),
[queue-state.md](references/queue-state.md), and
[quality-gates.md](references/quality-gates.md) completely. Before invoking a
worker, also read and use
[worker-contract.md](references/worker-contract.md) verbatim as the binding
worker instructions. Treat the invocation text as optional narrowing, never an
expansion.

## Establish the finite queue

1. Verify repository identity, `gh` authentication, push access, and remote base.
2. Fetch the remote and inventory open PRs, issues, priority and complexity
   labels, dependencies, branches, worktrees, checks, reviews, threads,
   `agent:*` labels, and all current or legacy workpads.
3. Preserve dirty shared checkouts and reserve active branches, worktrees, and
   live claims.
4. Record a UTC cutoff. Drain the existing PR snapshot first, then issues by the
   referenced priority order. Admit only newly discovered P0/P1 work.
5. Detect duplicate implementations before claiming anything.

## Claim and dispatch

Acquire the shared lease as tool `zcode` before branch or worktree creation,
code edits, pushes, or worker dispatch. Immediately verify the winning comment
again before implementation begins. Skip any item owned by another live claim.

Use up to four built-in `general-purpose` subagents in parallel batches. ZCode
project custom subagents are not required. Assign each worker exactly one item,
one explicit branch, and one explicit isolated Git worktree. Include the winning
claim comment ID and run ID, URLs, priority, complexity, dependencies,
acceptance criteria, current PR/CI/review state, architectural constraints, and
validation commands.

The coordinator alone acquires, renews, releases, and arbitrates leases. Renew
at every material transition and around long waits. Workers never claim other
items and stop immediately if their assigned claim is no longer the winner.

## Drive to merge readiness

For an existing PR, inspect its full diff, issue, checks, reviews, and unresolved
threads before changing it. Continue a writable branch where possible. For a
new issue, implement the smallest coherent solution in one focused PR with the
normal closing reference.

Each worker maintains the single `## Agent Workpad`, implements and tests the
documented scope, pushes intentionally, waits for current-head CI, fixes
branch-caused failures, and processes every substantive review comment. Reply
to each comment with evidence and resolve a thread only after the fix is pushed
or the concern is conclusively answered. Repeat until `MERGE_READY` or a
verified external `BLOCKED` condition.

Do not add adjacent features, speculative abstractions, or unrelated cleanup.
Record useful out-of-scope discoveries separately.

## Land and finish

Allow parallel implementation but only one repository-wide merge in flight.
Acquire and verify the shared merge lease; independently re-read the exact head,
base, checks, reviews, and threads; apply every quality gate; renew the item
lease; merge with the repository's normal method; hold and renew the merge lease
through terminal-green required base-branch CI; and only then release it.
Refresh active branches after each landing.

Retain the logical worker, branch, worktree, and item lease through required
base CI. If a landed branch causes base CI to fail, stop the queue and invoke
the same logical worker with the failure logs on a repair branch from the
failing base. Do not assign the repair to a second owner.

Use bounded retries for transient failures. Continue until every in-scope item
is merged, explicitly excluded, duplicate or obsolete with evidence, or
externally blocked. Finish with a concise priority-grouped report of merged,
excluded, and blocked work, base CI, maintainability risks, and unnecessary
features or refactors intentionally rejected.
