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
- ✅ **Factions / organizations** (#221) — campaign-scoped groups with member NPCs, a party-**reputation** score + standing label the DM adjusts, a DM secret, and hideable-until-reveal factions (hidden ones 404 for non-DMs)
- ✅ **Locations** — pin map, status (unexplored → explored → current), uploaded map image with draggable pins
- ✅ **Session zero / table charter** — a per-campaign charter the whole table can read: **lines** (hard limits) & **veils** (soft limits), agreed **safety tools** (X-Card, Open Door…), **house rules**, and **tone & expectations**; the DM edits it, everyone sees it (also readable over MCP)
- ✅ **Characters** — stats, AC, HP, conditions, portrait upload, markdown bio, owner-or-DM editing, plus saving throws, skills, actions, and spell slots; XP & guided level-up; a DM-only secret field. A player may own **multiple characters** (backup PC, familiar) and create/delete their own. **D&D Beyond import** pulls a public sheet by id or URL
- ✅ **Sessions** — numbered recaps, timeline, scheduling with RSVPs + public ICS feed, per-session **attendance** (which characters played), read-only recap share links, a DM-only secret field, and a recap template scaffold
- ✅ **Notes** — private / share-with-DM / share-with-party, anchored to any entity
- ✅ **Scribe inbox** — zero-friction quick capture → DM resolves into canon
- ✅ **Discussion / comments** (#123) — a threaded comment layer anchored to any entity (quest, NPC, location, session, character, campaign), visible to all members, with replies and an `inCharacter` flag for play-by-post scenes; the author or DM can edit/delete
- ✅ **Revision history + optimistic concurrency** (#157) — prose edits on quests, NPCs, sessions, notes, locations, and factions keep a per-entity revision history you can restore, plus a concurrency guard that returns `409` (rather than silently overwriting) when two people edit the same field at once
- ✅ **Encounters / run-session** — initiative (auto-rolled d20+DEX), turn order, next-turn, at-table HP & conditions, **temp HP**, the 5e **death-save** lifecycle (dying → stable/dead, plus overkill), adding several identical monsters at once (auto-numbered) and renaming combatants, add monsters from the compendium, HP writes back to sheets on end
- ✅ **Battle maps / VTT** (#39/#40) — a grid the DM configures (size, scale, unit, snap), draggable **tokens** with sizes, a **measure/ruler** tool, and **fog of war**: the DM reveals rectangular regions and a non-DM viewer never learns the position of a token hidden in the dark (the server redacts unrevealed token coordinates)
- ✅ **Dice roller** — server-side, audited, on the dashboard and in combat, with a campaign-shared roll log every member sees; supports keep/drop notation (`khN`/`klN`/`dhN`/`dlN`, i.e. advantage/disadvantage and 4d6-drop-lowest) and an optional DC + label so a roll records success/failure
- ✅ **Compendium** — Open5e SRD import **plus generic open-licensed dataset upload** (any system, license-gated), installs run as non-blocking background jobs with per-section progress, and a DM (not just the server admin) can install; exact-name-first full-text search and a reader
- ✅ **Campaign search & @-mentions** — campaign-wide search across entities, with @-mention link targets
- ✅ **Proposals** — AI/collab writes queue for DM approval, with before/after diffs against current state
- ✅ **Notifications** — recap posted, note reply, added to a campaign, next session — with an in-app bell
- ✅ **Live updates** — combat (the run-session and player display) streams over SSE; the dashboard, quest board, party HP, dice log and notes refresh on a ~5s poll that pauses while the tab is backgrounded
- ✅ **Inventory & loot** — party treasury (coin) + per-character items
- ✅ **Soft-delete / trash** (#116) — deleting a campaign, quest, NPC, location, session, note, or character moves it to the trash (kept on disk, hidden from normal reads) and it can be **restored** exactly as it was during a grace period
- ✅ **Campaign archive, cloning & import** — a real read-only "completed" state, full/template campaign duplication, and **import** of a Campfire JSON export (round-trips export, remaps every id) to move a campaign between servers
- ✅ **Export** — whole campaign to JSON or Markdown zip (the JSON re-imports)

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

- ✅ **Full MCP parity — ~85 tools** covering campaign lifecycle, characters (incl. XP awards & level-up), story arcs/beats/branches, the whole combat loop (including dealing damage to combatants), the session-zero charter, members, rule packs, deletes, and read-back; tool schemas serialize inline (no broken `$ref`s) and strict-schema violations return the documented `{error}` JSON
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
- ✅ **In-world calendar / campaign timeline**, ✅ **campaign-wide search & @-mentions**, and ✅ **"what changed since last session"** (a quest-changes-since-a-timestamp read, defaulting to the previous session's date)

**Table depth**

- ✅ **XP & levelling** — XP tracking with 5e thresholds, party-wide DM awards, and a guided level-up (level +1, new max HP, damage carried over)
- ✅ **Inventory & loot** — party treasury (coin) and per-character items
- ✅ **Campaign archive** — a real read-only "completed" state, enforced server-wide
- ✅ **Campaign templates / cloning / import** — full or template (prep-only) duplication, plus import of a Campfire JSON export (round-trips the export)
- ✅ **D&D Beyond import** — pull a **public** D&D Beyond character sheet by id or URL (unofficial, read-only)
- ✅ **Multi-system rule packs** — other systems via **uploaded open-licensed datasets** (license-gated), alongside the built-in Open5e (D&D 5e SRD) importer
- ✅ **DM-installable content** — a DM (not just the server admin) can install rule packs, and install runs as a non-blocking background job with per-section progress

**Operator confidence**

- ✅ **Backup & restore** — WAL-safe whole-server backup (`VACUUM INTO` + uploads) and restore over the API, plus opt-in scheduled on-disk backups (`BACKUP_SCHEDULE_ENABLED`) — see [Backups & upgrades](../administration/operations.md)
- ✅ **In-app OIDC config & test** — configure OIDC from **Admin → OIDC single sign-on** with a **Test connection** check, alongside (and overridable by) env vars
- ✅ **Admin observability** — a server-admin metrics snapshot at **Admin → Metrics** (`/admin/metrics`): entity counts, on-disk DB size, uptime, running version, and recent activity
- ✅ **Server-wide audit** — a server-admin audit trail at **Admin → Audit** (`/admin/audit`) of admin actions not tied to any one campaign, alongside the existing per-campaign audit
- ✅ **Storage management** — a server-admin storage console at **Admin → Storage** (`/admin/storage`): total upload bytes, a per-campaign breakdown with **quotas** and over-quota flags (uploads past a cap are rejected with `413`), the real on-disk total, and an orphan summary (rows-without-file, files-without-row) for cleanup

**Security hardening** — ✅ shipped in the latest release

- ✅ **Scoped PATs can't escalate** — a token can only mint tokens no broader than its own scope/campaign/admin capability
- ✅ **PAT lifecycle** — a password reset revokes the user's tokens & sessions; admins can list and revoke another user's tokens
- ✅ **OIDC sign-in allowlist** (`OIDC_ALLOWED_GROUP`), ✅ **docs gated behind auth in production**, ✅ **upload content-sniffing** (magic-byte vs declared MIME), and ✅ **readiness probe** (`/readyz` does a real DB check)
- ✅ **DM-only secrets on characters & sessions**, matching quests/NPCs/locations
- ✅ **Deploy-time interlocks** — the `DEV_AUTH` auth-bypass is hard-disabled under `NODE_ENV=production` (and warns loudly when active in dev), `TRUST_PROXY` is coerced so per-IP rate limiting sees the real client behind a proxy, `ALLOW_INSECURE_HTTP` is an explicit opt-in for plain-HTTP LAN deployments, and the container runs as an unprivileged user

**AI depth**

- ✅ **MCP resources & prompts** — read surfaces are exposed as MCP resources, with prep/recap prompts, beyond the tool set
- 🟡 **AI Dungeon Master seat** (issue #28, experimental) — a per-campaign "DM seat" with an admin-gated server-wide opt-in, per-campaign token budget/metering, an `ai_dm_narrate` MCP tool, and full audit. The **shipped default provider is a no-op scaffold that makes no vendor call** — so in a stock install the connected MCP agent authors the narration and drives the tools; a self-hoster can bind their own `AI_DM_PROVIDER` for server-side generation. There is no web UI and no built-in API-key storage. See [AI capabilities](../ai/capabilities.md)
- ⬜ **AI co-DM** — generated NPCs, encounters, maps, and story beats, always routed through the approval queue

## How this list is kept

Campfire went through repeated adversarial review rounds — product, architecture,
security, QA, and real-DM personas — plus a dedicated AI-operability pass. Findings
that were fixed are folded into the ✅ sections above; everything still open is
listed honestly here. Spot something missing from this page?
[Open an issue](https://github.com/AwsomeFox/campfire/issues).
