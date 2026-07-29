---
name: glm-deliver-backlog
description: Drain Campfire pull requests and prioritized issues with GLM-5.2 Copilot agents.
argument-hint: Optional queue limits or exclusions
agent: GLM Backlog Coordinator
model: "GLM-5.2 (glm)"
---

Use
[the GLM Copilot backlog skill](../skills/glm-copilot-deliver-backlog/SKILL.md)
to deliver the entire current backlog in priority order. Continue until every
in-scope item is merged or externally blocked. Treat any additional invocation
text as narrowing or exclusions, never as permission to expand issue scope.
