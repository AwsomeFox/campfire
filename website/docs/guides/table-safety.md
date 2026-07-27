# Table safety: the X-Card

Session zero lets a table write down the safety tools it has agreed to use. This is the tool
itself: **one button that stops play immediately**, available to everyone at the table, on every
page, at all times.

## What it does

Press **Pause the table** (or `Ctrl/Cmd + Shift + X`) and, instantly:

- **Encounter advancement stops.** Start, next turn, end turn, undo turn and applying an action's
  damage all refuse until the hold is resolved.
- **The AI DM freezes.** It stops accepting input, the narration it is *currently streaming* is
  cut off mid-sentence, and any tool calls it had already asked for are never dispatched.
- **Everyone is told**, on the shared display too. The message names no reason and — unless you
  chose otherwise — no person.

## The rules that are not negotiable

**Anyone can activate it.** Not "any player" — anyone in the campaign, including a viewer with no
character sheet. There is no role check.

**No reason is required.** There is no field to type one into. The server rejects a request that
tries to include one.

**There is never a vote.** The table is paused the moment the first request lands. Campfire has a
table-vote mechanism for disputing the AI's rulings; this is deliberately not it.

**Pressing it twice is fine.** Two people activating at the same instant both succeed, and the
table pauses once. Nobody gets an error at the moment they were trying to stop the game.

**Only a facilitator resolves it.** That asymmetry is what makes it safe to leave the button
unguarded: a hold is cheap to raise and cannot be quietly undone by whoever raised it — or by
whoever would rather it had not been.

## Anonymity, and its limits

Activation is **anonymous by default**. Tick *Include my name* if you want to be named.

An anonymous hold is anonymous in a real, structural way, not a cosmetic one:

- No user id or name is stored. There is no database column holding it, so there is nothing for a
  future feature to accidentally expose.
- The audit entry is written under a synthetic actor and, unlike every other audit row, carries no
  request correlation id — so it cannot be joined back to anything else you did.
- The live event pushed to every browser contains only "the table is paused". It is byte-identical
  for an anonymous and a named hold.
- The notification goes to **everyone, including the person who raised it**. Campfire normally
  skips notifying whoever caused an event; here that would have made the one person without a
  notification the obvious suspect.

**What it does not hide.** Be honest with your table about these:

- **Whoever runs the server.** Reverse-proxy access logs and the application's own request log
  record the authenticated user behind every HTTP request. Anonymity here is anonymity from the
  *table*, not from the operator, and self-hosting means someone at your table may be the operator.
- **A very small table.** At a two-person table, an anonymous hold the facilitator did not raise
  was raised by the other person. No amount of server-side design fixes arithmetic.
- **The shape of the moment.** People notice who reached for their phone.

If genuine anonymity from your operator matters, an out-of-band signal — a physical card on the
table — remains the stronger tool. This feature exists to make the *software* stop, and to make
that stop reliable and durable.

## Resolving a hold

Talk first. Then the facilitator opens **Resolve** and picks how the table moves on:

| Recovery | What it means |
| --- | --- |
| **Resume** | Pick up where we stopped. |
| **Rewind** | Undo that beat and play it differently. |
| **Veil** | The content stays in the fiction but moves off-screen. |
| **Change the scene** | Cut away. |
| **End** | Stop the session here. |

Choosing **Veil** offers a text box. What you type is appended to your session-zero charter's
veils — so the stop actually changes what the table plays going forward, including for the AI,
which reads that same charter into every prompt.

**Only *Resume* restarts the AI seat.** The other four leave it paused, because in all of them you
are about to change the fiction and the AI must not narrate into the gap before you have. Resume it
from the AI Table when you are ready.

## Durability and its boundaries

**A hold survives a server restart.** If Campfire is redeployed in the middle of a stopped session,
the table comes back stopped and the AI seat comes back frozen. This is deliberate: a deploy
quietly un-pausing a table that stopped for safety is the worst failure this feature could have.

**A disconnected participant cannot activate it.** This is a real limit, not an oversight. The
button is an HTTP request; if your laptop is asleep, your Wi-Fi has dropped, or the tab is in a
browser that has suspended it, pressing it does nothing until you reconnect. Campfire has no
offline write queue and deliberately does not fake one here — a safety tool that *appears* to have
fired but has not is worse than one that visibly fails. **Say it out loud.** The software is a
convenience layered on top of the table talking to each other, and it always was.

**The shared display is one-way.** A cast screen shows the pause but cannot raise one — a TV on a
share link has no member identity to act as. Raise it from a phone or laptop that is signed in.

**Other clients keep working.** The hold is server-side state, so a second browser, a phone, and
the DM's laptop all see it within a second or two — pushed live, and re-checked on a timer in case
the live connection has silently died.

## What is *not* frozen

Editing HP, adjusting conditions, taking notes, and **ending the encounter** all still work. A
facilitator tidying the board or closing a fight down is part of recovering from a stop, not part
of play continuing. A hold that trapped the table inside a running combat would be worse than no
hold at all.
