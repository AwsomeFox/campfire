# Reality check: run · play · maintain

An honest, workflow-first audit of Campfire from the three seats that matter — the
**DM** who runs a campaign, the **player** who plays in it, and the **admin** who
keeps the server alive. Each step is marked ✅ works · 🟡 rough · ❌ missing.
This is the "what would I actually need?" pass, grounded in what's really built.

---

## 👑 The DM — "run the campaign"

| Step | State | Notes |
|---|---|---|
| Create a campaign | ✅ | Guided wizard, become DM automatically |
| Choose a rule system | ✅ | A DM (not just an admin) can install a rule pack — D&D 5e (Open5e), Pathfinder 2e, or Open Legend live in one click; other systems via mirror URL or an uploaded open-licensed dataset — as a background job |
| Get my players in | ✅ | Generate an **invite link / join code** from **Members → Invite** (per role, expiring, revocable); the player opens it, creates their own account, and lands in the campaign — no admin needed |
| Set the table's safety expectations (session zero) | ✅ | A **session-zero charter** — lines & veils, agreed safety tools, house rules, tone — that the whole table reads and the DM edits |
| Build the world (quests/NPCs/locations/map) | ✅ | Full CRUD, DM secrets, pin map, uploaded map image |
| Plan the story ahead (arcs / beats / branches) | ✅ | A DM-only **Storylines** planner: arcs group ordered beats, beats carry labelled branches toward other beats |
| Track in-world time | ✅ | A **Timeline** of dated in-fiction events (free-text dates, eras, DM secrets, hideable) plus a "current in-world date" |
| Reuse prep (templates / clone a campaign / import a module) | 🟡 | **Clone** a campaign in full or as a prep-only **template**, and **import** a Campfire JSON export (round-trips the export, e.g. moving a campaign between servers) — but no published-adventure/module import |
| Prep an encounter ahead of time | ✅ | "Preparing" state, add monsters from compendium |
| Run combat at the table | ✅ | Initiative, turns, HP (incl. temp HP and 5e death saves), conditions, dice, add several identical monsters at once, HP writes back to sheets |
| See changes live on my players' devices | ✅ | Combat streams over **SSE** (instant); the dashboard, quest board, party HP and notes refresh on a ~5s poll that pauses when the tab is hidden |
| Award XP / level the party | ✅ | XP tracking with 5e thresholds, party-wide DM awards, and a guided level-up (level +1, new max HP, damage carried over) |
| Hand out loot / track the party's gold | ✅ | Party treasury (coin) and per-character inventory items |
| Write the session recap | ✅ | Manually, or ask an AI to draft it; record per-session **attendance** (which characters played) |
| Sweep the scribe inbox into canon | ✅ | Player notes → quests/NPCs, or let an AI propose the edits |
| Schedule the next session | ✅ | Set a date with player **RSVPs** and a public **ICS feed** subscribers can add to their calendar |
| Let an absent player catch up | ✅ | **Notifications** (recap posted, next session) plus a **read-only recap share link** to send a guest |
| Pause / complete / archive a campaign | ✅ | A real read-only **"completed"** state, enforced server-wide (not just cosmetic) |
| Hand off to a co-DM | ✅ | Add another member as `dm`; multiple DMs supported; the last DM is protected |
| Delete a campaign | ✅ | Cascades cleanly (children, uploads, tokens, members) |

**Biggest DM gaps:** combat depth (concentration, legendary/lair actions, mechanical
conditions) is shallow — fine for a tracker, a limit for crunchy tables — and there's
no published-adventure/module import. (XP, loot, scheduling, a real archive state, live
combat, and getting players in without the admin have all since landed.)

---

## 🎲 The player — "play the campaign"

| Step | State | Notes |
|---|---|---|
| Get an account | ✅ | Open a DM's **invite link** and create my own account, or self-register if the admin turned on **self-service signup** (an admin can still hand-create it) |
| First login with nothing assigned | ✅ | The hub tells me to ask my DM to add me (no dead-end "create a campaign" trap) |
| Join a campaign | ✅ | Follow the DM's invite link to self-join with the role they set, or the DM adds me by username |
| Make my character | ✅ | Create my own (and keep more than one — a backup PC, a familiar), or the DM links one to me; I can delete a character I own |
| Fill in the full sheet | ✅ | HP, conditions, stats, bio, portrait — plus saving throws, skills, actions, and spell slots |
| Import my D&D Beyond character | ✅ | Paste a **public** D&D Beyond sheet's id or URL and it imports (unofficial, read-only; the sheet must be set to Public) |
| Play at the table on my phone | 🟡 | Mobile nav works, but live combat is two taps into "More" and the "Live" chip only shows on the dashboard |
| Tick objectives / edit my HP & conditions / roll dice | ✅ | All allowed for players; dice now on the dashboard too |
| Take notes (private / to DM / to party) | ✅ | Three visibility levels, anchored to any entity |
| Level up | ✅ | A guided level-up from the sheet's Experience card; I can see XP progress toward the next 5e threshold |
| Read recaps & shared notes between sessions | ✅ | Everything's there when I log in |
| Get told when something happens | ✅ | An in-app **notification bell** — new recap, a reply to my note, "you were added," next session |
| Reset my own password if I forget it | 🟡 | I can file a **forgot-password request**; since the server may have no mail transport, an admin approves it and relays a one-time reset code — no fully self-serve email reset yet |

