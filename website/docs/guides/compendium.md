# The compendium (rules)

The compendium is a searchable library of rule content — monsters, spells, magic
items, and conditions — that a DM can look up and drop straight into play.

## Installing content

Rule packs install under **Admin → Rule systems**. Installing is open to a **server
admin _or_ the DM of any campaign** — packs are server-wide, so a DM setting up their
table can add content without a server-admin round-trip. (Removing a pack stays
server-admin only, since it affects every campaign that selected it.)

The built-in source is **Open5e** (the D&D 5e SRD, open-licensed): tick the sections
you want — **Conditions**, **Monsters**, **Magic items**, **Spells** — and install.
Every install runs as a **background job**: the screen shows per-section progress
while it works, so you can keep building. Installs are also **incremental** — add a
section later and it merges in without reinstalling what's already there.

### Upload another system

Beyond Open5e, you can **upload a generic open-licensed dataset** for any system as a
JSON rule pack. The pack must declare an **open license** (OGL, ORC, Creative Commons,
or public domain) — anything else is rejected before the import starts. Uploads run as
the same kind of background job as an Open5e install.

!!! note "Which systems?"
    D&D 5e (via Open5e) has a built-in one-click importer; any other system comes in
    through an uploaded dataset. Content installs server-wide, and a campaign points at
    it via its rule system.

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
