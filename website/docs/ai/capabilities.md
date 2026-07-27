# What an AI can do

Once [connected](connect.md), an AI assistant reaches Campfire through its **MCP
server** (221 tools) and REST API. What it's allowed to do is capped by two
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
- **Combat** — create an encounter (private DM prep by default), add monsters from
  the compendium, roll initiative, deal damage, apply conditions, advance turns,
  and end it (HP writes back to sheets).
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
  the driver is **tool-scoped to live-play tools** (dice, initiative, encounter
  authoring and turn flow, HP/conditions, XP, loot and treasury grants, map reveal, notes) and is **refused** cross-campaign
  calls and any admin/destructive tool (deletes, `update_campaign`,
  `uninstall_rule_pack`, `withdraw_proposal`).

### Encounter authoring, and its two limits

A Driver can **originate a fight**, not just run one you built: it calls
`create_encounter`, adds the combatants, and begins the encounter in a single
flow, so "roll a wandering monster and start it" works without you stopping to
build the tracker by hand.

This is a **direct** capability rather than a proposal, and that is deliberate. A
proposal is a draft that does not exist until you approve it — the AI's very next
call would have no encounter to add monsters to, so routing encounter creation
through the queue would not slow the flow down, it would break it. An encounter
is play state, closer to a dice roll than to canon; new NPCs, quests and
locations remain proposal-only.

Two limits bound it, and both are enforced by the server rather than by asking
the model nicely:

- **Every encounter the AI creates is DM-only prep.** It cannot choose to make
  one visible, and it cannot reveal an existing one — `hidden` is not writable by
  the seat at all. Its roster and difficulty stay withheld from players until
  **you** reveal it from the encounter list. This matters because the Driver
  takes its instructions from player chat: without the limit, "what are we about
  to fight?" would be a way to make the AI publish your prep.
- **It may only reshape what it made.** The AI can rename or re-link an encounter
  it created during this session. Encounters *you* prepared are yours — it is
  told to ask rather than edit them, and the server refuses the write if it
  tries.

AI-created encounters appear in your encounter list immediately, badged
**Hidden**, and every call is recorded in the campaign audit log.

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

### Collaborative handoff: the AI narrates, you rule

Between "the AI runs the table" and "a human takes the seat entirely" there is a middle setting.
Turn on **collaborative handoff** (DM only) and the AI keeps narrating and keeps playing NPCs,
but every call that would **commit a mechanical outcome** waits for you:

| Still automatic | Waits for you |
| --- | --- |
| Dice rolls, saves, initiative | Applying an action's damage or effects |
| Reading the world | Changing HP or conditions |
| Undoing a mistake | Advancing the turn |
| Proposing canon edits (already a proposal) | Adding, changing or removing combatants |
| | Starting or committing an encounter |

Dice stay automatic on purpose. A roll produces a *number*; nothing changes until something
applies it, and a single attack is a roll, a save and an apply — confirming each one would make
the mode unusable while protecting nothing. Undo stays automatic for the same reason in reverse:
a confirmation in front of the undo button leaves a wrong result on the board until someone
approves removing it.

**The AI is told to narrate a waiting action as attempted, not finished** — "she swings for the
gap in its armour", never "she hits for nine damage". Otherwise the table would hear an outcome
that never happened.

The mode is sticky in the way that matters: pausing the seat, taking it over and handing it
back, or getting stuck and recovering all leave it on, and it survives a server restart. Nothing
except turning it off gives the AI back the authority to change the board on its own.

