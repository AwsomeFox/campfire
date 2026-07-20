# Roadmap & status

This page is an **honest, exhaustive** account of what Campfire does today, what's
half-built, and what's planned — maintained as a living audit rather than
marketing. If a feature isn't here, assume it doesn't exist yet.

Legend: ✅ done & tested · 🔨 in progress · 🟡 partial / stale / needs polish · ⬜ planned

## Core play loop ✅

The end-to-end tabletop loop is complete and covered by an automated test suite.

- ✅ **Campaigns** — create (guided wizard), rename, danger level, current location, delete (cascades all children)
- ✅ **Quests** — board + detail, objectives (player-tickable), subquests, giver NPC, reward, DM-only secret
- ✅ **NPCs** — disposition, location, body, DM secret
- ✅ **Locations** — pin map, status (unexplored → explored → current), uploaded map image with draggable pins
- ✅ **Characters** — stats, AC, HP, conditions, portrait upload, markdown bio, owner-or-DM editing
- ✅ **Sessions** — numbered recaps, timeline
- ✅ **Notes** — private / share-with-DM / share-with-party, anchored to any entity
- ✅ **Scribe inbox** — zero-friction quick capture → DM resolves into canon
- ✅ **Encounters / run-session** — initiative (auto-rolled d20+DEX), turn order, next-turn, at-table HP & conditions, add monsters from the compendium, HP writes back to sheets on end
- ✅ **Dice roller** — server-side, audited, on the dashboard and in combat
- ✅ **Compendium** — Open5e SRD import, full-text search, reader
- ✅ **Proposals** — AI/collab writes queue for DM approval
- ✅ **Export** — whole campaign to JSON or Markdown zip

## Platform ✅

- ✅ **Auth** — local accounts, first-run admin setup, sessions, change password
- ✅ **SSO** — OIDC / Authentik, auto-provisioning, admin-group mapping
- ✅ **Per-campaign roles** — dm / player / viewer, with last-DM & last-admin protection
- ✅ **MCP server** — AI-operable over streamable HTTP, PAT-authenticated, scope-capped
- ✅ **Single-image deploy** — multi-arch Docker image, one data volume, same-origin SPA serving, Traefik/Authentik ready
- ✅ **Preferences** — per-user accent colour and text size

## AI operability ✅

An AI agent can run an entire campaign over MCP alone — verified end-to-end:

- ✅ **Full MCP parity — 64 tools** covering campaign lifecycle, characters, the whole combat loop (including dealing damage to combatants), members, rule packs, deletes, and read-back
- ✅ **Strict schemas & structured errors** — unknown args are rejected with named keys; errors are machine-parseable `{status, code, message}` JSON
- ✅ **Headless agent auth** — `POST /auth/token` (credentials → PAT) and an admin "mint a token for a user", so agents and whole tables bootstrap without a browser
- ✅ **Self-describing REST** — OpenAPI annotations across every controller

## Admin ⁄ DM separation 🔨⬜

Requested and being built so the operator and the storyteller stay distinct
(see [Admin vs DM](../administration/access-model.md)):

- ✅ **DM invite links / join codes** — a DM generates a `/join/<code>` link from **Members → Invite** (player/viewer, expiring, revocable); whoever opens it creates their own account and lands in the campaign
- ⬜ **Optional self-service signup** — a server setting for open registration
- ✅ **Admin ≠ auto-DM** — a server admin no longer implicitly sees every campaign's DM secrets; server power ≠ story access

## Half-built & stale 🟡

Honest rough edges that exist but aren't finished:

- 🟡 **Character sheet depth** — saving throws, skills, attacks/actions, and spell slots are placeholder "soon" sections; HP, conditions, stats, and bio are real
- 🟡 **Compendium breadth** — the importer pulls spells, monsters, magic items, and conditions; classes, races, and feats are modelled in the type system but not yet imported
- 🟡 **Proposal diffs** — show the proposed new values only; there's no before/after snapshot to compare against current state
- 🟡 **Real-time updates** — the run-session and dashboard use polling; live push (SSE) is planned for smoother at-the-table multi-device play
- 🟡 **Notes anchor labels** — entity-linked notes show `Quest #12`-style references rather than the entity's name in some list views
- 🟡 **AI scribe automation** — the proposal queue is real, but there's no built-in scheduled/automatic scribe; today it's client-driven (connect an MCP client and ask it to act)

## Planned ⬜

See the [operator's reality check](operator-audit.md) for these in the context of
who hits them. Grouped by theme:

**Account lifecycle & self-service**

- ✅ **DM invites / join codes** and ⬜ **optional self-service signup** (see [Admin vs DM](../administration/access-model.md))
- ⬜ **Forgot-password / self-service reset** — today only an admin can reset a local user's password

**Between-session engagement**

- ⬜ **Notifications** — new recap, a reply to your note, being added to a campaign, next session _(the app is currently silent when you're not looking at it)_
- ⬜ **Read-only recap share links** — let an absent player catch up without an account
- ⬜ **Session scheduling** — a "next session" date / availability, with an ICS feed

**Table depth**

- ⬜ **XP & levelling** — _(today `level` is a plain editable number)_
- ⬜ **Inventory & loot** — party treasury and per-character items _(today loot lives in prose)_
- ⬜ **Campaign archive** — a real read-only "completed" state _(today `status` is stored but cosmetic; completed campaigns stay fully editable in the hub)_
- ⬜ **Campaign templates / cloning** — reuse prep instead of rebuilding from scratch
- ⬜ **D&D Beyond import** — _(the `ddbId` field exists; import does not)_
- ⬜ **Multi-system rule packs** — Pathfinder 2e and others via uploaded open-licensed datasets, since only Open5e (D&D 5e SRD) is wired today
- ⬜ **DM-installable content** — let a DM add rule packs without the server admin; make install a non-blocking background job with per-section progress

**Operator confidence**

- ⬜ **Backup & restore** — in-app backup, scheduling, and a whole-server restore/import _(today: manual `/data` copy + per-campaign export only)_
- ⬜ **Admin observability** — user/campaign counts, storage usage, version, update-available
- ⬜ **Server-wide audit** — a log of admin actions (account creation, settings, pack installs); today audit is per-campaign only
- ⬜ **Storage management** — upload size visibility, quotas, orphan cleanup
- ⬜ **In-app OIDC config & test** — instead of env-only with no "connection OK" feedback

**AI depth**

- ⬜ **MCP resources & prompts** — expose read surfaces as resources and add prep/recap prompts, beyond tools
- ⬜ **AI co-DM** — generated NPCs, encounters, maps, and story beats, always routed through the approval queue

## How this list is kept

Campfire went through repeated adversarial review rounds — product, architecture,
security, QA, and real-DM personas — plus a dedicated AI-operability pass. Findings
that were fixed are folded into the ✅ sections above; everything still open is
listed honestly here. Spot something missing from this page?
[Open an issue](https://github.com/AwsomeFox/campfire/issues).
