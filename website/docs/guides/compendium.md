# The compendium (rules)

The compendium is a searchable library of rule content — monsters, spells, magic
items, and conditions — that a DM can look up and drop straight into play.

## Installing content

A **server admin** installs rule packs under **Admin → Rule systems**. Today the
source is **Open5e** (the D&D 5e SRD, open-licensed). Tick the sections you want —
**Conditions**, **Monsters**, **Magic items**, **Spells** — and install. Conditions
are near-instant; the full monster and spell lists take up to a minute each.

Installs are **incremental**: add a section later and it merges in without
reinstalling what's already there.

!!! note "Which systems?"
    Only Open5e / D&D 5e SRD is wired today. Multi-system support (e.g. Pathfinder
    via uploaded datasets) is on the [roadmap](../reference/roadmap.md). Content
    installs server-wide and a campaign points at it via its rule system.

## Using it

- **Compendium** screen — search by name, filter by type, open an entry in the
  reader.
- **In combat** — the *Add combatant → Compendium* tab searches monsters and pulls a
  creature's HP and initiative modifier from its statblock automatically (see
  [Combat](combat.md)).
- **Over MCP** — an AI assistant can `lookup_rule` and `get_rule_entry` to cite rules
  and build encounters (see [Connect an AI](../ai/connect.md)).

## Licensing

Campfire only imports **open-licensed** content (Open5e is OGL/Creative Commons).
Your own homebrew and anything you type in stays in your database.