!!! tip "Approving the waiting actions"
    Deferred calls land in the AI's pending tool-confirmation queue, which appears at the top of
    the **AI Table** as soon as something is queued — see [Approving what the AI asks
    to do](#approving-what-the-ai-asks-to-do) below. Each waiting action is shown as a decision
    with its arguments one click away, and the campaign's DMs are notified even when nobody is
    looking at the table.

### What survives a server restart

The seat's **state** is stored in the database, not in server memory, so a restart or a
redeploy in the middle of a session does not quietly reset the table. A pause stays paused,
a human takeover stays granted, the stuck ladder and its replay input survive (so **nudge**
and **retry** still work), and an open table vote comes back with its ballots intact.

Some things deliberately **do not** survive, because they are grants of authority made to a
room the server can no longer verify once the process has gone:

| Cleared by a restart | Why |
| --- | --- |
| **Secret-read approvals** — a DM letting the seat read one specific hidden NPC, quest, or location | The grant named one entity and was made in a room you were watching. The DM can grant it again in a second; silently carrying it forward is the option with a downside. |
| **Tool calls awaiting your approval** | These are irreversible live-play writes nobody approved yet. They are discarded un-executed; the AI will ask again if it still needs to. |
| **A table vote whose time ran out while the server was down** | Downtime still burns the ballot window, so the vote comes back **failed** rather than as a live decision people can still be counted into. |

**None of that happens quietly.** Every cleared grant gets its own audit entry naming exactly
what it covered, the table gets a notification and a live signal, and the reset is written into
the table log so someone who reconnects later still sees it. Losing the state is acceptable;
losing it without telling anyone is not — a DM should never have to *discover* that an approval
they granted is gone, or that the AI is waiting on a confirmation that no longer exists.

### Approving what the AI asks to do

Some actions the AI proposes do not run straight away — they wait for the DM. `begin_encounter`
always does, and so do the irreversible ones (ending a fight, removing a combatant, awarding XP,
levelling a character, moving treasury or inventory).

**Waiting actions appear on the AI Table, at the top, as soon as they are queued.** Each one is
shown as a decision rather than a function call — "Deal 7 damage to Thorne", not
`update_character_hp` — with the full arguments one click away. Approve runs it; Reject discards
it. Names come only from what your browser already loaded, so an entity you cannot see shows as
an id rather than a name.

**The turn does not stop while one waits.** The AI is told the action is pending and carries on
narrating, so the scene keeps moving. That is what makes several waiting actions the normal case
rather than an unusual one — under collaborative handoff a single combat turn can queue four —
and why the panel is a list.

**If you are not on the AI Table, you still get told.** A pending action raises a notification for
the campaign's DMs, which is delivered immediately and cannot be muted or batched into a digest.
Players are not notified: they cannot act on it, and the queue is DM-only.

!!! note "Waiting actions do not expire on a timer"
    A pending action waits until you answer it. There is deliberately no countdown: nothing is
    blocked while it waits, so a timer would not release anything — it would only add a third way
    for a decision to disappear. The two ways one *can* disappear are both recorded in the audit
    log rather than happening quietly: a server restart discards them, and the queue drops the
    oldest once it reaches its cap. Check the campaign audit log if an action you expected to
    approve is no longer listed.

### Session pacing: start and wrap up

By default the AI answers when someone talks to it and does nothing otherwise. Two controls on
the AI Table give a session a shape:

- **Start Session** — available to **anyone at the table**, because sitting down to play is a
  group act, not something everyone should wait on the DM for. The AI greets the players and
  recaps where you left off.
- **Wrap Up** — **DM only**, because closing a session is a decision. The AI delivers a spoken
  closing summary and the session is marked ended.

**The greeting recap is the one your DM already approved.** It reads the recap on your most
recent session — the one the AI Scribe drafted and the DM accepted — rather than writing a fresh
account of the same events. If there is no recap on record yet, it says so instead of inventing
what happened. A confabulated "last time on…" is worse than none, because the table takes it as
canon at exactly the moment everyone is working out what is true.

Neither control is a way around anything. Both run a normal AI turn, so a paused seat, an
exhausted token budget, or a human holding the DM seat refuses them just as it refuses a player
action — and a start request that gets refused leaves the session exactly where it was.

After the AI wraps up, player input is refused until someone starts a new session. That is the
only thing the lifecycle blocks, and any player can clear it in one click.

**If a greeting or wrap-up fails**, the session still opens or closes. A provider hiccup should
not leave a table unable to start playing; the failure shows up in the AI's recovery levers,
where failures belong. Likewise, if the server restarts while the AI is mid-greeting or
mid-wrap-up, that turn is gone — so the table is put back into normal play and **told that it
happened**, rather than left waiting for a summary that is never coming.
### Short rests and long rests

The AI DM can run a rest for the whole party in **one atomic call** rather than setting each
character's HP, resetting each spell-slot level and clearing each condition individually.

A **long rest** restores HP to full, clears temporary HP, resets death saves, restores spell
slots, and refills every resource whose rule-system recharge cadence is short-rest, long-rest,
refocus, or dawn. A **short rest** refills short-rest resources and optionally spends hit dice
for healing (each die rolled plus the CON modifier).

**Recovery is the rule system's to define.** Which resource comes back on which rest is read
from the recharge cadence your rule system already declares for it, so a 13th Age or Ironsworn
table does not silently inherit D&D 5e's recovery just because 5e is the default.

!!! note "What a rest does *not* clear"

    A rest removes only the conditions your rule system says a rest removes — under 5e that is
    exhaustion, unconscious, prone and frightened. Anything else, including a homebrew status a
    DM typed in themselves, is deliberately **left in place** and reported back, so a night's
    sleep can never silently delete a curse or a petrification. Conditions on a character sheet
    carry no duration or source information yet, so the safe direction is to under-clear and
    tell you, rather than guess and erase.

**Atomicity is the point.** Every named character is validated before anything is written: if
one of them is dead, lacks the hit dice requested, or has no known hit-die size, the whole rest
is rejected and *no* character is changed. A rest that healed half the party and then failed
would be worse than no rest tool at all.

Hit dice need an explicit die size (`d8`, `d10`, …). The class hit die is not stored on the
character sheet, and guessing one would quietly under-heal the character with no sign it
happened.

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
