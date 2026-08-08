# Notes & the scribe inbox

Campfire has two related note systems: **personal notes** every user keeps, and the
**scribe inbox** where quick captures flow to the DM to be woven into canon.

## Personal notes

Anyone — DM, player, or viewer — can keep notes. Each note has a **visibility**:

- 🔒 **Private** — only you.
- 🎩 **Shared with DM** — you and the DM.
- 👥 **Shared with party** — everyone in the campaign.

Notes can be **anchored to an entity** — attached to a specific quest, NPC,
location, session, or character — so they show up in that entity's notes rail. Or
leave them unanchored as general campaign notes.

**Where to write them:**

- The **My Notes** screen — the full list, filterable by visibility, with a
  quick-capture box (saves private by default; change visibility per note).
- The **notes rail** on any quest / NPC / location / character page — anchored to
  that entity.
- The **quick note** box on the dashboard — a fast personal capture.

Visibility is enforced server-side: a DM genuinely cannot read a player's private
notes.

## The scribe inbox

The inbox is the DM's **triage queue** — short captures from the table that the DM
turns into real canon later.

**How items get there:** a player shares a note *with the DM*, and the DM sees it in
their queue. _(A dedicated one-tap "leave a note for the DM" inbox button on the web
is a rough edge today — see the [roadmap](../reference/roadmap.md); over the API/MCP
there's a direct `submit_inbox_item`.)_

**Resolving:** open **Scribe inbox** (DM only; a badge shows the open count). For
each item you read the capture and **resolve** it — the moment to spin it into a new
quest, update an NPC, or drop a line in a recap. Resolving clears it from the queue.

!!! tip "Sweep it instead of resolving one by one"
    Click **Sweep inbox** at the top of the Scribe inbox page — no AI client or
    token needed, just an AI provider configured for the campaign (Campaign
    settings -> AI). It reads every open item and proposes the quest/NPC/location/character
    updates for you to approve, turning a pile of one-liners into structured canon.
    Prefer your own assistant? [Connect one](../ai/connect.md) (with a direct-write DM token) and ask it to sweep
    the inbox — it calls the exact same `sweep_inbox` operation the button does.

## "Notes" elsewhere in Campfire

A few other things in Campfire are also called (or share a word with) "notes," but
they are not part of this system — each solves a different job:

- **A character's bio** (the **Notes** field on a character sheet) is free-text
  story/background prose that lives on the character itself, like its stats or
  portrait. It has one visibility (everyone who can see the character sees it) and
  no author-vs-DM split — it is not a row in the notes/inbox list above.
- **Entity DM secrets** (the `dmSecret` field present across canon entities —
  such as sessions, characters, quests, NPCs, locations, timeline events, and
  factions) are DM-only prep text that lives on that entity, redacted for
  everyone else. It is the general secrecy pattern used across canon entities, not a
  personal note someone wrote.
- **Comments** are a separate, always-shared discussion thread anchored to a quest,
  NPC, location, session, character, or campaign — closer to play-by-post chat than
  a private notebook. Every member who can see the entity sees every comment on it;
  there's no per-comment visibility the way a note has private/shared/whisper.

## List capacity & pagination

`GET /api/v1/campaigns/:id/notes` and `GET /api/v1/campaigns/:id/inbox` return a
**page**, not an unbounded array:

```json
{ "items": [/* Note */], "total": 1234, "hasMore": true, "nextCursor": "…", "limit": 50 }
```

- **Default page size** is 50; `?limit=` may raise it up to **200**. Larger result
  sets continue with the opaque `?cursor=` from the previous page's `nextCursor`.
- **Order is newest-first** (by note id for notes and open inbox; by resolution
  time for resolved inbox history).
- **Filters stay correct under paging**: `q`, `mine`, `visibility`, and
  `entityType`/`entityId` are applied before the page is cut.
- The dashboard **My notes** rail asks for exactly **5** newest notes
  (`?limit=5`) — it does not fetch the whole list and slice.
- Over MCP, `list_notes` and `read_inbox` use the same page shape and cursor.
