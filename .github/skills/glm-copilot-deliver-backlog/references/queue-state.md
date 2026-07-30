# Queue and state contract

## Queue order

Drain open pull requests first by linked issue priority (P0 through P3, then
unknown), dependency readiness, merge readiness, and age. Then drain issues
without active pull requests by priority, dependency readiness, complexity
(S, M, L, XL), and age.

Never claim lower-priority ready work while higher-priority ready work is
unclaimed. Skip duplicate, invalid, wontfix, and deferred items. Never open a
second active pull request for one issue.

Canonical queue labels are:

- `priority: P0 critical`
- `priority: P1 high`
- `priority: P2 medium`
- `priority: P3 low`
- `complexity: S`
- `complexity: M`
- `complexity: L`
- `complexity: XL`

Treat missing or conflicting values as unknown and report them without silently
relabeling.

## State and ownership

Follow
[the shared claim protocol](../../../../.agents/references/agent-claim-protocol.md)
exactly. The coordinator's todo ledger is authoritative for the run and the
single GitHub `## Agent Workpad` is the durable cross-tool record.

States:

`CLAIM_CANDIDATE -> CLAIMED -> IMPLEMENTING -> WAITING_CI | WAITING_REVIEW -> REWORK -> MERGE_READY -> MERGING -> MERGED`

`BLOCKED`, `EXCLUDED`, and `RELEASED_RACE_LOST` are terminal for the run.
`MERGED` is terminal only after required base CI passes.

Use `Tool: copilot`, a unique run ID, the claim comment ID, UTC claim and lease
times, worker, worktree, branch, pull request, and latest head in every workpad.
Update the same comment after claims, renewals, state changes, pushes, CI,
reviews, and blockers.

Resume an existing winning lease, branch, and worktree after interruption.
Never duplicate work or repeat completed validation unless a later change
invalidates it.
