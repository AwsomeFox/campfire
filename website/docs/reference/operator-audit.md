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
| Get my players in | ❌ | No invite/join flow; I must ask the admin to hand-create every account (the "Invite" card is a disabled placeholder) |
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

**Biggest DM gaps:** getting players in without the admin, XP/loot/scheduling, and a
real archive state. Combat depth (concentration, legendary/lair actions, mechanical
conditions) is also shallow — fine for a tracker, a limit for crunchy tables.

---

## 🎲 The player — "play the campaign"

| Step | State | Notes |
|---|---|---|
| Get an account | 🟡 | An admin creates it and tells me my username + password — no invite link, no self-signup |
| First login with nothing assigned | ✅ | The hub tells me to ask my DM to add me (no dead-end "create a campaign" trap) |
| Join a campaign | 🟡 | The DM adds me by username; I can't self-join with a code |
| Make my character | ✅ | Create my own, or the DM links one to me |
| Fill in the full sheet | 🟡 | HP, conditions, stats, bio, portrait work; **saving throws, skills, attacks, and spell slots are "soon" placeholders** |
| Import my D&D Beyond character | ❌ | The `ddbId` field exists but there's no importer |
| Play at the table on my phone | 🟡 | Mobile nav works, but live combat is two taps into "More" and the "Live" chip only shows on the dashboard |
| Tick objectives / edit my HP & conditions / roll dice | ✅ | All allowed for players; dice now on the dashboard too |
| Take notes (private / to DM / to party) | ✅ | Three visibility levels, anchored to any entity |
| Level up | ❌ | No flow — the DM edits my level number; I can't see or earn XP |
| Read recaps & shared notes between sessions | ✅ | Everything's there when I log in |
| Get told when something happens | ❌ | **No notifications of any kind** — new recap, a reply to my note, "you were added," next session — I only find out by logging in and looking |
| Reset my own password if I forget it | ❌ | No forgot-password flow; an admin has to reset it |

**Biggest player gaps:** notifications (the between-session engagement hole), sheet
depth, XP visibility, and self-service account recovery.

---

## 🛠️ The admin — "maintain the server"

| Step | State | Notes |
|---|---|---|
| Install it | ✅ | One image, one volume; first visit creates the admin account |
| Create player/DM accounts | 🟡 | Only via Admin → Users, one at a time; no invites, no bulk, no self-signup toggle |
| Turn on SSO | 🟡 | Set OIDC env vars and restart; no in-app config or "test connection" — you learn it worked when the login button appears |
| Recover a forgotten password | 🟡 | I reset it from Admin → Users; users can't self-serve (no email) |
| Install rule content | 🟡 | Admin-only, one system (Open5e / D&D 5e SRD), a long **blocking** import (~a minute for the full SRD) with only a busy spinner — no per-section progress, no background job, and DMs can't self-serve |
| Back up the server | 🟡 | "Copy `/data`" — true (db + uploads live there), but there's **no in-app backup button, no schedule, and no restore/import flow**; per-campaign JSON export exists, whole-server restore does not |
| See how the server is doing | ❌ | No admin dashboard — no user/campaign counts, storage usage, version, or update-available indicator |
| Audit admin actions | ❌ | Audit logs are **per-campaign** (DM-visible); there's no server-wide log of account creation, settings changes, or pack installs |
| Manage storage | ❌ | Uploads accumulate with no size visibility, quota, or orphan cleanup |
| Review who has API/AI tokens | 🟡 | Users manage their own tokens; an admin can't see or revoke everyone's from one place |
| Upgrade | ✅ | Bump the image tag; migrations auto-run and are idempotent; `/data` carries across |
| Keep admin power separate from campaign secrets | 🟡→🔨 | Today a server admin is implicitly DM of every campaign (sees all secrets); privilege separation is being added |

**Biggest admin gaps:** a real backup/restore story, server observability, a
server-wide audit trail, and self-service account flows (invites/signup/reset).

---

## The through-line

Three themes cut across all three seats and are the highest-leverage things to
close before Campfire is a no-caveats "go-to platform":

1. **Account lifecycle** — invites, optional self-signup, and self-service password
   reset. Fixes the admin bottleneck *and* the player's rough entry in one stroke.
   _(In progress — see [Admin vs DM](../administration/access-model.md).)_
2. **Between-session engagement** — notifications and shareable recap links. Right
   now the app is silent when you're not looking at it.
3. **Operator confidence** — backup/restore, observability, and a server-wide audit
   so an admin can actually *trust* the thing with a group's campaign.

Everything here feeds the [Roadmap & status](roadmap.md); the items already being
built are marked 🔨 there.
