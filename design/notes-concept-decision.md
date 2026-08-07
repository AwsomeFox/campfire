# Decision record: is "notes" one overloaded concept? (issue #1784)

**Status:** decided — no schema/data change. **Date:** 2026-08-07.
**Type:** architecture re-examination, per the issue's own non-goals
("no schema/data changes yet — decide the target model").

This file is a written decision, not a UI reference like the rest of `design/`.
It answers the two questions issue #1784 asked and records why, so a future
contributor doesn't have to re-derive the reasoning from source.

## The inventory

Five real surfaces use the word "notes" or the closely related "secret" idea.
Grounded in the code as of this decision:

| Surface | What it is | Where |
|---|---|---|
| `Character.notes` | Public bio/story prose field on a character sheet | `packages/schema/src/index.ts:682` |
| `Session.dmSecret` (+ same field on quests/NPCs/locations/factions) | DM-only secret prose paired with one canon entity | `packages/schema/src/index.ts:1293` (session); the same pattern recurs on NPC/quest/location/faction — see the file's own header note at `packages/schema/src/index.ts:10` |
| `notes` module | A standalone row a member writes: `Note` with `visibility ∈ {private, dm_shared, party_shared, whisper}` and `kind ∈ {note, inbox}` | `packages/schema/src/index.ts:2898-2941` (schema), `apps/server/src/modules/notes/notes.service.ts`, `apps/server/src/modules/notes/notes.controller.ts` |
| `comments` module | Threaded, always-shared discussion anchored to an entity; no per-comment visibility | `packages/schema/src/index.ts:3130` (schema), `apps/server/src/modules/comments/comments.service.ts:97-109` |
| `scribe` / `inbox-sweep` | AI services that *consume* `kind: 'inbox'` notes and file proposals from them | `apps/server/src/modules/inbox-sweep/inbox-sweep.service.ts`, `apps/server/src/modules/scribe/scribe.service.ts:363` |

### Authorization / secrecy, per surface

- **`Character.notes`** — no visibility of its own. Redaction follows the whole
  character read: hidden/foreign-campaign characters already 404 before this
  field is reached. It is a plain prose field, not a row with its own ACL.
- **`Session.dmSecret`** (and the NPC/quest/location/faction siblings) —
  stripped server-side for any non-DM reader, on every read path (get/list/
  export/MCP). This is the single `dmSecret` convention documented once at
  `packages/schema/src/index.ts:10` and reused across canon entities; it has
  nothing to do with the `notes` module below except sharing the English word
  "secret"/"notes".
- **`notes` module** — visibility is enforced in one predicate,
  `canSee()` at `apps/server/src/common/note-visibility.ts:23-36`: `private`
  → author only; `dm_shared` → author + dm; `party_shared` → everyone;
  `whisper` → author + the single recipient + any dm (oversight). Every read
  path (`GET`, list, MCP) funnels through it — see the comment at
  `apps/server/src/modules/notes/notes.service.ts:97-105` for why the
  predicate lives in `common/` rather than the notes module itself (the
  moderation module needs the identical rule). List filtering pushes the same
  rule into SQL (`notes.service.ts:390-393`) rather than post-filtering in JS.
  A `kind: 'inbox'` row is always created as `dm_shared` (`notes.service.ts:946`)
  — there is no inbox-specific visibility to reason about beyond the one the
  `notes` system already has.
