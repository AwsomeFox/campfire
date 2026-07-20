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
| Choose a rule system | 🟡 | Only if an **admin** already installed a pack — a DM can't install content themselves |
| Get my players in | ✅ | Generate an **invite link / join code** from **Members → Invite** (per role, expiring, revocable); the player opens it, creates their own account, and lands in the campaign — no admin needed |
| Build the world (quests/NPCs/locations/map) | ✅ | Full CRUD, DM secrets, pin map, uploaded map image |
| Reuse prep (templates / clone a campaign / import a module) | ❌ | Every campaign is built from scratch; no duplicate, no template, no published-adventure import |
| Prep an encounter ahead of time | ✅ | "Preparing" state, add monsters from compendium |
| Run combat at the table | ✅ | Initiative, turns, HP, conditions, dice, HP writes back to sheets |
| See changes live on my players' devices | 🟡 | Polling, not push — a few seconds of lag; SSE is planned |
| Award XP / level the party | ❌ | `level` is just an editable number; no XP, no level-up flow |
| Hand out loot / track the party's gold | ❌ | Lives in prose (quest reward text, recaps, notes) — no inventory or treasury |
| Write the session recap | ✅ | Manually, or ask an AI to draft it |
| Sweep the scribe inbox into canon | ✅ | Player notes → quests/NPCs, or let an AI propose the edits |
| Schedule the next session | ❌ | No "next session" date, availability, or calendar feed |
| Let an absent player catch up | 🟡 | They can log in and read the recap; no shareable read-only link for a guest |
| Pause / complete / archive a campaign | 🟡 | A `status` exists but is **cosmetic** — a "completed" campaign is still fully editable and stays in the hub with everything else |
| Hand off to a co-DM | ✅ | Add another member as `dm`; multiple DMs supported; the last DM is protected |
| Delete a campaign | ✅ | Cascades cleanly (children, uploads, tokens, members) |

**Biggest DM gaps:** XP/loot/scheduling and a real archive state. Combat depth
(concentration, legendary/lair actions, mechanical conditions) is also shallow — fine
for a tracker, a limit for crunchy tables. (Getting players in without the admin is now
solved by invite links.)

---

## 🎲 The player — "play the campaign"

| Step | State | Notes |
|---|---|---|
| Get an account | ✅ | Open a DM's **invite link** and create my own account, or self-register if the admin turned on **self-service signup** (an admin can still hand-create it) |
| First login with nothing assigned | ✅ | The hub tells me to ask my DM to add me (no dead-end "create a campaign" trap) |
| Join a campaign | ✅ | Follow the DM's invite link to self-join with the role they set, or the DM adds me by username |
| Make my character | ✅ | Create my own, or the DM links one to me |
| Fill in the full sheet | 🟡 | HP, conditions, stats, bio, portrait work; **saving throws, skills, attacks, and spell slots are "soon" placeholders** |
| Import my D&D Beyond character | ❌ | The `ddbId` field exists but there's no importer |
| Play at the table on my phone | 🟡 | Mobile nav works, but live combat is two taps into "More" and the "Live" chip only shows on the dashboard |
| Tick objectives / edit my HP & conditions / roll dice | ✅ | All allowed for players; dice now on the dashboard too |
| Take notes (private / to DM / to party) | ✅ | Three visibility levels, anchored to any entity |
| Level up | ❌ | No flow — the DM edits my level number; I can't see or earn XP |
| Read recaps & shared notes between sessions | ✅ | Everything's there when I log in |
| Get told when something happens | ❌ | **No notifications of any kind** — new recap, a reply to my note, "you were added," next session — I only find out by logging in and looking |
| Reset my own password if I forget it | 🟡 | I can file a **forgot-password request**; since the server may have no mail transport, an admin approves it and relays a one-time reset code — no fully self-serve email reset yet |

**Biggest player gaps:** notifications (the between-session engagement hole), sheet
depth, and XP visibility. (Account entry and password recovery are now self-service,
with an admin only relaying the reset code.)

---

## 🛠️ The admin — "maintain the server"

| Step | State | Notes |
|---|---|---|
| Install it | ✅ | One image, one volume; first visit creates the admin account |
| Create player/DM accounts | ✅ | Admin → Users one at a time, **or** let DMs bring their own via invite links, **or** flip on the **self-service signup** toggle. (Still no bulk import) |
| Turn on SSO | ✅ | Configure OIDC from **Admin → OIDC single sign-on** with a **Test connection** check — no restart — or via env vars; env values win and are badged in the UI |
| Recover a forgotten password | 🟡 | Users can file a self-service request; since there's no mail transport I approve it and relay a one-time reset code (or still reset directly from Admin → Users) |
| Install rule content | 🟡 | Admin-only, one system (Open5e / D&D 5e SRD), a long **blocking** import (~a minute for the full SRD) with only a busy spinner — no per-section progress, no background job, and DMs can't self-serve |
| Back up the server | ✅ | Copy `/data`, **or** pull a WAL-safe whole-server archive (DB via `VACUUM INTO` + all uploads) from `GET /api/v1/backup`, restore it with `POST /api/v1/backup/restore`, and optionally schedule on-disk backups (`BACKUP_SCHEDULE_ENABLED`). Per-campaign JSON/Markdown export also exists |
| See how the server is doing | ❌ | No admin dashboard — no user/campaign counts, storage usage, version, or update-available indicator |
| Audit admin actions | ❌ | Audit logs are **per-campaign** (DM-visible); there's no server-wide log of account creation, settings changes, or pack installs |
| Manage storage | ❌ | Uploads accumulate with no size visibility, quota, or orphan cleanup |
| Review who has API/AI tokens | 🟡 | Users manage their own tokens; an admin can't see or revoke everyone's from one place |
| Upgrade | ✅ | Bump the image tag; migrations auto-run and are idempotent; `/data` carries across |
| Keep admin power separate from campaign secrets | ✅ | A server admin holds no implicit campaign role — DM secrets (and the campaign list itself) require an actual membership; server power ≠ story access |

**Biggest admin gaps:** server observability (no admin dashboard / usage counts) and a
server-wide audit trail. (Backup/restore and self-service account flows —
invites/signup/reset — have since landed.)

---

## The through-line

Two themes still cut across the three seats and are the highest-leverage things to
close before Campfire is a no-caveats "go-to platform":

1. **Between-session engagement** — notifications and shareable recap links. Right
   now the app is silent when you're not looking at it.
2. **Operator observability** — an admin dashboard (usage/version/update indicators)
   and a server-wide audit trail, so an admin can *see* what the server is doing.

The third historical theme, **account lifecycle** (invites, optional self-signup,
self-service password reset — see [Admin vs DM](../administration/access-model.md)) and
the **operator-confidence** backup/restore story (see
[Backups & upgrades](../administration/operations.md)) have since shipped.

Everything here feeds the [Roadmap & status](roadmap.md); the items already being
built are marked 🔨 there.
