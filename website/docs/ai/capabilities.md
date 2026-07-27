# What an AI can do

Once [connected](connect.md), an AI assistant reaches Campfire through its **MCP
server** (219 tools) and REST API. What it's allowed to do is capped by two
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
  turn flow, HP/conditions, XP, loot and treasury grants, map reveal, notes) and is **refused** cross-campaign
  calls and any admin/destructive tool (deletes, `update_campaign`,
  `uninstall_rule_pack`, `withdraw_proposal`).

### Configured in the web UI

The server admin sets the default provider under **Admin → AI console**. Campaign
DMs normally inherit it; an advanced per-campaign override remains available under
**Settings → AI Dungeon Master** when a table needs a different model or credential.
Together these screens configure:

- **Mode** (off / co-DM / driver).
- **Provider** — OpenAI-compatible, Anthropic, or a `mock` provider — plus a
  **write-only API key**. The key is **stored encrypted** (AES-256-GCM) and **never
  read back**: only the last four characters are shown, and it is kept out of reads,
  logs, and the audit trail. A deliberate **Clear stored key** action removes only
  the ciphertext after confirmation, preserving the provider, model, base URL,
  parameters, and allowlist. The screen then reports whether the provider is ready
  through `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, a server fallback, or no credential.
  An optional **Base URL** may point at an OpenAI-compatible proxy; the server
  blocks cloud-metadata and (by default) private/loopback hosts so a campaign DM
  cannot use Test connection as an SSRF probe. To run a **local model server**
  (Ollama, llama.cpp, LM Studio), the operator must set
  `AI_PROVIDER_ALLOW_PRIVATE_HOSTS=1` or list the host in
  `AI_PROVIDER_BASEURL_ALLOW_HOSTS` — see
  [Installation → AI provider host policy](../getting-started/installation.md).
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

### When the provider has a bad moment

Providers rate-limit, return 5xx, and drop connections mid-response. Campfire absorbs a
**transient** failure in two layers before the table hears about it:

- every request to a provider is already retried with exponential backoff and jitter,
  honouring `Retry-After`; and
- if the connection dies *after* the reply started streaming — which no request-level
  retry can recover — the driver re-issues the whole step once, on a short backoff.

If the primary still cannot serve the step and you have configured a **fallback
provider**, the turn is served by that instead. Failover is a last resort, not load
balancing: the primary gets all of its attempts first, so a one-off blip never quietly
moves your table onto a different model mid-scene.

**What is never retried**, because none of it is transient: a bad or expired key, a
malformed request, a prompt that exceeds the context window, and — most importantly — a
**content refusal**. Re-sending a prompt the provider just declined, or handing it to a
second vendor to see whether that one answers, is a safety bypass rather than resilience,
so Campfire does neither.

**A retry also never rewrites what players already read.** Once any narration has reached
the table the step is not re-issued: a second, different reply to the same moment would
leave the table with two versions and no way to tell which counts. That turn ends on the
recovery ladder as a **provider failure** — distinct from a tool error, with **Retry** and
**Continue without AI** offered first — and a human decides.

#### Configuring a fallback provider

Optional, and off by default.

- **Server-wide:** `PUT /settings/ai-provider/fallback` (server admin)
- **Per campaign:** `PUT /campaigns/{id}/ai-provider/fallback` (DM)

A fallback is a **fully independent** config with its own key, base URL, and model — not a
second model on the primary's credential. That is deliberate: a key you store is only ever
sent to the endpoint stored alongside it. It is bound by the same server admin model
allowlist and the same base-URL host policy as the primary, so adding one is never a route
around either. A misconfigured fallback is ignored with a warning rather than being allowed
to break a turn the primary could have served.

!!! note "Retries spend tokens"

    A provider bills for what it generated even when the connection then dies, so every
    attempt is metered against the campaign's token budget. The budget is re-checked before
    each attempt, so retries cannot overspend a cap you set — they simply stop.

### The scheduled AI scribe

A companion **AI scribe** can **draft session recaps** — after a scheduled session ends,
or on a per-campaign cron — and files each draft **as a proposal** in the DM's queue
(never a direct write). It's opt-in and off by default, under the same experimental
gating and token budget as the seat.

See the [roadmap](../reference/roadmap.md) for its status. (The branching **story
planner** it complements has shipped — see *Story planning* above.)

### Member consent for external AI use

Scribe inbox notes are written by your players. When a recap is generated by an
**external** provider those notes leave your server, so each member controls whether
their own authored notes may be included.

Two gates apply, and both must pass:

| Gate | Who sets it | Default |
| --- | --- | --- |
| **Campaign policy** — `member_consent` or `disabled` | the DM, in campaign settings | `member_consent` |
| **Member consent** — per member, for their own notes | each member, on the members page | **off** |

Nobody can grant consent on someone else's behalf: a DM can narrow the campaign policy,
never widen an individual's choice.

**Consent gates external use only.** It applies when the resolved endpoint actually sends
content off the server. With no AI provider configured, Campfire uses the built-in no-op
provider, nothing is transmitted anywhere, and notes are used as-is — there is no external
use to consent to. Notes marked **private** or **whisper** are never included either way;
that is a separate confidentiality rule, not a consent question.

!!! warning "A configured endpoint counts as external — including a local model"
    Campfire will not guess that a `baseUrl` is "local enough" by inspecting its host. A
    loopback or private address can just as easily be a proxy forwarding to a public
    vendor, and guessing wrong leaks content a member declined to share. If you run a
    genuinely on-box model (Ollama, llama.cpp, LM Studio) and want generations through it
    treated as local, declare it explicitly with `AI_PROVIDER_ENDPOINT_IS_LOCAL=1`.

    It defaults to off, and it is **not** the same setting as
    `AI_PROVIDER_ALLOW_PRIVATE_HOSTS` — permitting a private host as a *destination* says
    nothing about whether content sent there stays inside your deployment.

Withheld material is reported, never silently dropped. A run that held notes back says so
in the scribe panel and in the run's job history — and names the remedy that applies,
because the two gates belong to different people:

- Under **`member_consent`**: *"N notes withheld pending author consent"*, linking to the
  members page, where each author opts in for themselves.
- Under **`disabled`**: *"N notes withheld because this campaign's AI content policy
  disallows external use of member-authored notes"*, linking to campaign settings. No
  amount of member opt-in changes this one — only a DM changing the policy does.

The count is the same total either way; only the stated cause and the remedy differ. Each
recap proposal also records which provider, model, endpoint scope, and source IDs produced
it, and whether the generation was an external send at all.

**Dice rolls and encounter events are not consent-gated** — they are mechanical play
records rather than authored prose. The one member-identifying field a roll carries, the
roller's display name, *is* redacted for a roller who has not consented; the in-fiction
character name is campaign canon and is kept.

**Who can see a member's consent state.** The DM sees every member's, because they need it
to understand why a recap withheld material. Each member sees their own. Other players do
not — consent is a personal preference in a way that a role is not.

**Provenance never records the server-default endpoint URL.** The admin-managed server
provider config is hidden from campaign DMs by design, and recap provenance is DM-readable,
so only the endpoint *scope* (`server`) is stored for it. A per-campaign endpoint URL is
kept, since the DM configured it and can already read it back.
