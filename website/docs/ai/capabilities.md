# What an AI can do

Once [connected](connect.md), an AI assistant reaches Campfire through its **MCP
server** (266 tools) and REST API. What it's allowed to do is capped by two
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

These are distinct from an **external MCP agent**. An MCP client uses the token's
own read scope and write mode to operate Campfire tools; it does not supply
narration to the built-in Driver transcript. The built-in Driver lives beside a
running encounter under **Encounters**; Co-DM has no live transcript at all.

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

!!! warning "A campaign override without its own key is a model-only override"

    If the override stores no API key of its own, it borrows the **server** row's
    credential — and with it the server's provider type and base URL, because a stored key
    is only ever sent to the endpoint stored alongside it. Only the **model** and sampling
    parameters come from the campaign. This applies even when the override names a
    different provider, including the offline `mock` one: the turn still runs on the
    server's provider and endpoint, and the settings screen reports the credential as
    coming **from the server**. To run a table with no external calls at all, the *server*
    row is what has to change; a campaign override cannot opt out on its own.

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
server-wide `experimentalAiDm` flag), a **server-wide token cap**, **model pricing**
(below), and a **provider health** check that probes the configured providers.

### What a token budget does and does not tell you

!!! warning "A token budget is not a spending limit"

    It is a **token** cap. Turns stop when it is reached, so it bounds usage — but on
    its own it says nothing about **money**, and what a given number of tokens costs
    depends entirely on which model serves them.

Campfire shows a dollar estimate **only when a server admin has entered pricing for the
model in question**, under **AI console → model pricing**. Prices are per million input
and output tokens, and are keyed by provider, model, **and endpoint**.

When no price is on file, every cost surface says so plainly — *"Campfire cannot
estimate cost — monitor your provider's billing"* — rather than showing a figure. That
is deliberate. Vendors change prices without notice, self-hosted and proxied endpoints
have no public price at all, and **a confident wrong number is worse than no number**: a
DM shown "$3.10" who is then billed $31 was actively misled, whereas a DM told we cannot
estimate goes and reads their provider's billing page, which is the right thing to do
regardless.

Three things worth knowing about the estimates:

- **They are ranges, and approximate.** A budget's real cost depends on how it splits
  between input and output tokens, which nobody knows in advance and which differ
  several-fold on most providers. The **top** of the range is the number to budget
  against. Figures are rounded and prefixed `≈`; none of them is a quote.
- **They cover one campaign's AI seat** — not your server's total AI spend, and not any
  other campaign. That caveat is printed next to every figure, not hidden in a tooltip.
- **A custom Base URL never inherits a vendor price.** A model *name* behind a proxy,
  gateway, or self-hosted server says nothing about what that endpoint charges, and
  anyone pointing at one is more likely to be on a negotiated or self-hosted rate. Enter
  a price for that endpoint explicitly, or the disclosure is shown.

Campfire ships a small **reference list** of published prices for common models. It is a
**data-entry aid only** — nothing estimates against it. An admin can prefill from it,
review the figures, and save them; only then do they become live pricing, and the saved
entry records that it came from the reference list along with the date that list was
verified, so staleness stays visible.

The estimate or the disclosure appears **before you switch a campaign to Driver mode**,
in the setup checklist directly above the mode selector, and again beside the token
budget field as you type a number.

### The shipped provider still makes no vendor call

With no configured provider, Campfire falls back to a **no-op scaffold** that contacts
no LLM. Driver mode therefore remains unavailable until a configured provider and
credential pass readiness. **Campfire never calls an LLM vendor from the server by
default.** Real narration comes from one of two places:

