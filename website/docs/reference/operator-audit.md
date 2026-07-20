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
| Choose a rule system | ✅ | A DM (not just an admin) can install a rule pack — Open5e, or an uploaded open-licensed dataset — as a background job |
| Get my players in | ✅ | Generate an **invite link / join code** from **Members → Invite** (per role, expiring, revocable); the player opens it, creates their own account, and lands in the campaign — no admin needed |
| Build the world (quests/NPCs/locations/map) | ✅ | Full CRUD, DM secrets, pin map, uploaded map image |
| Plan the story ahead (arcs / beats / branches) | ✅ | A DM-only **Storylines** planner: arcs group ordered beats, beats carry labelled branches toward other beats |
| Track in-world time | ✅ | A **Timeline** of dated in-fiction events (free-text dates, eras, DM secrets, hideable) plus a "current in-world date" |
| Reuse prep (templates / clone a campaign / import a module) | 🟡 | **Clone** a campaign in full, or as a prep-only **template** — but no published-adventure/module import |
| Prep an encounter ahead of time | ✅ | "Preparing" state, add monsters from compendium |
| Run combat at the table | ✅ | Initiative, turns, HP, conditions, dice, HP writes back to sheets |
| See changes live on my players' devices | ✅ | Combat streams over **SSE** (instant); the dashboard, quest board, party HP and notes refresh on a ~5s poll that pauses when the tab is hidden |
| Award XP / level the party | ✅ | XP tracking with 5e thresholds, party-wide DM awards, and a guided level-up (level +1, new max HP, damage carried over) |
| Hand out loot / track the party's gold | ✅ | Party treasury (coin) and per-character inventory items |
| Write the session recap | ✅ | Manually, or ask an AI to draft it |
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
| Make my character | ✅ | Create my own, or the DM links one to me |
| Fill in the full sheet | ✅ | HP, conditions, stats, bio, portrait — plus saving throws, skills, actions, and spell slots |
| Import my D&D Beyond character | ❌ | The `ddbId` field exists but there's no importer |
| Play at the table on my phone | 🟡 | Mobile nav works, but live combat is two taps into "More" and the "Live" chip only shows on the dashboard |
| Tick objectives / edit my HP & conditions / roll dice | ✅ | All allowed for players; dice now on the dashboard too |
| Take notes (private / to DM / to party) | ✅ | Three visibility levels, anchored to any entity |
| Level up | ✅ | A guided level-up from the sheet's Experience card; I can see XP progress toward the next 5e threshold |
| Read recaps & shared notes between sessions | ✅ | Everything's there when I log in |
| Get told when something happens | ✅ | An in-app **notification bell** — new recap, a reply to my note, "you were added," next session |
| Reset my own password if I forget it | 🟡 | I can file a **forgot-password request**; since the server may have no mail transport, an admin approves it and relays a one-time reset code — no fully self-serve email reset yet |

**Biggest player gaps:** a D&D Beyond character import is still missing, and live
combat is a couple of taps deep in mobile nav. (Notifications, full sheet depth, XP
visibility, account entry, and self-service password recovery have all since landed.)

---

## 🛠️ The admin — "maintain the server"

| Step | State | Notes |
|---|---|---|
| Install it | ✅ | One image, one volume; first visit creates the admin account |
| Create player/DM accounts | ✅ | Admin → Users one at a time, **or** let DMs bring their own via invite links, **or** flip on the **self-service signup** toggle. (Still no bulk import) |
| Turn on SSO | ✅ | Configure OIDC from **Admin → OIDC single sign-on** with a **Test connection** check — no restart — or via env vars; env values win and are badged in the UI |
| Recover a forgotten password | 🟡 | Users can file a self-service request; since there's no mail transport I approve it and relay a one-time reset code (or still reset directly from Admin → Users) |
| Install rule content | ✅ | Open5e (D&D 5e SRD) or an uploaded open-licensed dataset, installed as a **non-blocking background job** with per-section progress; a **DM can self-serve** (uninstall stays admin-only) |
| Back up the server | ✅ | Copy `/data`, **or** pull a WAL-safe whole-server archive (DB via `VACUUM INTO` + all uploads) from `GET /api/v1/backup`, restore it with `POST /api/v1/backup/restore`, and optionally schedule on-disk backups (`BACKUP_SCHEDULE_ENABLED`). Per-campaign JSON/Markdown export also exists |
| See how the server is doing | ❌ | No admin dashboard — no user/campaign counts, storage usage, version, or update-available indicator |
| Audit admin actions | ❌ | Audit logs are **per-campaign** (DM-visible); there's no server-wide log of account creation, settings changes, or pack installs |
| Manage storage | ❌ | Uploads accumulate with no size visibility, quota, or orphan cleanup |
| Review who has API/AI tokens | ✅ | Users manage their own tokens, and an admin can **list and revoke** another user's tokens (and mint one on their behalf) |
| Upgrade | ✅ | Bump the image tag; migrations auto-run and are idempotent; `/data` carries across |
| Keep admin power separate from campaign secrets | ✅ | A server admin holds no implicit campaign role — DM secrets (and the campaign list itself) require an actual membership; server power ≠ story access |

**Biggest admin gaps:** server observability (no admin dashboard / usage counts) and a
server-wide audit trail. (Backup/restore and self-service account flows —
invites/signup/reset — have since landed.)

---

## The through-line

One theme still cuts across the three seats and is the highest-leverage thing to
close before Campfire is a no-caveats "go-to platform":

1. **Operator observability** — an admin dashboard (usage/version/update indicators)
   and a server-wide audit trail, so an admin can *see* what the server is doing.

The historical themes have since shipped: **between-session engagement**
(notifications and shareable recap links — the app now speaks up when you're not
looking at it), **account lifecycle** (invites, optional self-signup, self-service
password reset — see [Admin vs DM](../administration/access-model.md)), and the
**operator-confidence** backup/restore story (see
[Backups & upgrades](../administration/operations.md)).

Everything here feeds the [Roadmap & status](roadmap.md); the items already being
built are marked 🔨 there.
