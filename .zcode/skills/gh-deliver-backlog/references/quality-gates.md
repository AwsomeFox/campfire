# Quality, review, and landing gates

## Implementation

- Meet documented acceptance criteria without adjacent features.
- Follow root and subtree instructions and preserve architectural invariants.
- Add regression tests for defects and appropriate tests for new behavior.
- Run targeted checks, then every aggregate check affected by the final diff.
- Review the complete diff for correctness, security, authorization, secrecy,
  REST/MCP drift, migration compatibility, dead code, and scope.
- For L or XL work, plan boundaries, compatibility, migration, failure behavior,
  rollback, and independently useful staged delivery.

## CI and review

After every push, monitor checks for the latest head, inspect full failure logs,
fix branch-caused failures, and rerun a credible infrastructure failure only
once. Any code change invalidates affected prior validation.

Refresh reviews, inline comments, and unresolved threads after every push and
before landing. Address every substantive comment, reply individually with the
change or technical answer and validation evidence, and resolve only after the
fix is pushed or the concern is conclusively answered. Do not dismiss continuing
legitimate disagreement or repeatedly re-request review for one head.

## Merge-ready and landing

Directly verify the acceptance criteria, current base, pushed head, required
green checks, every branch-protection, ruleset, and requested-review
requirement, absence of requested changes, individual replies, resolved
threads, focused diff, accurate tests and docs, and a current winning lease.
When repository policy does not require approval from a distinct GitHub actor,
the coordinator's fresh documented review may satisfy the independent quality
gate; never invent or impersonate an approval.

Only the coordinator merges. Refresh all state immediately before the merge,
wait for checks invalidated by updates, merge normally, confirm issue closure,
and wait for required base CI. If base CI fails, stop the queue and return the
regression to its retained logical owner on a repair branch from the failing
base.

Mark `BLOCKED` only for verified missing credentials or permissions,
unavailable external systems, or an undecidable product requirement after
documented fallbacks and three attempts meet the same external condition.
Preserve implementation state and record the exact unblock action.
