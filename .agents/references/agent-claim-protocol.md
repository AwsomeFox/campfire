# Shared agent claim protocol

This protocol coordinates Codex, Claude Code, ZCode, Kimi Code, and VS Code
Copilot when more than one backlog run is active. GitHub comments are the lock.
Labels are only a human-visible summary and are never sufficient proof of
ownership.

## Claim locus and identities

- Claim the linked issue for a pull request. If a pull request has no linked
  issue, claim the pull request itself.
- For an existing pull request, inspect both the canonical claim locus and the
  pull request for current or legacy workpads before claiming. New claims still
  go on the canonical locus.
- Use the tool identity `codex`, `claude`, `zcode`, `kimi`, or `copilot`.
- Generate a unique run ID such as
  `<tool>-<YYYYMMDDTHHMMSSZ>-<random-or-uuid>`.
- Treat existing nonterminal `## Agent Workpad`, `## Codex Workpad`, and
  `## Claude Workpad` comments as reservations.
- Treat an occupied implementation branch or worktree as reserved until its
  owner and state are reconciled.

## Acquire a lease

Do not create an implementation branch or worktree, edit code, or push until
these steps succeed:

1. Fetch every comment on the claim locus and its current `agent:*` labels.
2. If a live winning workpad exists, skip the item. Labels alone do not make a
   lease live.
3. Post one `## Agent Workpad` comment with state `CLAIM_CANDIDATE`, the tool
   identity, unique run ID, current UTC claim time, and a lease ending 90 minutes
   later.
4. Immediately refetch all nonterminal candidate and claimed workpads.
5. Sort contenders by `(comment created_at, numeric comment id)`. The first is
   the winner.
6. A loser edits only its own comment to `RELEASED_RACE_LOST`, records the
   winning comment, and does no implementation work.
7. The winner edits its existing comment to `CLAIMED`, adds `agent: claimed`
   and exactly one owner label (`agent: codex`, `agent: claude`,
   `agent: zcode`, `agent: kimi`, or `agent: copilot`), then refetches once
   more before the first code edit, branch creation, worktree creation, or push.

If two active owners are discovered later, both pause implementation. Apply the
same deterministic ordering; the later contender releases its own claim and the
winner continues.

## Maintain and release a lease

- Renew the same comment at least every 30 minutes and on every major state
  change. Extend `Lease until` by 90 minutes.
- Renew immediately before and after long CI or review waits.
- Never create a second workpad on retry or continuation.
- A takeover is allowed only after the lease expires and there is no branch,
  pull-request, push, or workpad activity after expiry. The new workpad must
  reference the expired comment. Never edit another run's comment.
- Active states are `CLAIM_CANDIDATE`, `CLAIMED`, `IMPLEMENTING`,
  `WAITING_CI`, `WAITING_REVIEW`, `REWORK`, `MERGE_READY`, and `MERGING`.
- Terminal states are `MERGED`, `BLOCKED`, `EXCLUDED`, and
  `RELEASED_RACE_LOST`.
- On `MERGED`, `EXCLUDED`, or `RELEASED_RACE_LOST`, remove the claimed and
  owner labels only when no other live winning claim exists.
- On a verified external `BLOCKED` result, release the lease and owner labels
  and add `agent: blocked`.
- When resuming a blocked item, remove `agent: blocked` only after winning a new
  lease.

## Workpad format

Maintain one comment with this header and fields:

```markdown
## Agent Workpad

**State:** CLAIM_CANDIDATE
**Tool:** codex
**Run ID:** codex-20260729T120000Z-example
**Claim comment ID:** populated after creation
**Claimed at:** 2026-07-29T12:00:00Z
**Lease until:** 2026-07-29T13:30:00Z
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

- `<UTC timestamp>` — concise progress, lease renewal, or decision

### Blocker

- None
```

The workpad is the durable coordination record. Keep its state, lease, branch,
head, validation, review, and blocker details current.

## Repository-wide merge lease

Per-item leases prevent duplicate implementation. A separate short lease
serializes merges across all tools.

- The permanent coordination record is the closed issue
  `https://github.com/AwsomeFox/campfire/issues/1732`, labeled
  `agent: coordination`. It is never backlog work and must remain closed.
- Immediately before merging, post one `## Agent Merge Lease` comment with
  state `MERGE_CANDIDATE`, tool, run ID, pull request, claim time, and a lease
  ending 15 minutes later.
- Refetch active merge candidates and leases. The minimum
  `(created_at, numeric comment id)` wins, using the same race rules as an item
  claim.
- A loser edits only its own merge comment to `RELEASED_RACE_LOST`, waits with
  bounded backoff, refreshes the PR and base, then competes again.
- The winner edits its comment to `MERGING`, adds `agent: merge` to issue #1732,
  renews its item lease, refreshes every merge gate, and merges only that one PR.
- After a successful merge, change the merge comment to `WAITING_BASE_CI`,
  record the merged base SHA and required CI run URL, and keep renewing the
  15-minute merge lease until that exact base run is terminal green.
- Release the merge comment by setting `State: RELEASED` only after terminal
  green base CI. If the merge attempt did not change the base, release it after
  recording the failure. Remove `agent: merge` only if no other live winning
  merge lease exists.
- Never hold the merge lease while implementing, waiting for ordinary PR CI, or
  waiting for review. Holding it through required post-merge base CI is
  mandatory. If the lease nears expiry, renew it; never let it lapse while that
  CI is pending or failing.
- Other coordinators must refresh base health before posting a merge candidate.
  They must not acquire a merge lease or merge while the latest required base
  CI is pending or failing. A failing base keeps the repository-wide barrier in
  place through its repair or revert and subsequent terminal green base CI.
