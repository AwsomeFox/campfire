# What an AI can do

Once [connected](connect.md), an AI assistant reaches Campfire through its **MCP
server** (134 tools) and REST API. What it's allowed to do is capped by two
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
a per-campaign "DM seat" with a full web UI and real plumbing around it. It's still
**gated twice**: a server admin turns on the server-wide experimental flag
(`experimentalAiDm`), and the per-campaign seat must be enabled, before any turn runs.

### An operating mode per campaign

The seat has three modes, set in the web UI:

- **Off** — the seat takes no turns.
- **Co-DM** — the AI **only proposes**. Everything it produces is filed into the
  **proposal queue** for the DM to approve or reject; it never writes canon directly.
- **Driver** — the AI **holds the seat and runs the live session**, calling the
  play tools itself. Even here, **canon writes are still forced through proposals**;
  the driver is **tool-scoped to live-play tools** (dice, initiative, encounter and
  turn flow, HP/conditions, XP, map reveal, notes) and is **refused** cross-campaign
  calls and any admin/destructive tool (deletes, `update_campaign`,
  `uninstall_rule_pack`, `withdraw_proposal`).

### Configured in the web UI

Under **Settings → AI Dungeon Master** on a campaign, the DM sets:

- **Mode** (off / co-DM / driver).
- **Provider** — OpenAI, Anthropic, or a `mock` provider — plus a **write-only API
  key**. The key is **stored encrypted** (AES-256-GCM) and **never read back**: only
  the last four characters are shown, and it's kept out of reads, logs, and the audit
  trail.
- **Model allowlist**, a per-campaign **token budget**, and free-text **steering
  instructions** (redacted from non-DM readers).

A server admin also gets an **AI console** at **`/admin/ai`**: a **kill switch** (the
server-wide `experimentalAiDm` flag), a **server-wide token cap**, and a **provider
health** check that probes the configured providers.

### The shipped provider still makes no vendor call

The **default provider is a no-op scaffold** — it contacts no LLM and returns a
clearly-labelled placeholder. **Campfire never calls an LLM vendor from the server by
default.** Real narration comes from one of two places:

- a **connected MCP agent** (for example, Claude on a dm-scoped PAT) that authors the
  narration and drives the write tools — exactly the loop described above; **or**
- a **per-campaign provider** you configure with your own key (above), or a self-hoster's
  own provider bound to the `AI_DM_PROVIDER` seam for server-side generation.

Either way the seat handles the gating, budget metering, and audit around it.

### Keeping a driver in check

If a driver stalls or makes a call the table disputes, players have recovery levers:
**nudge** it (replay the turn with a hint), **flag** a ruling to force a re-decide,
open a **table vote** (to override or pause), or **request a human takeover**. The DM
can pause and resume the seat at any time.

### The scheduled AI scribe

A companion **AI scribe** can **draft session recaps** — after a scheduled session ends,
or on a per-campaign cron — and files each draft **as a proposal** in the DM's queue
(never a direct write). It's opt-in and off by default, under the same experimental
gating and token budget as the seat.

See the [roadmap](../reference/roadmap.md) for its status. (The branching **story
planner** it complements has shipped — see *Story planning* above.)
