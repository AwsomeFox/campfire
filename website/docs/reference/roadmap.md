# Roadmap & status

This page is an **honest, exhaustive** account of what Campfire does today, what's
half-built, and what's planned — maintained as a living audit rather than
marketing. If a feature isn't here, assume it doesn't exist yet.

Legend: ✅ done & tested · 🔨 in progress · 🟡 partial / stale / needs polish · ⬜ planned

## Core play loop ✅

The end-to-end tabletop loop is complete and covered by an automated test suite.

- ✅ **Campaigns** — create (guided wizard), rename, danger level, current location, delete (cascades all children)
- ✅ **Quests** — board + detail, objectives (player-tickable), subquests, giver NPC, reward, DM-only secret
- ✅ **Storylines** — a DM-only branching arc/beat planner: arcs group ordered beats, and each beat carries labelled branches (next-options) toward other beats, so you can sketch where the story might fork before it does
- ✅ **In-world timeline** — a campaign calendar the DM sequences by narrative order: events with free-text in-fiction dates (fantasy calendars aren't ISO), optional era grouping, a "current in-world date", plus DM secrets and hideable-until-reveal events
- ✅ **NPCs** — disposition, location, body, DM secret
- ✅ **Locations** — pin map, status (unexplored → explored → current), uploaded map image with draggable pins
- ✅ **Characters** — stats, AC, HP, conditions, portrait upload, markdown bio, owner-or-DM editing, plus saving throws, skills, actions, and spell slots; XP & guided level-up; a DM-only secret field
- ✅ **Sessions** — numbered recaps, timeline, scheduling with RSVPs + public ICS feed, read-only recap share links, a DM-only secret field, and a recap template scaffold
- ✅ **Notes** — private / share-with-DM / share-with-party, anchored to any entity
- ✅ **Scribe inbox** — zero-friction quick capture → DM resolves into canon
- ✅ **Encounters / run-session** — initiative (auto-rolled d20+DEX), turn order, next-turn, at-table HP & conditions, add monsters from the compendium, HP writes back to sheets on end
- ✅ **Dice roller** — server-side, audited, on the dashboard and in combat, with a campaign-shared roll log every member sees; supports keep/drop notation (`khN`/`klN`/`dhN`/`dlN`, i.e. advantage/disadvantage and 4d6-drop-lowest) and an optional DC + label so a roll records success/failure
- ✅ **Compendium** — Open5e SRD import **plus generic open-licensed dataset upload** (any system, license-gated), installs run as non-blocking background jobs with per-section progress, and a DM (not just the server admin) can install; exact-name-first full-text search and a reader
- ✅ **Campaign search & @-mentions** — campaign-wide search across entities, with @-mention link targets
- ✅ **Proposals** — AI/collab writes queue for DM approval, with before/after diffs against current state
- ✅ **Notifications** — recap posted, note reply, added to a campaign, next session — with an in-app bell
- ✅ **Live updates** — combat (the run-session and player display) streams over SSE; the dashboard, quest board, party HP, dice log and notes refresh on a ~5s poll that pauses while the tab is backgrounded
- ✅ **Inventory & loot** — party treasury (coin) + per-character items
- ✅ **Campaign archive & cloning** — a real read-only "completed" state, and full/template campaign duplication
- ✅ **Export** — whole campaign to JSON or Markdown zip

## Platform ✅

- ✅ **Auth** — local accounts, first-run admin setup, sessions, change password, optional self-service signup, and admin-approved forgot-password reset
- ✅ **SSO** — OIDC / Authentik, auto-provisioning, admin-group mapping, and a sign-in allowlist group (`OIDC_ALLOWED_GROUP`)
- ✅ **Per-campaign roles** — dm / player / viewer, with last-DM & last-admin protection
- ✅ **MCP server** — AI-operable over streamable HTTP, PAT-authenticated, scope-capped
- ✅ **Single-image deploy** — multi-arch Docker image (runs as an unprivileged `node` user), one data volume, same-origin SPA serving, Traefik/Authentik ready
- ✅ **Installable PWA** — a web-app manifest and a service worker precache the app shell so Campfire installs to a device and opens offline; the last successful read of a page stays available without a connection
- ✅ **Preferences** — per-user accent colour and text size

## AI operability ✅

An AI agent can run an entire campaign over MCP alone — verified end-to-end:

- ✅ **Full MCP parity — 82 tools** covering campaign lifecycle, characters (incl. XP awards & level-up), story arcs/beats/branches, the whole combat loop (including dealing damage to combatants), members, rule packs, deletes, and read-back; tool schemas serialize inline (no broken `$ref`s) and strict-schema violations return the documented `{error}` JSON
- ✅ **MCP resources & prompts** — read surfaces are also exposed as MCP resources, plus prep/recap prompts, beyond the tool set
- ✅ **Strict schemas & structured errors** — unknown args are rejected with named keys; errors are machine-parseable `{status, code, message}` JSON
- ✅ **Headless agent auth** — `POST /auth/token` (credentials → PAT) and an admin "mint a token for a user", so agents and whole tables bootstrap without a browser
- ✅ **Self-describing REST** — OpenAPI annotations across every controller

## Admin ⁄ DM separation ✅

The operator and the storyteller are kept distinct
(see [Admin vs DM](../administration/access-model.md)):

- ✅ **DM invite links / join codes** — a DM generates a `/join/<code>` link from **Members → Invite** (player/viewer, expiring, revocable); whoever opens it creates their own account and lands in the campaign
- ✅ **Optional self-service signup** — a server setting for open registration (off by default)
- ✅ **Admin ≠ auto-DM** — a server admin no longer implicitly sees every campaign's DM secrets; server power ≠ story access

## Half-built & stale 🟡

Honest rough edges that exist but aren't finished:

- 🟡 **AI scribe automation** — the proposal queue is real, but there's no built-in scheduled/automatic scribe; today it's client-driven (connect an MCP client and ask it to act)
- 🟡 **Multi-system rule packs** — Open5e (D&D 5e SRD) has a built-in importer, and any other system can be added via the **generic open-licensed dataset upload**; no other system ships with a one-click importer yet, so non-5e content means bringing your own dataset

## Planned ⬜

See the [operator's reality check](operator-audit.md) for these in the context of
who hits them. Grouped by theme:

**Account lifecycle & self-service** — ✅ shipped

- ✅ **DM invites / join codes**, ✅ **optional self-service signup** (see [Admin vs DM](../administration/access-model.md)), and ✅ **forgot-password / self-service reset** (admin-approved one-time codes)

**Between-session engagement** — ✅ shipped

- ✅ **Notifications**, ✅ **read-only recap share links**, ✅ **session scheduling with an ICS feed**, and ✅ **a campaign-shared dice log**
- ✅ **In-world calendar / campaign timeline** and ✅ **campaign-wide search & @-mentions** shipped; ⬜ **"what changed since last session"** is the next engagement item

**Table depth**

- ✅ **XP & levelling** — XP tracking with 5e thresholds, party-wide DM awards, and a guided level-up (level +1, new max HP, damage carried over)
- ✅ **Inventory & loot** — party treasury (coin) and per-character items
- ✅ **Campaign archive** — a real read-only "completed" state, enforced server-wide
- ✅ **Campaign templates / cloning** — full or template (prep-only) duplication
- ⬜ **D&D Beyond import** — _(the `ddbId` field exists; import does not)_
- ✅ **Multi-system rule packs** — other systems via **uploaded open-licensed datasets** (license-gated), alongside the built-in Open5e (D&D 5e SRD) importer
- ✅ **DM-installable content** — a DM (not just the server admin) can install rule packs, and install runs as a non-blocking background job with per-section progress

**Operator confidence**

- ✅ **Backup & restore** — WAL-safe whole-server backup (`VACUUM INTO` + uploads) and restore over the API, plus opt-in scheduled on-disk backups (`BACKUP_SCHEDULE_ENABLED`) — see [Backups & upgrades](../administration/operations.md)
- ✅ **In-app OIDC config & test** — configure OIDC from **Admin → OIDC single sign-on** with a **Test connection** check, alongside (and overridable by) env vars
- ⬜ **Admin observability** — user/campaign counts, storage usage, version, update-available
- ⬜ **Server-wide audit** — a log of admin actions (account creation, settings, pack installs); today audit is per-campaign only
- ⬜ **Storage management** — upload size visibility, quotas, orphan cleanup

_(Several of these operator items are in active development for the next release.)_

**Security hardening** — ✅ shipped in the latest release

- ✅ **Scoped PATs can't escalate** — a token can only mint tokens no broader than its own scope/campaign/admin capability
- ✅ **PAT lifecycle** — a password reset revokes the user's tokens & sessions; admins can list and revoke another user's tokens
- ✅ **OIDC sign-in allowlist** (`OIDC_ALLOWED_GROUP`), ✅ **docs gated behind auth in production**, ✅ **upload content-sniffing** (magic-byte vs declared MIME), and ✅ **readiness probe** (`/readyz` does a real DB check)
- ✅ **DM-only secrets on characters & sessions**, matching quests/NPCs/locations
- ✅ **Deploy-time interlocks** — the `DEV_AUTH` auth-bypass is hard-disabled under `NODE_ENV=production` (and warns loudly when active in dev), `TRUST_PROXY` is coerced so per-IP rate limiting sees the real client behind a proxy, `ALLOW_INSECURE_HTTP` is an explicit opt-in for plain-HTTP LAN deployments, and the container runs as an unprivileged user

**AI depth**

- ✅ **MCP resources & prompts** — read surfaces are exposed as MCP resources, with prep/recap prompts, beyond the tool set
- ⬜ **AI co-DM** — generated NPCs, encounters, maps, and story beats, always routed through the approval queue

## How this list is kept

Campfire went through repeated adversarial review rounds — product, architecture,
security, QA, and real-DM personas — plus a dedicated AI-operability pass. Findings
that were fixed are folded into the ✅ sections above; everything still open is
listed honestly here. Spot something missing from this page?
[Open an issue](https://github.com/AwsomeFox/campfire/issues).
