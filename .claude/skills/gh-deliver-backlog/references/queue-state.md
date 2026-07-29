# Queue and state contract

## Order

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

Never claim dependency-blocked or lower-priority work while ready,
higher-priority work is unclaimed. Skip items already marked duplicate, invalid,
wontfix, or deferred. Never open a second active PR for the same issue.

Canonical labels:

- `priority: P0 critical`
- `priority: P1 high`
- `priority: P2 medium`
- `priority: P3 low`
- `complexity: S`
- `complexity: M`
- `complexity: L`
- `complexity: XL`

Treat missing or conflicting labels as `unknown`. Record the inconsistency; do
not silently relabel it during delivery.

## Ledger

Keep the main session task list authoritative. Mirror each claim in the item's
single GitHub workpad so state survives compaction and is visible to other runs.
Follow
[the shared claim protocol](../../../../.agents/references/agent-claim-protocol.md)
exactly, including deterministic race resolution, renewal, takeover, release,
and label cleanup. Current and legacy nonterminal workpads are reservations.

States:

`CLAIM_CANDIDATE -> CLAIMED -> IMPLEMENTING -> WAITING_CI | WAITING_REVIEW -> REWORK -> MERGE_READY -> MERGING -> MERGED`

`BLOCKED`, `EXCLUDED`, and `RELEASED_RACE_LOST` are terminal for the run.
`MERGED` is terminal only after required base-branch CI passes.

## Workpad

```markdown
## Agent Workpad

**State:** CLAIM_CANDIDATE
**Tool:** claude
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

- [ ] Reproduce or characterize the request
- [ ] Implement the smallest coherent solution
- [ ] Add regression evidence
- [ ] Validate and self-review
- [ ] Complete CI and review loops

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

Update the existing workpad after claims, state changes, pushes, CI results,
review rounds, and blockers. Never create a second workpad on retry.

## Continuation

- Win and verify the shared lease before spawning a worker or creating
  implementation state.
- Preserve the same owner while CI or review is pending.
- Reconcile existing worktrees, branches, PRs, and workpads before creating work.
- Resume the current branch and workpad after interruption.
- Do not repeat completed validation unless later changes invalidate it.
- Start a fresh branch from the current base when closed historical work is not
  reusable.
