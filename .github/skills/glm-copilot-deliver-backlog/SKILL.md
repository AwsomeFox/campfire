---
name: glm-copilot-deliver-backlog
description: Orchestrate unattended GitHub backlog delivery in VS Code Copilot with a GLM-5.2 coordinator and up to four GLM-5.2 custom-agent workers. Use to drain existing pull requests, implement prioritized issues, handle CI and review feedback, resolve review threads, serialize merges, and continue until the finite queue is merged or externally blocked.
---

# Deliver GitHub Backlog with GLM Copilot

Act as the GLM-5.2 Copilot coordinator. Keep queue ownership, claim
arbitration, reconciliation, merge decisions, and final reporting in the main
agent. Use only the `GLM Issue Worker` custom agent for implementation
subagents, with no more than four active at once.

Before dispatch, read root `AGENTS.md`,
[agent-claim-protocol.md](../../../.agents/references/agent-claim-protocol.md),
[queue-state.md](references/queue-state.md), and
[quality-gates.md](references/quality-gates.md) completely. Before invoking a
worker, also read and include
[worker-contract.md](references/worker-contract.md) verbatim in its assignment.
Treat invocation text as optional narrowing, never scope expansion.

## Establish the finite queue

1. Verify repository identity, `gh` authentication, push access, remote base,
   the GLM provider, and availability of the `GLM Issue Worker` agent.
2. Fetch the remote and inventory open PRs, issues, priority and complexity
   labels, dependencies, branches, worktrees, checks, reviews, unresolved
   threads, `agent:*` labels, and current or legacy workpads.
3. Preserve dirty shared checkouts and reserve active branches, worktrees, and
   live claims.
4. Record a UTC cutoff. Drain the existing PR snapshot first, then issues by
   the referenced priority order. Admit only newly discovered P0/P1 work.
5. Detect duplicate implementations before claiming anything.

## Claim and dispatch

Acquire the shared lease as tool `copilot` before branch or worktree creation,
code edits, pushes, or worker dispatch. Refetch and verify the winning comment
immediately before implementation begins. Skip any item owned by another live
claim.

Create each worktree below
`<repo>/.copilot-worktrees/<run-id>/<item-kind>-<number>` from the current
remote base, after winning the claim. Give each worker exactly one item, one
explicit branch, and one explicit worktree. Never let a worker edit the shared
checkout.

Dispatch up to four `GLM Issue Worker` subagents in parallel. Include the
winning claim comment ID and run ID, issue and PR URLs, priority, complexity,
dependencies, acceptance criteria, current CI/review state, architectural
constraints, worktree, branch, and validation commands. Backfill a slot only
after reconciling its previous worker's state.

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
branch-caused failures, and processes every substantive review comment. Require
an individual evidence-based reply before resolving each thread. Repeat until
`MERGE_READY` or a verified external `BLOCKED` condition.

Do not add adjacent features, speculative abstractions, unrelated cleanup, or
broad refactors. Record useful out-of-scope discoveries separately.

## Land and finish

Allow parallel implementation but only one repository-wide merge in flight.
Acquire and verify the shared merge lease; independently re-read the exact head,
base, checks, reviews, and threads; apply every quality gate; renew the item
lease; merge with the repository's normal method; hold and renew the merge lease
through terminal-green required base CI; and only then release it. Refresh
active branches after each landing.

Retain the logical worker, branch, worktree, and item lease through required
base CI. If a landed branch causes base CI to fail, stop the queue and invoke
the same logical worker with the failure logs on a repair branch from the
failing base. Do not assign the repair to a second owner.

Use bounded retries for transient failures. Continue until every in-scope item
is merged, explicitly excluded, duplicate or obsolete with evidence, or
externally blocked. Finish with a concise priority-grouped report of merged,
excluded, and blocked work, base CI, maintainability risks, and unnecessary
features or refactors intentionally rejected.
