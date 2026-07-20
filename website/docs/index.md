---
hide:
  - navigation
  - toc
---

# 🔥 Campfire

## The party's shared memory — self-hosted, and runnable by AI.

Campfire is an open-source campaign tracker for tabletop RPGs. Quests, NPCs,
locations on a map, a live combat tracker, session recaps, per-player notes —
and an **MCP server** so Claude (or any AI agent) can help run your table.

You host it. You own the data. One container, one volume.

[Get started :material-rocket-launch:](getting-started/installation.md){ .md-button .md-button--primary }
[View on GitHub :fontawesome-brands-github:](https://github.com/AwsomeFox/campfire){ .md-button }

---

## Why Campfire

<div class="grid cards" markdown>

-   :material-sword-cross: __Everything a table needs__

    Campaigns, quests with objectives and subquests, NPCs with secrets, a pin
    map, character sheets with at-the-table HP and conditions, session recaps,
    and a full initiative/combat tracker with a dice roller.

-   :material-robot-happy: __AI-operable from day one__

    A built-in MCP server exposes your campaign to any MCP client. Ask Claude to
    write the recap, prep the next session, or run initiative — with a proposal
    queue so nothing touches your canon without approval.

-   :material-shield-lock: __Real, server-enforced secrecy__

    DM-only fields and private notes are stripped in the API layer, never merely
    hidden in the browser. Players see what players should see.

-   :material-server-network: __Self-hosted & simple__

    A single Docker image and one data volume (SQLite + uploads). Login with
    local accounts or your own SSO (Authentik and any OIDC provider).

-   :material-book-open-variant: __Bring your own rules__

    Install the Open5e SRD — or upload any open-licensed dataset — into a searchable
    compendium, look monsters and spells up mid-combat, and drop them straight into
    an encounter.

-   :material-palette: __Yours to run__

    MIT-licensed. Per-user accent colours, markdown everywhere, one-click export
    of your whole campaign to JSON or Markdown. No lock-in, ever.

</div>

---

!!! note "Project status"
    Campfire is in active development; the current release is **v0.5.0**. The core
    play loop is complete and well-tested; see the
    [Roadmap & status](reference/roadmap.md) for exactly what's done, what's
    half-built, and what's planned next.
