# What an AI can do

Once [connected](connect.md), an AI assistant reaches Campfire through its **MCP
server** (~90 tools) and REST API. What it's allowed to do is capped by two
independent, server-enforced token dimensions — a **read scope** (dm / player /
viewer) and a **write mode** (direct / propose / read-only) — exactly like a human
of that role.

## The whole loop, over MCP

An AI with a DM-scoped token can run a campaign end to end — verified end-to-end:

- **World-building** — create and edit campaigns, quests (with objectives and
  subquests), NPCs, and locations, including DM secrets and map pins.
- **Story planning** — build branching **arcs and beats** (with labelled branches
  between beats) so an assistant can draft and rearrange where the story might fork.
- **Rules** — install a rule pack, search it, and cite entries.
- **Characters** — create and update sheets, adjust HP and conditions.
- **Combat** — create an encounter, add monsters from the compendium, roll
  initiative, deal damage, apply conditions, advance turns, and end it (HP writes
  back to sheets).
- **Session flow** — write recaps, read and resolve the scribe inbox.
- **Dice** — roll for checks and saves.
- **Export** — pull the whole campaign as JSON.

## Governance & safety

- **Read scope caps are real.** A player- or viewer-scoped token can't read DM
  secrets; a campaign-bound token can't see other campaigns. Tested at every level.
- **Write mode is server-enforced, not voluntary.** A token's write authority is a
  separate dimension from its read scope, so a token can read the whole campaign
  yet be barred from writing it directly:
    - **Direct** (default, back-compat) — writes apply immediately when the read
      scope allows; the `?proposed=true` flag is an opt-in.
    - **Propose only** — *every* mutation, deletes included, is **coerced into a
      pending proposal by the server**, whether or not the caller sets
      `?proposed=true`. The AI cannot write canon directly even if it tries. This
      is the recommended mode for AI agents: give it `dm` read scope so it has full
      context, but `propose` write mode so nothing lands without a DM approving it.
      Write endpoints that have no proposal path (HP/XP tweaks, combat, dice,
      settings) are rejected outright for a propose-only token.
    - **Read-only** — every write is rejected.
- **The proposal queue.** A queue the DM approves or rejects — so an AI on a
  propose-only token can't silently rewrite canon.
- **Audit.** Every AI action is audit-logged under the token's name.
- **The table's charter.** An assistant can read the campaign's **session-zero charter**
  (`get_session_zero`, or the `session-zero` resource) — the lines and veils, safety
  tools, house rules and tone the table agreed to — so AI-assisted prep can stay inside
  the same boundaries the humans set.

## Common asks

> *"Summarise last session as a recap."* · *"Add a goblin ambush from the compendium
> and roll initiative."* · *"Sweep the inbox into quest and NPC proposals."* ·
> *"Draft three plot beats for the next arc."*

## The AI Dungeon Master seat (experimental)

Campfire ships an experimental, admin-gated **AI Dungeon Master seat** (issue #28) —
a per-campaign "DM seat" with real plumbing around it. What actually ships is the
seat, not a server that plays the game for you:

- **It's gated twice.** A server admin must turn on the server-wide experimental
  flag (`experimentalAiDm`), and the per-campaign seat must be enabled, before any
  turn is allowed.
- **Turns are metered.** Each campaign has a token budget; every turn is drawn down
  against it and **audited** under the caller's name. The `ai_dm_narrate` MCP tool
  takes a turn (DM role required).
- **The shipped provider makes no vendor call.** The default `AI_DM_PROVIDER` is a
  **no-op scaffold** — it contacts no LLM and returns a clearly-labelled placeholder.
  There is **no API-key flow and no web UI**; the server does not run the game with a
  key you paste in.

So in a **stock install**, the seat is driven by a **connected MCP agent** (for
example, Claude on a dm-scoped token): that agent authors the narration and drives
the other write tools — exactly the loop described above — while the seat handles the
gating, budget metering, and audit around it. A **self-hoster** who explicitly wants
server-side generation can bind their own provider to the `AI_DM_PROVIDER` token,
leaving the metering/gating/audit unchanged.

See the [roadmap](../reference/roadmap.md) for its status. (The branching **story
planner** it complements has shipped — see *Story planning* above.)