- **`comments` module** — a comment carries no visibility of its own; it is
  only as secret as the entity it's anchored to. Every read/write path
  resolves the anchor and applies the ANCHOR's own visibility rule first
  (`comments.service.ts:103-108`, referencing issue #230/#42), so a comment on
  a hidden quest/NPC/faction or an unexplored location 404s exactly like the
  entity itself would.
- **`scribe` / `inbox-sweep`** — never writes canon directly. Both route their
  output through the proposal flow (`ProposalRecordsService`, imported at
  `inbox-sweep.service.ts:20`) exactly like every other AI write path in this
  codebase, so a sweep or scribe recap always lands in the DM's approval queue,
  never bypassing the propose-then-approve invariant.

## Question 1 — should the DM inbox be its own first-class concept?

**Decision: not now.** The muddiness the issue names is real but narrower than
it first looks, and splitting it would cost more than it fixes today:

- **REST and MCP already treat inbox as first-class.** `POST/GET
  /campaigns/:id/inbox` are dedicated routes distinct from `/notes`
  (`apps/server/src/modules/notes/notes.controller.ts:20-144`), and MCP mirrors
  this with separate tools — `list_notes` vs `read_inbox` /
  `submit_inbox_item` / `sweep_inbox` (`apps/server/src/modules/mcp/mcp-catalog.ts:37,62,147,149`,
  parity table at `apps/server/src/modules/mcp/mcp-rest-parity.ts:89`). A
  caller — human or AI — never has to filter one list into two; each surface
  is its own operation already. The seam the issue points at is real, but it's
  in **storage**, not in the API contract callers actually see.
- **The only place `kind` still leaks is the shared `Note` type and table.**
  `resolved`/`resolvedNote` are meaningless on a `kind: 'note'` row, and a
  `kind: 'inbox'` row never uses 3 of the 4 visibilities. That's a real
  wart, but splitting it into a second table would duplicate a nontrivial
  amount of infrastructure that both kinds currently share for free: soft
  delete/restore + trash (issue #116), revision history on the body
  (issue #157), moderation quarantine/mute/evidence capture (issue #601), and
  the notification fan-out plumbing. None of that machinery is written to be
  inbox-agnostic vs note-agnostic — it treats `kind` as an ordinary column
  the same way it treats `visibility`.
- **The concrete pain that motivated re-examining this — #1718 (bare "Note
  #id" past the first 50 swept items) — was a pagination/snapshot bug, not a
  modeling defect, and it's already fixed** (closed 2026-07-31): the server
  now returns identifying text for each swept item instead of the client
  depending on a partial snapshot. Splitting the model would not have
  prevented that bug and wouldn't undo it now.
- Per the issue's own non-goal and this repo's standing rule against
  "speculative features, generic frameworks, extension points... for
  hypothetical future requirements" (`AGENTS.md`), a real table split is only
  worth its migration risk and doubled-plumbing cost if the inbox concept
  needs to grow fields/behavior that genuinely don't belong on a note (e.g. an
  assignee, a priority, a source-channel enum). No such requirement exists
  today.

**If that changes** — the inbox needs shape a `Note` genuinely shouldn't
carry — split it then, as its own follow-up issue with a real migration plan.
Until then, the fix this decision authorizes is documentation, not code
restructuring: the `kind` seam is now called out explicitly at
`packages/schema/src/index.ts:2876-2891`, and the two "notes"-vs-"inbox" pages
are described as separate jobs sharing storage, not the other way around.

## Question 2 — are the four "notes"-shaped things necessary, or can any collapse?

**Decision: keep all four.** They are not actually the same concept wearing
different names — three of the five inventoried surfaces (`Character.notes`,
`dmSecret`, and `comments`) were never part of the `notes` system to begin
with; they only read that way because of vocabulary overlap:

- **`Character.notes` vs the `notes` module** — a naming collision, not a
  modeling one. One is a bio field that lives and dies with the character row
  (no independent lifecycle, no visibility of its own, no author distinct
  from "whoever can edit the sheet"). The other is an independent row with
  its own author, visibility, and lifecycle. Renaming the field was
  considered and rejected here: it is a schema/API-shape change, which the
  issue's own non-goals rule out ("no schema/data changes yet"), and the
  field already carries a plain doc comment ("public character bio/story") —
  now extended in this change (`packages/schema/src/index.ts:682`) to say
  explicitly that it is not a `notes`-system row.
- **`Session.dmSecret` (and NPC/quest/location/faction `dmSecret`) vs the
  `notes` module** — same story: this is the established per-entity-secret
  pattern used across canon entities, unrelated to the standalone `Note`
  entity beyond both being DM-facing prose at some point. Collapsing it into
  the `notes` module (e.g. "a session's DM secret is just a `dm_shared` note
  anchored to that session") would be a strictly worse design: it would turn
  a field with exactly one reader-visibility rule and one owner into a row
  with an independent author/visibility/lifecycle that then has to be kept in
  sync with the session it describes, for no behavioral gain. Not adopted.
- **`comments` vs the `notes` module** — these already solve genuinely
  different jobs and the code says so directly: comments are explicitly
  documented as "the shared, cross-session surface notes never were"
  (`comments.service.ts:98-99`). A note can be private; a comment cannot. A
  comment threads (`parentId`); a note doesn't. Collapsing them would force
  the `notes` module to grow threading it doesn't need, or force `comments`
  to grow four visibility levels it doesn't need — pure churn for a
  simplification issue that promised none.

**The one real overlap in this whole inventory is intra-module**: `kind:
'note'` vs `kind: 'inbox'` within the `notes` system itself, addressed above.

## What this change actually does

Per the issue's explicit fallback — "if they stay, document each one's job
clearly so contributors and users aren't guessing" — this decision ships with:

- A doc comment at `packages/schema/src/index.ts:2876-2896` naming all five
  surfaces, pointing at this file, and explaining the real (`kind`) seam vs.
  the false (field-name) ones.
- One-line pointers on `Character.notes` (`packages/schema/src/index.ts:682`)
  and `Session.dmSecret` (`packages/schema/src/index.ts:1293`) so a
  contributor grepping for `notes` lands on a note (pun intended) that these
  fields are not part of the `notes` module.
- A new "'Notes' elsewhere in Campfire" section in the user-facing guide
  (`website/docs/guides/notes.md`) explaining the same distinction for
  players/DMs, not just contributors.

No schema, migration, route, or MCP tool changed. No behavior changed.

## Follow-ups this decision did NOT file

Named here for the coordinator to file separately if wanted — not filed
automatically, since this issue's scope was the decision itself:

- If the DM inbox ever needs fields a personal note genuinely shouldn't carry
  (assignee, priority, source channel...), split it into its own table then,
  with a real migration plan — not before.