**Biggest player gaps:** live combat is a couple of taps deep in mobile nav.
(Notifications, full sheet depth, XP visibility, a public D&D Beyond sheet import,
owning multiple characters, account entry, and self-service password recovery have all
since landed.)

---

## 🛠️ The admin — "maintain the server"

| Step | State | Notes |
|---|---|---|
| Install it | ✅ | One image, one volume; first visit creates the admin account |
| Create player/DM accounts | ✅ | Admin → Users one at a time, **or** let DMs bring their own via invite links, **or** flip on the **self-service signup** toggle. (Still no bulk import) |
| Turn on SSO | ✅ | Configure OIDC from **Admin → OIDC single sign-on** with a **Test connection** check — no restart — or via env vars; env values win and are badged in the UI |
| Recover a forgotten password | 🟡 | Users can file a self-service request; since there's no mail transport I approve it and relay a one-time reset code (or still reset directly from Admin → Users) |
| Install rule content | ✅ | A **per-source picker**: D&D 5e (Open5e), Pathfinder 2e and Open Legend live in one click; Pathfinder 1e, Starfinder, 13th Age and OSR from a mirror URL or upload — installed as a **non-blocking background job** with per-section progress; a **DM can self-serve** (uninstall stays admin-only) |
| Back up the server | ✅ | Copy `/data`, **or** pull a WAL-safe whole-server archive (DB via `VACUUM INTO` + all uploads) from `GET /api/v1/backup`, restore it with `POST /api/v1/backup/restore`, and optionally schedule on-disk backups (`BACKUP_SCHEDULE_ENABLED`). Per-campaign JSON/Markdown export also exists |
| See how the server is doing | ✅ | The **Admin overview** (`/admin`) shows a metrics snapshot — entity counts, on-disk DB size, uptime, running version, and recent activity |
| Audit admin actions | ✅ | A **server-wide audit** (**Admin → Audit**, `/admin/audit`) of admin actions not tied to a campaign — account creation, settings changes, pack installs — alongside the per-campaign log |
| Manage storage | ✅ | A **storage console** (**Admin → Storage**, `/admin/storage`): total upload bytes, per-campaign **quotas** with over-quota flags, the real on-disk total, and an orphan summary for cleanup |
| Review who has API/AI tokens | ✅ | Users manage their own tokens, and an admin can **list and revoke** another user's tokens (and mint one on their behalf) |
| Upgrade | ✅ | Bump the image tag; migrations auto-run and are idempotent; `/data` carries across |
| Keep admin power separate from campaign secrets | ✅ | A server admin holds no implicit campaign role — DM secrets (and the campaign list itself) require an actual membership; server power ≠ story access |

**Biggest admin gaps:** none of the historical big ones remain — observability (the
Admin overview metrics), the server-wide audit trail, storage management, and
backup/restore have all since landed, as have the self-service account flows
(invites/signup/reset). What's left is polish: no bulk user import, and password
recovery still needs an admin to relay the reset code (no built-in mail transport).

---

## The through-line

The historical themes that once cut across all three seats have now shipped:
**between-session engagement** (notifications and shareable recap links — the app now
speaks up when you're not looking at it), **account lifecycle** (invites, optional
self-signup, self-service password reset — see
[Admin vs DM](../administration/access-model.md)), the **operator-confidence**
backup/restore story (see [Backups & upgrades](../administration/operations.md)), and
**operator observability** (the Admin overview metrics, a server-wide audit trail, and
the storage console).

What's left is depth rather than whole missing seats: crunchier combat mechanics,
smoother mobile live-combat nav, published-adventure import, and maturing the still
**experimental** AI Dungeon Master seat (co-DM / driver — see
[What an AI can do](../ai/capabilities.md)).

Everything here feeds the [Roadmap & status](roadmap.md); the items already being
built are marked 🔨 there.