- a **connected MCP agent** (for example, Claude on a dm-scoped PAT) that authors its
  own narration and drives the write tools — this is separate from the built-in Driver
  transcript; **or**
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
    the **live session chat on the running encounter** as soon as something is queued — see [Approving what the AI asks
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

### When a provider refuses or filters a reply

If the AI provider reports that it **stopped a reply on safety grounds** — a content
filter tripping, the model declining, or the provider blocking the prompt outright before
it generated anything — Campfire treats that turn as **withheld**, not as narration:

- the reply is **never committed**: no DM message is posted, nothing is written to the
  table transcript, and the text is not carried into the AI's context for the next turn;
- **no tool runs**, even if the AI asked for one in that same reply, so a refused turn
  cannot change HP, dice, canon, or anything else;
- the table sees a **neutral notice** that a reply was withheld. It deliberately does not
  say what was withheld;
- the seat parks on the usual recovery ladder with **Retry**, **Nudge** (retry with
  different framing), and **Continue without AI**;
- an incident trail is recorded for the DM. **There is no in-app screen for it yet** — it
  is readable only by a DM of the campaign, over the API, at
  `GET /api/v1/campaigns/:campaignId/ai-dm/withheld-turns`. It records counts and
  provenance only — how much had already streamed, how much the trailing window still had
  in hand, how many tool calls were suppressed, which provider and model, and whose action
  prompted it. **The withheld text itself is never stored anywhere**, and neither is a
  fingerprint of it. Read *"already streamed"* first: it is the number that says how much
  of the reply reached the table. The other one is capped by the size of the window, so on
  a long refused reply it is small because most of the reply had already gone out — not
  because little was refused.

**About live streaming.** Narration streams to the table token by token, and a provider
only reports a refusal at the *end* of a reply. Campfire holds back a short trailing
window of narration (a couple of sentences) so the newest text is still on the server when
that signal arrives — in practice the offending passage and the refusal arrive within a few
frames of each other, so usually **nothing reaches the table at all**. If a reply was long
enough that some text had already streamed, clients are told to discard it. That is a
real mitigation with a real bound, not a guarantee: text a player already read cannot be
unread, and the incident record tells a DM exactly how much that was.

!!! warning "Local and self-hosted models are not covered by this"

    This protection **relays a safety signal from your provider**. Campfire does not
    classify content itself. A self-hosted or local model with no safety layer — Ollama,
    llama.cpp, LM Studio, a bare vLLM endpoint, and many OpenAI-compatible proxies — will
    simply report that it finished normally, and **nothing here will fire**. If your table
    needs this protection, it has to come from a provider that performs the check. The
    session-zero charter, the proposal gate on canon writes, the tool allowlist, and human
    review all still apply either way.

### Approving what the AI asks to do

Some actions the AI proposes do not run straight away — they wait for the DM. `begin_encounter`
always does, and so do the irreversible ones (ending a fight, removing a combatant, awarding XP,
levelling a character, moving treasury or inventory).

**Waiting actions appear at the top of the live session chat on the running encounter as soon as they are queued.** Each one is
shown as a decision rather than a function call — "Deal 7 damage to Thorne", not
`update_character_hp` — with the full arguments one click away. Approve runs it; Reject discards
it. Names come only from what your browser already loaded, so an entity you cannot see shows as
an id rather than a name.

**The turn does not stop while one waits.** The AI is told the action is pending and carries on
narrating, so the scene keeps moving. That is what makes several waiting actions the normal case
rather than an unusual one — under collaborative handoff a single combat turn can queue four —
and why the panel is a list.

**If you are not on the running encounter, you still get told.** A pending action raises a notification for
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

By default the AI answers when someone talks to it and does nothing otherwise. Two controls in
the live session chat on the running encounter give a session a shape:

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

**Both wait for a quiet moment.** If the AI is already mid-turn, starting or wrapping up is
refused rather than queued behind the play in progress. Unlike a player action, which means the
same thing whenever it runs, "we have just sat down" is only true when you press it — a greeting
delivered after two more turns of play would recap a session that had already resumed. Press it
again once the AI finishes; nothing about the table changes in the meantime.

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

**Failover is decided per step, not per turn**, and this is the part most likely to be
misread during an incident. A single turn may run many tool-loop steps, and each one starts
over at the primary. So a primary that is *persistently* down is retried afresh on every
step before the fallback is reached again — the symptom you see is **turns becoming very
slow**, not one clean switch to the fallback. That is intentional (a provider that recovers
mid-turn should be used again immediately, and a table should not be silently migrated onto
another model for the rest of a scene), but it means a configured fallback is not a
substitute for fixing the primary. If turns have gone slow, check the primary rather than
assuming the fallback absorbed it.

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

**Deleting a provider deletes its fallback too**, at either scope, so no stored credential
outlives the action you took to remove it. Deleting the *fallback* leaves the primary
untouched — the dependency runs one way, since a fallback with no primary would never serve a
turn anyway.

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
records rather than authored prose, and combatants are campaign entities, not user
accounts. Each still has its one member-identifying field handled, but differently, because
one has a narrative fallback and the other does not:

- A dice roll's roller display name *is* redacted for a roller who has not consented,
  falling back to the in-fiction character name — campaign canon the DM owns — or
  "Unknown". The roll itself (and the character name) is always kept either way.
- An encounter event's acting member's account id (`performedBy.userId`) carries no
  narrative value a recap ever uses — nothing renders it — so it is stripped
  unconditionally,
  regardless of consent, rather than redacted per member. The mechanical trail itself
  (round, type, combatant/character names, damage/heal/condition detail) is never dropped:
  gating it on consent would gut recap quality for exactly the fights a recap is about,
  for no privacy gain, since none of it identifies a member's real account.

**Who can see a member's consent state.** The DM sees every member's, because they need it
to understand why a recap withheld material. Each member sees their own. Other players do
not — consent is a personal preference in a way that a role is not.

**Provenance never records the server-default endpoint URL.** The admin-managed server
provider config is hidden from campaign DMs by design, and recap provenance is DM-readable,
so only the endpoint *scope* (`server`) is stored for it. A per-campaign endpoint URL is
kept, since the DM configured it and can already read it back.
