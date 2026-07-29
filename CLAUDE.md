@AGENTS.md

## Claude Code

- Use `/gh-deliver-backlog` for unattended multi-PR or multi-issue delivery.
- Read `.agents/references/agent-claim-protocol.md` and win its shared comment
  lease before dispatching a worker or creating implementation state. Respect
  live claims owned by Codex, ZCode, and Kimi Code; labels are only visibility.
- Run the main session as the Opus 5 coordinator configured in
  `.claude/settings.json`.
- Delegate implementation to at most four `issue-worker` subagents. They are
  pinned to Sonnet 5, run in the background, and receive isolated worktrees.
- Keep queue ownership, conflict reconciliation, final merge gates, and
  serialized landing in the main session.
- Do not use experimental agent teams for backlog implementation: teammates
  share a checkout, while these workers may touch overlapping files.
- Keep progress updates brief. Lead with outcomes and report only material state
  changes, blockers, or decisions.
