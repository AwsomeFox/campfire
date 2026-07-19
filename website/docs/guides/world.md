# Quests, NPCs & the world

The DM's world-building tools. All of these support markdown and carry a **DM-only
secret** field that players never see.

## Quests

Open the **Quests** board and **New quest**. A quest has:

- **Title** and a markdown **body**.
- **Status** — available → active → completed / failed.
- **Objectives** — a checklist. Players can tick objectives; only the DM edits their
  text.
- **Subquests** — nest a quest under a parent to build a tree. (Deleting a parent
  promotes its subquests to top level rather than orphaning them.)
- **Giver NPC** and a **reward**.
- **DM secret** — the twist behind the quest, hidden from players.

The dashboard quest card shows the tree inline with tickable objectives.

## NPCs

**New NPC** captures a **role** (Townmaster, Merchant…), a **disposition**, a home
**location**, a markdown body, and a DM secret. NPCs linked as a quest giver show up
on that quest, and NPCs placed at a location show up there.

## Locations & the map

Locations are places — towns, dungeons, regions — with a **kind**, a **status**
(unexplored → explored → current), and a body plus DM secret.

- **Pin map** — locations plot onto the campaign's map. By default that's a stylised
  canvas; the DM can **upload a real map image** and place pins on it by dragging.
- **Discovery** — advance a location's status as the party finds it; setting one to
  *current* updates the campaign's current-location header.

## How it fits together

Quests reference their giver NPC; NPCs reference their location; the dashboard
stitches all three into one view. Because every entity has a DM-secret field that's
stripped server-side, you can prep the truth behind the curtain and reveal it at your
pace — the players' view only ever shows what they've earned.
