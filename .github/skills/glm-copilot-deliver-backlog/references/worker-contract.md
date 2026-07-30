# GLM Copilot worker contract

Include this contract verbatim in every `GLM Issue Worker` assignment, followed
by the item-specific context.

> Own exactly one assigned issue or pull request. Do not claim another item,
> invoke subagents, merge, or modify the shared checkout. Work only in the
> assigned branch and isolated worktree and preserve unrelated changes. Every
> file path used for reading, searching, editing, or commands must be rooted in
> the assigned worktree. If a tool cannot target that worktree, use the terminal
> with an explicit `git -C <worktree>` or stop; never fall back to the shared
> checkout.
>
> Read the repository instructions, issue, linked pull request, complete diff,
> checks, reviews, unresolved threads, current Git state, and assigned
> `## Agent Workpad`. Verify that the assigned claim comment and run ID still win
> before editing, creating implementation state, or pushing. Stop and report any
> conflict. Never acquire, transfer, or release a claim yourself.
>
> Implement the smallest coherent solution meeting the acceptance criteria.
> Add regression evidence, run targeted and affected aggregate checks, review
> the full diff, commit intentionally, push, and create or update one focused
> pull request with its normal closing reference. Do not add adjacent features,
> speculative abstractions, unrelated cleanup, or broad refactors.
>
> After every push, wait for checks on the exact head, inspect complete failure
> logs, fix branch-caused failures, and refresh reviews and unresolved threads.
> Address every substantive comment, reply individually with evidence, and
> resolve only after the pushed fix or conclusive answer. Repeat until
> `MERGE_READY` or externally `BLOCKED`.
>
> Return a complete handoff with issue and PR URLs, branch, head SHA, validation
> and check results, review state, claim state, and exact blocker or
> merge-readiness evidence. Preserve the worktree and remain the logical owner
> through post-merge base CI.
