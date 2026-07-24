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
  initiative modifier come straight from the statblock. A linked monster also has
  an expandable **Statblock** on its combat card. Open5e entries include traits,
  actions, reactions, legendary actions, and structured recharge/attack/save details
  alongside their complete source descriptions.
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

## The battle map (VTT)

Attach a map image to an encounter and the run-session screen becomes a lightweight
**virtual tabletop**: combatant tokens on a grid, distance measurement, area-of-effect
templates, and fog of war — all shared live over SSE, so every player's device shows
the same board.

### Generate a map

Don't have an image? Beside the upload dropzone the **Get a map** panel offers a
**✨ Generate a map** button — Campfire's first-party procedural generator. It's offline,
license-clean, and reproducible.

1. Pick a **kind** (dungeon, cave, wilderness), **size**, **complexity**, and **theme**.
   Under **Advanced** you can set (and copy) a **seed** — the same seed always produces the
   exact same map.
2. A large **preview** renders straightaway. This preview does **not** attach the map or
   reveal anything, and **Regenerate** rerolls to a new candidate — previewing and
   rerolling never leave stray maps behind or use your storage quota.
3. **Use this map** attaches the map to the encounter and aligns the VTT grid/scale in one
   step. **Download** saves the SVG; **Copy seed** keeps the recipe to reproduce it later.

The generated map is saved **DM-only** (hidden from the player Handouts card) with an
aligned grid, then Campfire walks you through the next steps: **check the grid**, **set
fog**, and **place tokens**.

!!! note "API vs. workflow"
    The generator engine has shipped for a while as REST endpoints
    (`POST /campaigns/:id/maps/generate`, `POST /encounters/:id/generate-map`) and the
    `generate_map` MCP tool an AI DM can call. This wizard is the **human** workflow over
    those same endpoints — the map you preview and the map you attach are byte-identical,
    because "Use this map" replays the previewed seed through the same generate call.

### Add a map & move tokens

As DM, drop an image on the **Battle map** panel (or click to choose one), or **generate**
one (above). Attaching a map makes it visible to the whole party. Each combatant becomes a
**token**; drag one
to move it. The DM can move any token, a **player only their own character's**. Click an
**unplaced** token to drop it at the centre, then position it. Token **size**
(tiny → gargantuan) scales the footprint — set it from a combatant's controls; it's a
display footprint only and doesn't touch combat math.

### Grid, scale & snapping

Open **Grid & fog** to configure the overlay:

- **Grid** on/off and **cell %w** — the cell edge as a percent of the map's width.
- **Scale** + **unit** — the real-world size of one cell (e.g. `5` `ft`), which drives
  the measurement readout.
- **Snap** — drops a moved token to the nearest cell centre.
- **Type** — **square** (classic) or **hex** (a pointy-top hexagonal overlay for
  hex-crawl and wilderness maps).

### Measure distance

Pick the **Measure** tool and click-drag on the map: it reads out the straight-line
distance in **squares and feet** (using the grid scale). The ruler stays on screen after
you release so you can read it. Measurement needs a grid scale set first.

### Area-of-effect templates

With a grid scale set, the DM can add shared **AoE templates** from the toolbar:

- **Circle** — a radius burst (e.g. *fireball*).
- **Cone** — a 5e-style cone (e.g. *burning hands*).
- **Line** — a straight ray (e.g. *lightning bolt*).

Every template lives in the encounter, so **all clients see the same shapes** (they're
not private to your screen). Drag a template's handle to reposition it; click it to edit
its **size** (radius or length in feet) and, for cones and lines, its **angle**. Remove
it when you're done.

### Ping the map

Anyone at the table can pick the **Ping** tool and click a spot to flash a **ping** —
a short pulse everyone sees at once. It's transient (nothing is saved); use it to say
"*here*" without moving a token.

### Fog of war

Toggle **Fog** on and the map goes dark for players; the DM sees through it dimmed for
prep. Reveal the board as the party explores:

- **Reveal** tool — click-drag a rectangle to reveal that region to players.
- **Reveal all** / **Hide all** — light or re-hide the whole map at once.

Fog is **information-safe** at both layers. A combatant token sitting in an unrevealed
area is withheld by the server, so a player's client never receives where the ambush is
waiting. The map image is also rendered on the server for each fog revision: players
receive an opaque image containing only revealed pixels, never the source attachment.
Opening the attachment URL, requesting its thumbnail or a byte range, and stale offline
caches cannot bypass the mask. (An AI DM can reveal regions too, via the
`reveal_map_region` MCP tool.)

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
