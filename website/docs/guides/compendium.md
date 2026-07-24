# The compendium (rules)

The compendium is a searchable library of rule content — monsters, spells, magic
items, and conditions — that a DM can look up and drop straight into play.

## Installing content

Rule packs install under **Admin → Rule packs** (`/admin/rules`), which has a
**per-source picker**: choose a system, tick the sections you want, and install.
Installing is open to a **server admin _or_ the DM of any campaign** — packs are
server-wide, so a DM setting up their table can add content without a server-admin
round-trip. (Removing a pack stays server-admin only, since it affects every campaign
that selected it.)

Every install runs as a **background job**: the screen shows per-section progress
while it works, so you can keep building. Installs are also **incremental** — add a
section later and it merges in without reinstalling what's already there. Reinstalling
an Open5e section refreshes its imported fields in place, so older monster entries gain
newly supported statblock details without losing their ids or manual icon choices.

### Live, one-click sources

Three systems import **live** from an official open-licensed data source — no file to
find, just pick the sections (Conditions, Monsters, Magic items, Spells… — the picker
offers whatever each source provides) and install:

- **D&D 5e SRD (Open5e)** — live import from the Open5e API.
- **Pathfinder 2e (Archives of Nethys)** — live import from the Archives of Nethys 2e
  backend.
- **Open Legend** — live import of boons, banes, and feats from the official
  Open Legend core-rules repository.

### Mirror-URL / upload sources

Four more systems are wired up but have **no reliable public API**, so the picker asks
for a **mirror URL** (a self-hosted or community copy of the open-licensed data) — or
you can bring the data yourself as a JSON upload (below):

- **Pathfinder 1e**, **Starfinder 1e**, **13th Age (Archmage Engine)**, and **OSR
  retroclones** (Basic Fantasy, OSRIC, Swords & Wizardry, Labyrinth Lord,
  Old-School Essentials).

### Upload a generic dataset

For anything else, **upload a generic open-licensed dataset** as a JSON rule pack. The
pack must declare an **open license** (OGL, ORC, Creative Commons, or public domain) —
anything else is rejected before the import starts. Uploads run as the same kind of
background job as a live install.

!!! note "Which systems?"
    D&D 5e (Open5e), Pathfinder 2e, and Open Legend install one-click and live;
    Pathfinder 1e, Starfinder, 13th Age, and OSR retroclones come in from a mirror URL
    or a JSON upload; anything else via a generic open-licensed dataset upload. Content
    installs server-wide, and a campaign points at it via its rule system.

## Using it

- **Compendium** screen — search by name, filter by type, and open an entry in
  the reader. Imported Open5e monsters show their full structured statblock,
  including traits, actions, reactions, legendary actions, recharge/per-day
  limits, attack and damage details, and saving throws when the source provides
  them. The original rules descriptions remain visible in full.
- **In combat** — the *Add combatant → Compendium* tab searches monsters and pulls a
  creature's HP and initiative modifier from its statblock automatically. Expand
  **Statblock** on its combat card to read the same traits and action sections shown
  in the compendium reader (see [Combat](combat.md)).
- **Over MCP** — an AI assistant can `lookup_rule` and `get_rule_entry` to cite rules
  and build encounters (see [Connect an AI](../ai/connect.md)).

## Search capacity & pagination

`GET /api/v1/rules/search` returns a **page**, not a silently truncated array:

```json
{ "items": [/* RuleEntry */], "total": 1234, "hasMore": true, "nextCursor": "…", "limit": 50 }
```

- **Default page size** is 50; `?limit=` may raise it up to **100**. Larger result
  sets continue with the opaque `?cursor=` from the previous page's `nextCursor`.
- **`total` / `hasMore`** are always present so clients can show “Showing 50 of 1 234”
  and a Load more control — the API never hides that more matches exist.
- **Empty-query browse** is ordered stably by name, then id (deterministic across
  multi-pack ties). Ranked search uses name-match bucket → FTS/LIKE rank → id.
- The Compendium UI load-mores in place; `?q=` / `?type=` (and optional deep-link
  `?cursor=`) stay in the URL. Filter changes clear the cursor and refetch from
  the start.

## Licensing

Campfire only imports **open-licensed** content (Open5e is OGL/Creative Commons).
Your own homebrew and anything you type in stays in your database.
