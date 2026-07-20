# Running a game

The lived loop of an actual session — before, during, and after — from the DM's
seat, with what players do alongside.

## The dashboard is home base

Opening a campaign lands you on the **dashboard**, which gathers everything at a
glance: the **status header** (session number, danger level, current location), the
**world map**, the **quest board**, the **party** (with HP bars), **NPCs**, the
**session log**, a **dice widget**, and your **notes**. A **Live · Round N** chip
appears here whenever an encounter is running, linking straight into it.

## Before the session — prep

Prep is just building world entities ahead of time (see
[Quests, NPCs & the world](world.md)):

- Draft the **quests** you expect to come up, with objectives and DM secrets.
- Line up **NPCs** with dispositions and hidden motives.
- Place the session's **locations** on the map.
- Optionally **build an encounter in advance** — create it, add monsters from the
  compendium, and leave it in the *Preparing* state until the fight starts (see
  [Combat](combat.md)).
- Jot plans in **DM-shared or private notes** — these are your backstage.

## During the session — at the table

- **Narrate and update as you go.** Reveal locations (discovery status), flip quest
  statuses, tick objectives, edit NPC dispositions as relationships change.
- **Run fights** on the run-session screen — initiative, turns, damage, conditions,
  with HP writing back to character sheets when the encounter ends.
- **Roll dice** from the dashboard widget or inside combat; players roll their own,
  and everyone sees the same shared roll feed.
- **Players drive their own characters** — HP, conditions, ticking objectives — and
  keep notes. What they can't touch is DM canon or anyone else's character.
- **Danger level** lives in the DM's status-header edit form, so it changes
  deliberately, not by accident.

Players on their own devices see updates shortly after you make them. Combat updates
push instantly (the run-session screen and player display stream live), and the other
shared surfaces — dashboard, quest board, party HP, and notes — refresh on a ~5s poll
while the tab is open. Backgrounded tabs pause polling to spare the server, then catch
up the moment you switch back.

## After the session — the recap

1. **Write the recap.** Open **Sessions → Add recap** (auto-numbered) and summarise
   what happened — or connect an AI and ask it to draft one (see
   [Connect an AI](../ai/connect.md)).
2. **Sweep the scribe inbox.** Players drop quick notes during play; resolve them
   into quests, NPCs, and updates (see [Notes & the scribe inbox](notes.md)).
3. **Review proposals.** If an AI or a player proposed canon changes, approve or
   reject them from **Proposals**.

## Between sessions

Players log in to reread recaps and shared notes and to keep planning their
characters. As DM you keep prepping the next beats. _(Notifications and a shareable
read-only recap link for absent players are on the
[roadmap](../reference/roadmap.md); today catching up means logging in.)_

## XP & levelling up

After an encounter or a session, award XP from the **Party** page (**✦ Award XP**,
DM only — every character gets the amount) or from a character sheet's
**Experience** card (owner or DM, any amount, even negative to fix a mistake).
The sheet shows progress toward the next D&D 5e threshold and flags the character
when the XP qualifies for the next level.

When it's time to level, hit **⬆ Level up** on the sheet's Experience card: it
bumps the level by one and asks for the new max HP — the hit points gained are
added to current HP too, so damage taken carries over. The flow is deliberately
not gated on XP, so milestone campaigns can level whenever the story says so.
The **Edit** form still exposes raw level/XP/HP max as an escape hatch.
