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

## Storylines — the arc/beat planner

**Storylines** is a DM-only space for planning where the story might go, ahead of the
table. It's prep, not canon — players never see it.

- **Arcs** group the story into chapters, each with a markdown summary and a status
  (planned → active → resolved / abandoned).
- **Beats** are the ordered moments inside an arc — a scene, a reveal, a decision —
  each with markdown notes and its own status (planned → active → done / skipped).
- **Branches** are the forks: on a beat you add labelled next-options ("players side
  with the duke", "the ritual is interrupted"), each optionally pointing at the beat
  it leads to. You can sketch a branch before its destination beat even exists, so you
  can map how a session could go without committing to one path.

An AI assistant can draft and rearrange arcs and beats too (see
[What an AI can do](../ai/capabilities.md)).

## Timeline — the in-world calendar

The **Timeline** tracks *in-fiction* time, separate from when your table actually met.

- **Events** carry a free-text **in-world date** ("3rd of Flamerule, 1492 DR" —
  fantasy calendars don't fit ISO dates), markdown notes, and an optional **era**
  grouping ("Age of Chains"). The DM controls the order directly, so undated "sometime
  around here" beats still sequence sensibly.
- A per-campaign **current in-world date** and a free-text **calendar note** (month
  names, moon phases — whatever you want to remember) sit alongside the events.
- Events carry the same secrecy tools as the rest of the world: a **DM secret** field,
  and events can be **hidden** entirely from players until you reveal them.

## How it fits together

Quests reference their giver NPC; NPCs reference their location; the dashboard
stitches all three into one view. Because every entity has a DM-secret field that's
stripped server-side, you can prep the truth behind the curtain and reveal it at your
pace — the players' view only ever shows what they've earned.
