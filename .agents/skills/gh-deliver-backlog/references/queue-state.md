# Queue and state contract

## Queue order

Drain the open PR snapshot first:

1. linked issue priority: P0, P1, P2, P3, unknown;
2. dependency readiness;
3. merge-ready or small-rework before major rework;
4. oldest PR first.

Then process issues without an active PR:

1. priority: P0, P1, P2, P3;
2. dependency readiness;
3. complexity: S, M, L, XL;
4. oldest issue first.

Never claim lower-priority work while dependency-ready higher-priority work is
unclaimed. Skip only items already marked duplicate, invalid, wontfix, or
deferred. Never open a second PR for an issue with an active PR.

Use these repository labels as the canonical queue values:

- `priority: P0 critical`
- `priority: P1 high`
- `priority: P2 medium`
- `priority: P3 low`
- `complexity: S`
- `complexity: M`
- `complexity: L`
- `complexity: XL`

Treat a missing or conflicting label as `unknown`; record the inconsistency and
do not silently relabel it during delivery.

## States

Keep the authoritative ledger in the primary Goal/task plan. Mirror every claim
in the item's single GitHub workpad so claims survive compaction and are visible
to other runs. Follow
[the shared claim protocol](../../../references/agent-claim-protocol.md)
exactly. Treat any nonterminal current or legacy workpad, occupied worktree, or
active branch as reserved until reconciled.

Use these states:

`CLAIM_CANDIDATE -> CLAIMED -> IMPLEMENTING -> WAITING_CI | WAITING_REVIEW -> REWORK -> MERGE_READY -> MERGING -> MERGED`

`BLOCKED`, `EXCLUDED`, and `RELEASED_RACE_LOST` are terminal for this run.
`MERGED` is terminal only after required base-branch CI passes.

Mirror the current state in one persistent comment per item. Do not create a new
comment on retry.

## Workpad template

```markdown
## Agent Workpad

**State:** CLAIM_CANDIDATE
**Tool:** codex
**Run ID:** unassigned
**Claim comment ID:** unassigned
**Claimed at:** unassigned
**Lease until:** unassigned
**Worker:** unassigned
**Worktree:** unassigned
**Branch:** unassigned
**PR:** unassigned
**Latest head:** unassigned

### Plan

- [ ] 1. Reproduce or characterize the requested behavior
- [ ] 2. Implement the smallest coherent solution
- [ ] 3. Add regression evidence
- [ ] 4. Validate and self-review
- [ ] 5. Complete CI and review loops

### Acceptance criteria

- [ ] Copy each verifiable issue criterion here

### Validation

- [ ] `<targeted command>`
- [ ] `<affected aggregate command>`

### Review

- [ ] Complete feedback sweep
- [ ] Reply to every substantive comment
- [ ] Resolve addressed threads
- [ ] Confirm no requested changes remain

### Notes

- `<UTC timestamp>` — concise progress or decision

### Blocker

- None
```

Keep the workpad factual and reviewer-oriented. Update it after state changes,
pushes, CI results, review rounds, and blocking discoveries.

## Claim and continuation rules

- The shared protocol is authoritative for acquisition, deterministic
  tie-breaking, renewal, takeover, release, and label cleanup.
- Win and verify the lease before spawning a worker or creating implementation
  state.
- Assign one item, branch, and worktree to one worker.
- Keep the same worker on the item while CI or review is pending.
- Do not use or clean the shared checkout when it contains user changes.
- Fetch the remote base and create worktrees from the current remote base.
- Reconcile existing worktrees, branches, and nonterminal workpads before
  creating a new claim.
- Resume the current workspace and workpad after a retry.
- Do not repeat completed investigation or validation unless later changes
  invalidate it.
- A closed or merged old PR is not reusable implementation state. Start a fresh
  branch from the current base when new work is still required.
