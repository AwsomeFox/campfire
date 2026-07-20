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

## On the horizon

A server-side **AI Dungeon Master** — you connect an API key and the server runs the
game, everyone joins as a player — is an experimental, admin-gated feature on the
[roadmap](../reference/roadmap.md), built on this same tool surface. (The branching
**story planner** it complements has shipped — see *Story planning* above.)
