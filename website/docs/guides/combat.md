# Combat & the run-session screen

Campfire's combat tracker turns a fight into a shared, live screen: initiative
order, whose turn it is, HP, and conditions — with damage syncing back to character
sheets when it's over.

## Create the encounter

From a campaign, open **Encounters → New encounter** and name it. The moment it's
created, **every party character is added as a combatant automatically**, with
initiative modifiers derived from their DEX. The encounter starts in the
**Preparing** state, so you can set it up before the table needs it.

## Add monsters (and anyone else)

On the run-session screen, **Add combatant** offers three tabs:

- **Compendium** — search the installed rule pack (e.g. a Goblin); its HP and
  initiative modifier come straight from the statblock.
- **Manual** — type a name, HP, and init mod for a homebrew creature.
- **Party** — add a late-joining character.

Adding a monster, you can set a **count** to drop several identical creatures in at
once — they come in auto-numbered (*Goblin 1*, *Goblin 2*…) so they stay distinct. A
DM can **rename** any combatant or fix its max HP / init mod afterwards without
deleting and re-adding it.

## Run the round

1. **Roll initiative** — fills initiative for everyone who doesn't have one yet
   (d20 + modifier). You can also set values by hand.
2. **Start** — sorts by initiative and begins round 1, highlighting the current turn.
3. **Next turn** — advances the highlight; wrapping around bumps the round counter.
4. **Deal damage / heal** — the ± buttons on each combatant adjust HP (clamped at 0
   and max). As DM you can edit anyone; a **player can adjust only their own
   character's** HP and conditions.
5. **Temporary HP** — a separate pool that soaks damage *before* real HP; it doesn't
   stack (you take the higher of the two) and isn't capped by max HP.
6. **Death saves** — when a player character drops to 0 HP they start **dying**;
   track their death-save successes and failures (0–3 each). Three successes →
   stable; three failures → dead. Healing above 0 clears the counters automatically.
   A single hit that overflows past 0 by the character's whole max HP is **overkill** —
   instant death, no saves. (Monsters just go down at 0.)
7. **Conditions** — add and remove condition tags on any combatant.

Rolls from the **dice widget** on the screen, and everyone's turn actions, keep the
fight moving.

## End the encounter — HP writes back

Click **End**. The encounter closes and each **character combatant's current HP is
written back to their sheet**, so the party carries their wounds out of the fight.
Ending is guarded — you can't end a fight that isn't running, or revive an ended one.

## At the table on a phone

Players can pull the encounter up on their own devices; the run-session and player
displays **stream live over SSE**, so damage, turns and conditions show up the moment
you make them (with a refetch to catch up if the stream drops). The dice log is shared
by the whole table — every member's rolls appear in the same feed, with the roller's
name, on every device.

!!! tip "Depth"
    The tracker covers initiative, turns, HP (including temp HP and the 5e death-save
    lifecycle), and condition tags. The *mechanical* effects of conditions,
    concentration, and legendary/lair actions still aren't modelled — it's a tracker,
    not a rules engine. See the [roadmap](../reference/roadmap.md).
