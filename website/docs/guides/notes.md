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

!!! tip "Let an AI sweep it"
    Connect an AI (see [Connect an AI](../ai/connect.md)) and ask it to sweep the
    inbox — it can read the captures and propose the quest/NPC/recap updates for you
    to approve, turning a pile of one-liners into structured canon.

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
