# @campfire/server

NestJS API for Campfire, the self-hosted D&D campaign tracker. SQLite storage
via drizzle-orm/better-sqlite3, domain contract imported from
`@campfire/schema` (Zod schemas + inferred types — no shapes redefined here).

## Module map

```
src/
  main.ts                 bootstrap: helmet, cookie-parser, JSON/urlencoded body-size limit,
                           CORS (env-driven, credentials), global prefix, Swagger — see
                           "Prod hardening" below
  app.module.ts            wires DbModule + all domain modules + global guards/pipe
  db/
    schema.ts               drizzle table defs mirroring @campfire/schema entities
    bootstrap.sql.ts         CREATE TABLE IF NOT EXISTS DDL, run on boot
    db.module.ts             opens better-sqlite3 (WAL), runs bootstrap SQL, exports DB token
  common/
    user.types.ts            RequestUser (session- or dev-header-resolved), role rank helpers
    crypto.ts                scrypt password hashing, session token generation/hashing
    guards/session-auth.guard.ts  SessionAuthGuard — cookie session, else DEV_AUTH headers, else 401
    guards/server-roles.guard.ts  ServerRolesGuard — enforces @ServerRoles('admin')
    decorators/              @ServerRoles(), @CurrentUser(), @Public() (@Roles() kept but unused — see below)
    redact.ts                strips dmSecret for non-dm
    json.ts                  TEXT<->JSON (de)serialization for stats/conditions
    time.ts                  nowIso()
  modules/
    health/                  GET /healthz (liveness) + GET /readyz (readiness, SELECT 1 vs SQLite) — no prefix, no auth
    auth/                    AuthService (setup/login/logout/session resolution) + /auth/*, /me, /me/password;
                              OidcService/OidcController (env-gated OIDC/SSO login) — see "OIDC / SSO login"
    users/                   admin user CRUD (/users) + /users/lookup (any authenticated user)
    settings/                server settings (/settings, admin) — allowLocalLogin, JSON key/value store
    membership/              RoleResolver + CampaignAccessService (effective-role resolution),
                              MembersService/-Controller (/campaigns/:id/members)
    campaigns/                campaigns CRUD (user-scoped list) + GET :id/summary (aggregate);
                               DELETE cascades every child table + the on-disk upload dir —
                               see CampaignsService.remove()'s doc comment
    characters/                campaign-scoped + /characters/:id, hp, conditions, xp, level-up
    quests/                    campaign-scoped + /quests/:id, status, objectives
    npcs/                      campaign-scoped + /npcs/:id
    locations/                 campaign-scoped + /locations/:id, discover
    sessions/                  campaign-scoped + /sessions/:id
    notes/                     campaign-scoped notes + inbox + /notes/:id, resolve
    audit/                     AuditService.log() + GET /campaigns/:id/audit (dm)
    tokens/                    PAT CRUD (/tokens) + TokensService.resolveByRawToken() (used by the guard)
    proposals/                 proposal-records.service.ts (leaf: CRUD on `proposals`, imported by
                                quests/npcs/locations/sessions for `?proposed=true`) +
                                proposals.service.ts (approve/reject, applies via the target domain service)
    export/                    GET /campaigns/:id/export?format=json|mdzip (dm)
    rules/                     rule packs (Compendium backend) — /rules/packs, /rules/search,
                                /rules/entries/:id; Open5e importer — see "Rule packs" below
    encounters/                combat tracker — /campaigns/:id/encounters, /encounters/:id,
                                combatants, roll-initiative/start/next-turn/end (state machine:
                                preparing -> running -> ended, guarded both ways — see
                                EncountersService.start()/end()); /campaigns/:id/roll (dice)
    attachments/                image uploads (portraits/maps/misc), DATA_DIR/uploads/<campaignId>/<id>.<ext>
```

Each domain module (except health/auth/users/settings) follows the same
shape: a `<domain>.dto.ts` (Zod DTOs via `createZodDto`), `<domain>.service.ts`
(drizzle queries + domain mapping + audit logging), and one or two
controllers — one mounted at `campaigns/:campaignId/<domain>` for
list/create, one at `/<domain>` for id-scoped routes — per the spec's URL
shape.

## Authentication & authorization

Real local auth replaced the old header-only dev auth. Three layers:

### 1. Users & sessions

New tables (`db/bootstrap.sql.ts`): `users` (username UNIQUE COLLATE NOCASE,
`passwordHash` — nullable, NULL for OIDC-provisioned users, see "OIDC / SSO
login" — `serverRole` admin|user, `disabled`, `oidcSub` — nullable, unique
per issuer, indexed), `user_sessions` (id -> `tokenHash`, `userId`,
`expiresAt`, `lastSeenAt`), `settings` (key/value JSON store),
`campaign_members` (campaignId, userId → users.id with `ON DELETE CASCADE`,
role dm|player|viewer, `characterId`, UNIQUE(campaignId, userId)).

Passwords: `node:crypto` `scryptSync` (N=16384, r=8, p=1, random 16-byte
salt), stored as `scrypt:N:r:p:saltHex:hashHex`; compared with
`timingSafeEqual`. No new native dependency. Sessions: 32 random bytes hex as
the bearer token, cookie `campfire_session` (httpOnly, `sameSite=lax`,
`path=/`, 30-day maxAge, `secure` only when `NODE_ENV=production`); the DB
stores only `sha256(token)`. `lastSeenAt` slides forward at most once/hour on
use (`AuthService.resolveSessionUser`).

**Expired session sweep.** `AuthService.purgeExpiredSessions()` deletes every
`user_sessions` row past its `expiresAt`. `AuthService` implements
`OnApplicationBootstrap`, so this runs once at boot (`await`ed — see the method's
doc comment for why that matters for test teardown timing) and then hourly via
an `.unref()`d `setInterval` (never keeps the Node process alive on its own).

### 2. SessionAuthGuard (replaces DevAuthGuard)

Global guard (`APP_GUARD`) that resolves `req.user` in order:

1. `Authorization: Bearer cf_pat_<48 hex>` header -> `TokensService.resolveByRawToken()`
   (sha256 lookup in `api_tokens`) -> `RequestUser` resolved from the
   **owning** user, plus `tokenContext: {tokenId, name, scope, campaignId}`
   carried both on `RequestUser.tokenContext` (so `RoleResolver` picks up the
   scope cap with no call-site changes) and on `req.tokenContext` (for the
   `@CurrentTokenContext()` decorator). `lastUsedAt` is updated, throttled to
   once/hour.
2. `campfire_session` cookie -> `AuthService.resolveSessionUser()` -> real
   `RequestUser { id: String(users.id), name, serverRole }`.
3. Else, if env `DEV_AUTH=1`: legacy `x-dev-role`/`x-dev-user` headers ->
   synthetic `RequestUser { id: 'dev:<name>', name, serverRole: 'admin',
   devRole }`. This keeps every pre-auth e2e suite working unchanged —
   `test/test-app.ts`'s `createTestApp()` sets `DEV_AUTH=1` before boot.
4. Else 401, unless the route is `@Public()` (e.g. `/healthz`,
   `/auth/status`, `/auth/setup`, `/auth/login`).

`ServerRolesGuard` (also `APP_GUARD`) separately enforces `@ServerRoles('admin')`
on the users-admin and settings controllers — this is the one case where
"role" really is request-global (server role), not campaign-scoped.

`common/decorators/roles.decorator.ts` (`@Roles()`) is kept only for
reference/back-compat; no controller uses it anymore, because campaign role
is no longer resolvable from headers alone (see below).

### 3. Effective roles & membership (the refactor)

Campaign role (`dm | player | viewer`) is no longer part of `RequestUser` —
it depends on *which* campaign is being accessed. `RoleResolver` (leaf
module `membership/role-access.module.ts`, no dependency on any domain
module — this avoids DI cycles) resolves it per request:

1. `user.devRole` (DEV_AUTH header path) short-circuits everything.
2. `user.serverRole === 'admin'` -> always `'dm'` (admins have full DM rights
   in every campaign).
3. `campaign_members` lookup by numeric `userId` (dev:\* users never reach
   this branch — their id isn't numeric).
4. `null` — not a member.

`CampaignAccessService` (same module) wraps this with `requireMember()` (403
`Not a member of this campaign` if null) and `requireRole(min)` (403 if below
`min` on the `dm > player > viewer` rank). Every campaign-scoped controller
resolves `campaignId` (from the route param directly, or by fetching the
entity first for id-scoped routes like `PATCH /quests/:id`) and calls one of
these before delegating to the service — the service methods that used to
take an implicit `user.role` now take an explicit `role: Role` parameter
resolved this way. The existing `redactSecret`/`canSee` helpers are
unchanged; they're just fed the effective role instead of a header-derived
one.

`GET /campaigns` is scoped: admins (and DEV_AUTH header users) see every
campaign; everyone else sees only campaigns they have a `campaign_members`
row in. `POST /campaigns` is open to any authenticated user; the creator is
auto-inserted as that campaign's `dm` (skipped for `dev:*` users, who have no
numeric id to store).

**PAT token scope cap.** When `user.tokenContext` is set (see SessionAuthGuard
above), `RoleResolver.effectiveRole()` applies it *after* computing the normal
effective role: if the token is bound to a `campaignId` and this isn't it,
the caller is treated as a non-member (`null`, -> 403) — even for admins.
Otherwise the result is `min(tokenContext.scope, real effective role)` using
the `dm > player > viewer` rank — `serverRole: 'admin'` does **not** bypass
this cap when acting through a token. `accessibleCampaignIds()` is similarly
narrowed to `[tokenContext.campaignId]` when the token is campaign-bound.
Audit/proposal actor strings use `common/user.types.ts`'s `auditActor(user)`
helper, which renders as `token:<name>` instead of the raw user id whenever
`tokenContext` is present.

**PAT SERVER-admin cap (separate from the scope cap above).** `scope` only
ever caps *campaign* role via `RoleResolver`. Server-wide admin power
(`@ServerRoles('admin')`-gated routes — `POST /users`, `/settings` — and the
MCP `install_rule_pack` tool) is gated by `common/user.types.ts`'s
`hasServerAdminPower(user)` instead of a raw `user.serverRole === 'admin'`
check: true only when `serverRole === 'admin'` AND (`tokenContext` is unset —
a cookie session — OR `tokenContext.adminEnabled === true`). `adminEnabled`
lives on `ApiToken`/`api_tokens.admin_enabled`, defaults `false`, and can only
be set `true` at mint time by a caller who *currently* has real (non-token-
capped) server-admin power — see `TokensService.create`/`mintFor`. This closes
a privilege-escalation gap where a viewer-scoped token minted for an admin
still inherited that admin's server-wide power: the "least-privilege" token
an operator hands an AI agent is no longer secretly root.

### Invariants enforced server-side (409 on violation)

- Cannot demote (`serverRole` away from `admin`), disable, or delete the
  **last enabled admin** (`UsersService`).
- Cannot demote/remove, disable, or delete the **last usable `dm` of a
  campaign**. A DM seat is usable only while its referenced user exists and is
  enabled; disabled or legacy ghost rows never count. Membership mutations and
  account disable/delete checks run in synchronous SQLite transactions so
  concurrent REST/MCP/admin requests cannot consume the final two seats at once.
- `campaign_members.user_id` is an enforced `users.id` foreign key (`ON DELETE
  CASCADE`) on fresh and upgraded databases. Migration `0046` transactionally
  rebuilds the table, removes rows whose user/campaign is missing, clears invalid
  optional character links, and records identifier/role-only repair history in
  `membership_integrity_repairs`.

Server admins can inspect **Admin → Users → Campaign authority integrity** or
`GET /admin/membership-integrity`. The report contains only campaign id/name,
usable/disabled DM counts, and migration repair metadata — never campaign
entities or DM-secret fields, and it grants no implicit campaign role. If a
legacy database is already orphaned, `POST /admin/membership-integrity/repair-dm`
(`{campaignId,userId}`) can assign an existing enabled account, but only while
the campaign has zero usable DMs. MCP exposes the same operations as
`get_membership_integrity` and `repair_campaign_dm`; PAT callers need an
explicitly admin-enabled token.

Deleting a user cascades to their `user_sessions` and `campaign_members`
rows; their notes/characters are left as-is (`Character.ownerUserId` is a
free-text string, not a FK).

### Auth endpoints

- `GET /auth/status` (public) — `{setupRequired, localLoginEnabled,
  signupEnabled, oidcEnabled, oidcProviderName, version}`. `oidcEnabled` is true only when `OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` are all set (see "OIDC / SSO
  login" below). `oidcProviderName` is the optional public display name only;
  issuer, client, group, and secret configuration details are never included.
- `POST /auth/setup` (public, only while zero users exist, else 409) —
  creates the first user as `serverRole: 'admin'`, starts a session.
- `POST /auth/login` (public) — 401 generic on bad credentials, 403 if
  disabled, 403 `'This account uses SSO'` if the user has no local password
  (OIDC-provisioned), 403 if `serverRole !== 'admin'` and
  `settings.allowLocalLogin === false` (admins can **always** log in locally
  — lockout prevention).
- `POST /auth/token` (public) — **headless PAT bootstrap**: `{username,
  password, tokenName, scope?, campaignId?}` -> `ApiTokenCreated {token,
  apiToken}`. Verifies credentials via the exact same checks as `POST
  /auth/login` (`AuthService.verifyCredentials()`, shared by both — same 401
  on bad creds, same 403s for disabled/SSO-only/local-login-disabled
  accounts), then mints a PAT for that user in the **same call** — no cookie,
  no second round trip. `scope`/`campaignId` are enforced exactly like
  self-service `POST /tokens` (403 if the authenticating user has no real
  access to `campaignId`); `scope` defaults to `'viewer'` if omitted. This is
  the entry point AI agents/scripts use instead of `POST /auth/login` — see
  "Driving Campfire as an AI agent" below.
- `POST /auth/logout` — deletes the session row, clears the cookie, 204.
- `GET /auth/oidc/login` (public) — 302 to the identity provider's
  authorization endpoint. If OIDC cannot start, 302s same-origin to the web
  recovery page with only a safe category and random support reference.
- `GET /auth/oidc/callback` (public) — completes the code exchange,
  provisions/updates the user, sets the session cookie, and 302s to `/` on
  success. Expected cancellation/flow/security/provider/account failures 302
  same-origin to `/login/sso-error`; raw provider payloads, code, state, PKCE
  values, tokens, claims, and secrets are never copied into that redirect.
- `GET /me` — `{user, memberships}`; `passwordHash` never included; 401 if
  unauthenticated. `dev:*` header users get a synthesized `id: 0` shape with
  no memberships (there's no DB row to read).
- `POST /me/password` — `currentPassword` is **required** here (unlike the
  admin reset endpoint); rehashes, kills every *other* session for that user.
  403 `'This account uses SSO'` for passwordless (OIDC) users.
- `GET /users`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id`,
  `POST /users/:id/password` — admin only. `POST /users/:id/password` also
  works on an SSO-provisioned user — it sets a local password, which lets
  that user subsequently log in locally too (an admin-initiated escape
  hatch; OIDC login keeps working either way).
- `GET /users/lookup?query=` — any authenticated user, 2+ chars, max 10
  results — member-picker autocomplete.
- `POST /users/:id/tokens` — admin only. **Provisions a PAT on behalf of
  another user** — `{tokenName, scope?, campaignId?}` -> `ApiTokenCreated
  {token, apiToken}` — without needing that user's password. Unlike a naive
  implementation, `scope`/`campaignId` are validated against the **target**
  user's own campaign access (via `TokensService.mintFor()`'s `caller` param
  set to the target, not the admin), so an admin cannot mint a token scoped
  to a campaign the target user has no relationship to, even though the
  admin themself might have full access to it. Lets a DM/admin agent
  provision an entire table's worth of tokens in one sweep — see "Driving
  Campfire as an AI agent" below.
- `GET /settings`, `PATCH /settings` — admin only.
- `GET/POST/PATCH/DELETE /campaigns/:id/members[/:memberId]` — dm for
  writes, any member for read.

### OIDC / SSO login

Generic OIDC (tested against [Authentik](https://goauthentik.io/), works with
any standards-compliant provider), configurable from the admin UI or env vars
(env values win per field). Implemented with `openid-client` v6
(`modules/auth/oidc.service.ts`, `oidc.controller.ts`, `oidc.config.ts`).

**Env vars:**

| Var | Required | Default | Notes |
|---|---|---|---|
| `OIDC_ISSUER` | yes* | — | Discovery base URL, e.g. `https://authentik.example.com/application/o/campfire/`. `oidcEnabled` requires this + client id + secret all set. |
| `OIDC_CLIENT_ID` | yes* | — | |
| `OIDC_CLIENT_SECRET` | yes* | — | |
| `OIDC_REDIRECT_URI` | no | `${APP_URL or http://localhost:8080}/api/v1/auth/oidc/callback` | Must exactly match the redirect URI registered on the provider. |
| `OIDC_PROVIDER_NAME` | no | — (`Sign in with SSO`) | Optional public identity-provider display name for the login button, e.g. `Keycloak` (80 characters max). |
| `OIDC_SCOPE` | no | `openid profile email` | Add `groups` (or your provider's scope name) here too if group membership isn't included by default. |
| `OIDC_GROUPS_CLAIM` | no | `groups` | Name of the ID-token claim holding the user's group list. |
| `OIDC_ADMIN_GROUP` | no | — (admin sync disabled) | Group name that grants `serverRole: 'admin'`. Applied on **every** login, both directions — added to the group -> promoted, removed -> demoted — except the last enabled admin is never demoted (a warn is logged and the role left as-is). |
| `OIDC_ALLOWED_GROUP` | no | — (any authenticated IdP user may sign in) | Group name required to sign in at all. Checked on **every** login: without it the callback redirects to safe access-denied recovery, no account is auto-provisioned, and existing accounts get no session (removing the group at the IdP locks the user out on their next login). Members of `OIDC_ADMIN_GROUP` always have access, so setting only the admin group can't lock admins out. |
| `APP_URL` | no | `http://localhost:8080` | Only used to build the default `OIDC_REDIRECT_URI`. |

\* All three of `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` must be
set together; a partial set behaves as OIDC disabled (`oidcEnabled: false`,
and direct `/auth/oidc/*` visits lead to safe recovery rather than a raw API error).

**Authentik setup:**

1. Create an OAuth2/OIDC **Provider**: Authorization flow of your choice,
   Client type `Confidential`, redirect URI = your `OIDC_REDIRECT_URI` (e.g.
   `https://campfire.example.com/api/v1/auth/oidc/callback`), scopes
   `openid`, `email`, `profile`. Add the `groups` scope mapping too (Authentik
   ships a built-in "Groups" scope mapping — enable it under "Advanced
   protocol settings") so the `groups` claim shows up in the ID token.
2. Create an **Application** bound to that provider, note the generated
   Client ID / Client Secret -> `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`.
3. `OIDC_ISSUER` is the provider's issuer URL, shown on the provider's
   detail page (usually
   `https://<authentik-host>/application/o/<application-slug>/`).
4. To grant admin: create an Authentik group, e.g. `campfire-admins`, add
   the relevant users, and set `OIDC_ADMIN_GROUP=campfire-admins`. Removing
   a user from that group demotes them on their next login.
5. Restart Campfire with the env vars set — `GET /auth/status` should now
   report `oidcEnabled: true`. The web app shows “Sign in with SSO” unless
   `OIDC_PROVIDER_NAME` supplies a display name.

**How it works server-side:**

- **Discovery** (`OidcService.getClientConfig()`) is lazy — the first call to
  `/auth/oidc/login` or `/callback` triggers it, not server boot — and
  cached in-memory after success. If the IdP is unreachable, discovery fails,
  the failure is **not** cached, and the browser reaches the recovery page; the
  *next* request retries discovery from scratch. The server never crashes or
  refuses to boot because the IdP is down.
- **Login** (`GET /auth/oidc/login`) generates PKCE (`code_verifier` +
  S256 `code_challenge`) and a random `state`, stores `state:codeVerifier` in
  a short-lived (5 min) httpOnly cookie scoped to `/api/v1/auth/oidc`, then
  302s to the provider's authorization endpoint.
- **Callback** (`GET /auth/oidc/callback`) reads that cookie, validates
  `state`, exchanges the code (PKCE) for tokens, and validates the ID
  token's signature against the provider's published JWKS (`openid-client`
  handles this — a real RS256/ES256 JWT is required; `alg: none` is
  rejected).
- **Recovery**: cancellation, missing/expired flow cookies, state/PKCE
  mismatch, provider outage, client/token failure, missing claims, group
  denial, and disabled accounts map to eight fixed public categories. The
  redirect contains only that category and a random 16-hex support reference.
  Server diagnostics use the same reference and fixed redacted fields — never
  an exception message, callback query/cookie, provider body, token, claim, or
  configuration value. “Try SSO again” starts a brand-new state/PKCE flow.
- **Claim mapping / provisioning** (`OidcService.provisionOrUpdateUser`):
  `sub` is the stable identity key (stored as `users.oidc_sub`, indexed).
  First login for a `sub` auto-provisions a user: username from
  `preferred_username` (falling back to the local part of `email`, then
  `sub`), slugified to satisfy `User.username`'s
  `/^[a-z0-9_.-]+$/i` regex (`OidcService.slugifyUsername`) — on a
  collision with an existing username, `-2`, `-3`, ... is appended until
  unique. `displayName` comes from the `name` claim (falling back to
  `preferred_username`, then the resolved username). The provisioned user
  has `passwordHash: NULL` — see below. Every subsequent login (same `sub`)
  reuses that row and re-syncs `serverRole` from the `OIDC_ADMIN_GROUP`
  check (see table above).
- **Session**: on success, the callback issues the exact same session cookie
  (`campfire_session`, same `AuthService.issueSession`) local login uses, so
  the rest of the app (SessionAuthGuard, `/me`, etc.) doesn't distinguish
  OIDC-issued sessions from local ones at all — then 302s to `/`.
- **Local login is forbidden for SSO users**: `POST /auth/login` and
  `POST /me/password` both 403 `'This account uses SSO'` when
  `users.password_hash IS NULL`. An admin can still reset a password for
  that user via `POST /users/:id/password`, which gives them a local
  password *in addition to* OIDC (both keep working).

**`users.password_hash` nullability.** The column was originally
`NOT NULL`. Since SQLite has no `ALTER TABLE ... DROP NOT NULL`, existing
DBs are migrated in place on boot (`db/db.module.ts`'s
`migrateUsersTableForOidc`): if `PRAGMA table_info(users)` shows the old
`NOT NULL` constraint, the table is rebuilt (create `users_new` with the
relaxed schema + the new `oidc_sub` column, copy rows, drop, rename) inside
a transaction. Fresh DBs never hit this path — `bootstrap.sql.ts` already
declares `password_hash TEXT` (nullable) and `oidc_sub TEXT`. This was
simpler and safer than introducing a migration-runner for what's still a
single hand-maintained bootstrap file, and avoids a NULL-vs-empty-string
sentinel (which would've made `passwordHash === ''` an ambiguous "no
password" check scattered across call sites).

## API tokens, proposals & export

### API tokens (PATs)

Table `api_tokens` (`id, userId, name, scope, campaignId NULL, tokenHash
UNIQUE, tokenPrefix, lastUsedAt, createdAt, updatedAt`). Raw token format
`cf_pat_<48 hex chars>` (`common/crypto.ts`'s `generateApiToken()` — 24
random bytes); the DB stores `sha256(token)` only, plus `tokenPrefix` (first
11 chars, e.g. `cf_pat_9f2a`) for display. The raw token is returned exactly
once, at creation (`POST /tokens` -> `ApiTokenCreated { token, apiToken }`).

- `GET /tokens` — the caller's own tokens.
- `POST /tokens` — `ApiTokenCreate {name, scope, campaignId?}` -> `ApiTokenCreated`.
- `DELETE /tokens/:id` — own tokens only (404 for someone else's, matching the
  "don't leak existence" pattern used elsewhere).
- Any authenticated **non-dev** user (`dev:*` header users 403 — they have no
  `users.id` row to own a token against).

Two more entry points mint a PAT without going through this self-service
`POST /tokens` route, both funneling through the same `TokensService.mintFor()`
-> `TokensService.create()` access check so the invariant ("caller must have
real base access to `campaignId` when scoped") is enforced identically
everywhere a token can be minted:

- `POST /auth/token` (public) — headless bootstrap, verifies credentials
  first. See "Auth endpoints" above.
- `POST /users/:id/tokens` (admin only) — provisions on behalf of another
  user, checked against *that user's* access. See "Auth endpoints" above.

See "PAT token scope cap" above for how `scope`/`campaignId` cap the
effective role at request time; there's no separate token-auth code path in
the domain controllers — `RoleResolver` does all the work.

### Proposals (pending-approval writes)

Table `proposals` (`id, campaignId, entityType, entityId NULL, action
create|update, payload JSON, proposer, status pending|approved|rejected,
resolvedBy, note, createdAt, updatedAt`).

- **Write-path integration**: `POST`/`PATCH` on quests, npcs, locations,
  sessions (create + update only — not delete/status/objectives) accept
  `?proposed=true`. Any role that can **read** the campaign may propose
  (viewer included) — the body is still validated against the normal
  Create/Update Zod schema, then stored as a pending `Proposal` instead of
  being applied; response is `202 {proposal}`. A dm submitting with
  `?proposed=true` also gets a pending proposal, not a direct write — useful
  for AI-with-dm-token flows that want a review step.
- `GET /campaigns/:id/proposals?status=` — dm only.
- `POST /proposals/:id/approve` `{note?}` — dm only; re-validates the stored
  payload and applies it through the **same** service `create()`/`update()`
  method the direct write endpoint uses (so every invariant — e.g. quest
  objective dm-only text edits, character owner checks — still holds), then
  marks the proposal `approved` with `resolvedBy`/`note`.
- `POST /proposals/:id/reject` `{note?}` — dm only; marks `rejected`, no
  entity change.
- Approving/rejecting an already-resolved proposal is a 403.

**Module split to avoid a DI cycle**: `proposal-records.service.ts` (leaf,
plain CRUD on the `proposals` table, no domain-service dependency) lives in
`ProposalRecordsModule` and is what `QuestsModule`/`NpcsModule`/
`LocationsModule`/`SessionsModule` import for the `?proposed=true` write
path. `proposals.service.ts` (the `approve`/`reject` orchestrator, which
*does* depend on all five domain services to apply an approved proposal)
lives in `ProposalsModule`, which imports `ProposalRecordsModule` plus the
domain modules. If the domain modules imported `ProposalsModule` directly
(instead of the leaf `ProposalRecordsModule`), that would cycle back through
`ProposalsModule -> QuestsModule -> ProposalsModule`.

### Export

`GET /campaigns/:id/export?format=json|mdzip` — dm only.

- **json** (default): single JSON object `{campaign, quests(+objectives),
  npcs, locations, sessions, characters, notes, members, audit, proposals}`.
  `dmSecret` fields are included (role is forced to `'dm'` throughout the
  export, same as any dm request). `notes` uses the **same visibility rule**
  as `GET /notes` (`NotesService.listForCampaign` with the requesting dm's
  identity) — `party_shared` and `dm_shared` notes plus the dm's own
  `private` notes are included; other members' `private` notes are
  deliberately excluded. `members` is the same sanitized shape
  `GET /members` already returns, including the account's `disabled` marker
  (no password/session data ever lived on `CampaignMember`). Imports and clones
  never replay exported memberships: only the authenticated caller becomes the
  new campaign's enabled DM, through the same FK-checked membership path used by
  normal campaign creation. `audit` is capped at the latest 500 entries.
  `Content-Disposition: attachment; filename="campfire-<slug>-<date>.json"`.
- **mdzip**: a zip (via `jszip`, pure-JS, no native dep) of markdown —
  `campaign.md` (+ visible notes), `quests/<slug>.md` (objectives rendered as
  a `- [ ]`/`- [x]` checklist, `dmSecret` as a trailing section),
  `npcs/<slug>.md`, `locations/<slug>.md`, `sessions/<slug-or-number>.md`,
  `characters/<slug>.md` — same dm-secret/notes-visibility rules as the json
  export. `Content-Type: application/zip`, same `Content-Disposition`
  pattern (`.zip` extension). Filenames are slugified (`slugify()` in
  `export.service.ts`) from each entity's display name; collisions within a
  folder simply overwrite (not deduped — acceptable for an export snapshot).
- Both formats write the response manually via `@Res() res` +
  `res.end()`/`res.send()` (not Nest's default return-value handling) —
  returning a `Buffer`/pre-serialized string through Nest's normal
  passthrough path double-encodes it as JSON (`{"type":"Buffer","data":[...]}`),
  which breaks the zip's binary content-type.

## MCP server

The full service layer is exposed as a **Model Context Protocol** server at
`POST /mcp` (Streamable HTTP, **stateless**: fresh `McpServer` + transport per
request, JSON responses, no session ids; `GET`/`DELETE /mcp` return 405). The
route lives outside the `/api/v1` prefix (like `healthz`) but is **not**
`@Public()` — the global `SessionAuthGuard`'s Bearer path is the auth.

**Auth:** `Authorization: Bearer cf_pat_...` (a PAT from `POST /tokens`) or a
real session cookie. `DEV_AUTH` header users are rejected with 401. Every tool
resolves the caller's effective role per campaign via `CampaignAccessService`,
so PAT scope caps (`scope`, `campaignId`) apply exactly as they do over REST,
and audit entries record `token:<name>`.

**Connect from Claude Code:**

```bash
claude mcp add --transport http campfire http://host:8080/mcp \
  --header "Authorization: Bearer cf_pat_..."
```

**Tool catalog** (137 — `modules/mcp/mcp-tools.ts`; see `test/mcp.e2e-spec.ts`'s
`ALL_TOOLS` for the exact, test-pinned list). This is full REST parity: an
agent can run an entire campaign — world-building, session prep, and live
combat — over MCP alone.

- **Read:** `list_campaigns`, `get_campaign_summary`, `get_quest`,
  `list_quests`, `get_npc`, `list_npcs`, `get_location`, `list_locations`,
  `get_character`, `get_party`, `get_session_recaps`, `get_session`,
  `read_inbox` (dm), `list_proposals` (dm), `lookup_rule` (any authed —
  searches installed rule packs; top match includes full body text for
  citation, the rest are summary-only), `list_rule_packs`, `get_rule_entry`,
  `get_encounter`, `list_encounters`, `list_members`, `list_notes`,
  `read_audit_log` (dm), `export_campaign` (dm — full JSON dump incl.
  dmSecret fields, audit log, proposals, encounters).
- **Write — lifecycle:** `create_campaign`, `delete_campaign` (dm; cascades
  every child row), `update_campaign_status` (dm — status/currentLocationId/
  dangerLevel; `sessionCount` is intentionally NOT settable here, it's
  recomputed from actual sessions).
- **Write — quests:** `create_quest`, `update_quest`, `delete_quest`,
  `set_quest_status`, `add_objective` (dm), `update_objective` (done:
  player+, text: dm), `check_objective` (player+, done-only), `remove_objective` (dm).
  Quests support subquests via `parentId`, a `giverNpcId` link, and a
  DM-only `dmSecret` field (stripped from non-DM reads).
- **Write — world:** `upsert_npc`, `delete_npc`, `upsert_location`,
  `delete_location`, `set_location_discovery` (dm — status transition with
  the "current location" demotion side-effect), `add_session_recap`
  (`number` defaults to max+1), `update_session`.
- **Write — characters:** `upsert_character` (player owner or dm),
  `update_character_hp` (exactly one of `delta`|`set`),
  `award_xp` (single character: owner or dm; party-wide/subset: dm; party awards
  default to active PCs and require `includeNonActive:true` for explicitly selected
  inactive/retired/dead historical corrections),
  `level_up_character` (owner or dm — +1 level, optional new `hpMax`),
  `set_character_conditions` (add/remove).
- **Write — notes & inbox:** `add_note`, `update_note`/`delete_note`
  (author only — dm may NOT edit/delete another member's note),
  `submit_inbox_item` (any member — the player -> DM message queue),
  `resolve_inbox_item` (dm; terminal payload is idempotent — an identical retry
  returns the stored result, while a different resolution conflicts).
- **Write — proposals & membership:** `approve_proposal` (dm),
  `reject_proposal` (dm), `add_member`/`update_member`/`remove_member` (dm;
  refuses to demote/remove the campaign's last enabled dm), plus
  `get_membership_integrity`/`repair_campaign_dm` (server-admin authority
  diagnostics/recovery; no campaign-secret access).
- **Write — compendium:** `install_rule_pack` (**server admin**, not just
  campaign dm — checked via `hasServerAdminPower(user)`, matching the REST
  `@ServerRoles('admin')` gate on `POST /rules/packs/install`. A PAT only
  passes this check when it was explicitly minted with `adminEnabled: true`
  by a caller who was themselves a real admin at mint time — an admin's
  ordinary/scope-only token does NOT carry server-admin power by default;
  see "PAT SERVER-admin cap" above).
- **Write — combat:** `roll_dice` (any member), `create_encounter`,
  `add_combatant` (`kind` required; `ruleEntryId` pulls a monster statblock's
  name/hp/DEX-derived `initMod`, `characterId` pulls from a character
  sheet), `update_combatant` (dm any combatant; player only hp/conditions on
  a combatant linked to a character they own), `remove_combatant`,
  `roll_initiative`, `begin_encounter`, `next_turn`, `end_encounter` — mirrors
  the REST `/encounters` state machine, including its
  `preparing -> running -> ended` guards.

**Agent workflow:**

1. **Bootstrap / id discovery.** `list_campaigns` -> pick a `campaignId` ->
   `get_campaign_summary` for the full dashboard (campaign, current
   location, quests+objectives, npcs, locations, characters, sessions, open
   inbox count) in one call. For anything not in the summary (encounters,
   notes, rule entries, members, proposals, audit log), call the matching
   `list_*` tool first to discover ids — e.g. `list_encounters` before
   `get_encounter`/`update_combatant`.
2. **Roles.** Every tool resolves the caller's *effective* role for the
   campaign in question via `CampaignAccessService`/`RoleResolver`:
   `dm > player > viewer` (ranked). dm has full write access plus secrets
   and member/proposal/rule-pack management (rule packs additionally require
   server admin, since they're server-wide, not campaign-scoped); player can
   manage their own character, roll dice, check objectives, and post
   notes/inbox items; viewer is read-only plus dice/notes/inbox. A PAT
   additionally *caps* the effective role to `min(token scope, real
   membership role)` and, if bound to one `campaignId`, 403s on every other
   campaign — even for server admins acting through a scoped token.
   SERVER-admin power (install_rule_pack, and REST-only routes) is capped
   separately and more strictly: it requires the token to have been minted
   with `adminEnabled: true`, not just campaign scope — see "PAT SERVER-admin
   cap" above.
3. **Propose-then-approve.** quest/npc/location/session create+update (incl.
   `set_quest_status`) accept `propose: true`: any member may submit a
   pending `Proposal` instead of writing directly; a dm later calls
   `approve_proposal` (applies it through the normal write path) or
   `reject_proposal`. Not available on objectives, characters, notes,
   campaign status, members, or combat tools — those write directly and are
   already role-gated.
4. **A full campaign-running loop looks like:** `create_campaign` ->
   `upsert_character` (party) -> `upsert_location`/`upsert_npc`/`create_quest`
   (world) -> `create_encounter` -> `add_combatant` (monsters via
   `ruleEntryId` from `lookup_rule`) -> `roll_initiative` ->
   `begin_encounter` -> `update_combatant` (damage/conditions) ->
   `next_turn` (repeat) -> `end_encounter` (writes hp back to characters) ->
   `add_session_recap` -> `export_campaign` to archive.

**Argument validation & errors:**

- Every tool's argument object is `.strict()` — an unknown/misnamed key
  (e.g. `{hpCurrent}` instead of `{hpSet}`) is a validation error, not a
  silently-dropped no-op. This is enforced by passing a prebuilt
  `z.object(shape).strict()` `ZodObject` as the tool's `inputSchema` (rather
  than a raw shape) so the SDK's own arg-parsing uses it directly; a
  strictness violation caught by the SDK surfaces as a protocol-level
  `McpError -32602` (before our handler runs) — the MCP client SDK still
  reports it as `{isError: true, content:[...]}` to the caller.
- Errors raised *inside* a tool handler (403/404/400/409 from the domain
  services) come back as `isError` content whose text is JSON
  `{"error":{"status":<http status>,"code":<short slug>,"message":<detail>}}`
  (`code` is one of `not_found`/`forbidden`/`bad_request`/`conflict`/
  `unauthorized`/`validation_failed`/`internal_error`) — never a bare
  protocol error, so a calling agent can branch on `status`/`code`
  programmatically.
- Tool args are otherwise validated against the same `@campfire/schema` zod
  shapes as the REST DTOs (`QuestCreate.shape` etc. spread into the MCP
  `inputSchema`). Results are JSON text content.
- `list_*` read tools that can return unbounded rows (`get_session_recaps`,
  `list_notes`, `read_audit_log`) accept `limit`/`offset` with sane default
  caps.

## AI provider config (encrypted key storage)

`modules/ai-provider-config` stores the AI provider selection + credentials that
feed the vendor-neutral provider factory (`modules/ai-dm/providers`,
`createAiProvider`). Config lives at **two scopes**:

- **Server default** — `GET/PUT/DELETE /settings/ai-provider` + `POST
  /settings/ai-provider/test`. **Server-admin only.**
- **Per-campaign override** — `GET/PUT/DELETE /campaigns/:id/ai-provider` +
  `POST .../ai-provider/test`. **DM only.** A campaign that has no override (or
  an override with no key of its own) **falls back to the server default** — the
  override can pick its own model on the server's key, or supply its own key.

The **API key is encrypted at rest** (AES-256-GCM, `common/crypto.ts`
`encryptSecret`/`decryptSecret`) and is **write-only**: `PUT` accepts `apiKey`
(omit to keep, a value to set/rotate, `""` to clear), but no read/export/audit/log
ever returns it — a read exposes only `configured: true` + `keyLast4`. The key is
decrypted **in-process only** by `AiProviderConfigService.resolveEffectiveConfig`
(the effective-config resolver `#312` consumes) and handed straight to
`createAiProvider`; it never crosses the wire. Server admins may set
`allowedModels` on the server default to restrict which models a campaign override
may select.

### Encryption key env var

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `AI_CONFIG_KEY` | no | auto-generated keyfile | The secret protecting stored API keys. A **64-char hex** string is used as raw 32-byte key material; anything else is treated as a **passphrase** and stretched with scrypt. When unset, a random key is generated once and persisted to `DATA_DIR/ai-config.key` (mode `0600`). **Back up whichever you use** — losing it makes stored provider keys unrecoverable (by design). Never hardcoded. |

### Provider `baseUrl` host policy (issue #1064)

Outbound AI provider requests honor a server-side SSRF host policy
(`common/ai-provider-baseurl.ts`) on every save, test-connection, model list, and
execution resolve:

- **Always blocked:** cloud metadata / link-local (`169.254.0.0/16`, `fe80::/10`,
  `metadata.google.internal`, Alibaba `100.100.100.200`, …). An allowlist entry
  cannot override this.
- **Blocked by default:** private / loopback hosts (RFC1918, `localhost`, ULA,
  CGNAT `100.64/10`, …). A campaign DM therefore cannot point Test connection at
  internal services unless the operator opts in.
- **Public https hosts** (OpenAI, Anthropic, OpenRouter, …) work unchanged.

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `AI_PROVIDER_ALLOW_PRIVATE_HOSTS` | no | unset (blocked) | Set `1` / `true` to permit private/loopback `baseUrl`s for local model servers (Ollama / llama.cpp / LM Studio). Metadata / link-local stay blocked. Only enable on a trusted single-tenant host. |
| `AI_PROVIDER_BASEURL_ALLOW_HOSTS` | no | unset | Comma-separated hostname allowlist. When non-empty, only listed hosts are accepted (metadata still blocked). Prefer listing `localhost` (or your LAN hostname) over the blanket private opt-in. |
| `AI_PROVIDER_BASEURL_DENY_HOSTS` | no | unset | Comma-separated hostname denylist — always rejected. |

Test-connection failures for a blocked host return the generic
`Provider connection failed.` message so the response does not differentiate
internal-host reachability.

## Driving Campfire as an AI agent

Everything below is the "how does an agent get from zero to a working
session" path — headless credential bootstrap, MCP connect, and where to
discover the rest of the API on its own.

**1. Headless PAT bootstrap — one call, no cookie jar.**

Interactive `POST /auth/login` gives you a session cookie, which is awkward
for a script/agent (needs a cookie jar, doesn't work well as a long-lived
credential). `POST /auth/token` (public) verifies credentials and mints a
personal access token in the **same call**:

```bash
curl -s -X POST http://localhost:8080/api/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "my-agent-user",
    "password": "the-password",
    "tokenName": "agent-session-2026-07-19",
    "scope": "dm",
    "campaignId": null
  }'
# -> {"token":"cf_pat_<48 hex>","apiToken":{"id":1,"scope":"dm","campaignId":null,...}}
```

Use the returned `token` as `Authorization: Bearer cf_pat_...` on every
subsequent REST call or the MCP endpoint — no cookie needed. `scope` caps the
effective *campaign* role (`dm`/`player`/`viewer`, defaults to `viewer` if
omitted); `campaignId` optionally locks the token to one campaign (403 if the
authenticating user has no real access to it). Credential checks are
identical to `POST /auth/login` — same 401 on bad creds, same 403s for
disabled/SSO-only accounts or local-login-disabled non-admins.

By default a minted token carries **no server-admin power**, even if its
owner is a server admin — `scope` only ever caps campaign role, never
server-wide capability (see "PAT SERVER-admin cap" earlier in this doc). To
mint a token that CAN exercise server-admin routes/tools, pass
`"adminEnabled": true`; this is only honored when the authenticating user is
themselves a real admin at mint time (silently downgraded to `false`
otherwise, not rejected):

```bash
curl -s -X POST http://localhost:8080/api/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "my-admin-user",
    "password": "the-password",
    "tokenName": "admin-agent-2026-07-19",
    "scope": "dm",
    "adminEnabled": true
  }'
# -> {"token":"cf_pat_<48 hex>","apiToken":{"id":2,"scope":"dm","adminEnabled":true,...}}
```

**Admin provisioning, for a DM/orchestrator agent setting up a whole table:**
a server admin can mint a token on behalf of *another* user without knowing
their password, via `POST /users/:id/tokens` `{tokenName, scope?,
campaignId?, adminEnabled?}` — scope/campaignId access is checked against the
**target** user, not the admin, so this can't be used to hand out campaign
access the target user doesn't already have. `adminEnabled: true` is
additionally honored only when BOTH the calling admin currently holds real
(non-token-capped) server-admin power AND the target user is themselves a
server admin.

```bash
curl -s -X POST http://localhost:8080/api/v1/users/7/tokens \
  -b admin-session-cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"tokenName": "player-bot", "scope": "player", "campaignId": 3}'
```

**2. Connect an MCP client (e.g. Claude Code):**

```bash
claude mcp add --transport http campfire https://<host>/mcp \
  --header "Authorization: Bearer cf_pat_..."
```

Then `tools/list` over that connection enumerates the full tool catalog (see
"MCP server" above for the complete list and the agent workflow walkthrough).

**3. Discover the REST API from OpenAPI.** Every controller is tagged and
every route carries a `summary`/`description` and documented response
statuses, so `GET /api/openapi.json` is a complete, accurate machine-readable
map of the REST surface — point any OpenAPI-aware tool/codegen at it
directly, or browse the human-friendly rendering at `GET /api/docs`. Query
params that filter list endpoints (`status`, `mine`, `entityType`,
`entityId`, `format`, `proposed`) are documented with `@ApiQuery` so their
accepted values are visible without reading source. Request/response bodies
reference the same `@campfire/schema` Zod shapes used for runtime validation
(via `nestjs-zod`'s `patchNestJsSwagger()`), so the documented schema and the
enforced schema can never drift apart.

**4. Expect strict validation on write bodies.** Combatant, character,
campaign, and quest create/update bodies reject unknown keys with a 400
(`{errors: [{code: 'unrecognized_keys', keys: [...]}]}`) instead of silently
ignoring them — see "Validation approach" below for the full list and
rationale. If a write 200s but nothing changed, that's a sign the *other*
(not-yet-strict) DTOs are still in lenient mode; check the response body
matches what you expected either way.

## Rule packs (Compendium backend)

Server-wide (not per-campaign) rules content — spells, monsters, magic items,
conditions — imported from an **openly-licensed** source and cached locally
so the Compendium/Reader screens and the `lookup_rule` MCP tool can search it
without hitting a third party on every request. `Campaign.ruleSystem`
(additive field, see below) records which pack slug a campaign is using; it's
informational only — installing/uninstalling a pack is server-wide and
doesn't depend on any campaign having picked it.

**Tables** (`db/bootstrap.sql.ts`): `rule_packs` (`id, slug UNIQUE, name,
version, license, sourceUrl, installedAt, entryCount`), `rule_entries` (`id,
packId, slug, name, type, summary, body, dataJson NULL, createdAt,
updatedAt`). `type` is one of `spell | monster | item | class | race | feat |
condition | section | other` (`RuleEntryType` in `@campfire/schema`). The
Open5e importer populates `spell`/`monster`/`item`/`condition`/`class`/
`race`/`feat`; `section`/`other` remain available to uploaded and other-system
packs.

### Endpoints

- `GET /rules/packs` — any authenticated user.
- `POST /rules/packs/install` — **server admin or DM of any campaign**.
  Body: `{source: 'open5e', url?, sections?}` (`RulePackInstall`). `url`
  overrides the Open5e API base (used by tests against a local fake server;
  omit it in production to hit `https://api.open5e.com/v2`). `sections`
  defaults to all seven (`spells`, `monsters`, `items`, `conditions`, `classes`,
  `races`, `feats`); pass a
  subset to import only some. Installing when the `open5e-srd` pack already
  exists refreshes matching entries from the requested sections in place and
  incrementally adds entries that are not already present. Entry ids and manual
  icon overrides survive the refresh.
- `DELETE /rules/packs/:id` — server admin only. Deletes the pack and all its
  entries in one transaction; any encounter combatant whose `ruleEntryId`
  pointed at one of those entries (set via `POST /encounters/:id/combatants`
  with an explicit `ruleEntryId`, e.g. a monster statblock) gets that field
  nulled out in the **same** transaction, so it's never left dangling. Adding
  a combatant with a `ruleEntryId` that doesn't resolve to a real row is
  itself rejected 400 (`EncountersService.addCombatant`), for the same reason.
- `GET /rules/search?q=&type=&pack=` — any authenticated user. `q` is
  optional (omit it to browse by `type`/`pack` alone); `type` filters to one
  `RuleEntryType`; `pack` filters to one pack slug. Returns up to 50 entries
  (list shape, no `body` truncation — the Reader/Compendium screens fetch the
  full entry by id when the user opens one).
- `GET /rules/entries/:id` — any authenticated user. Full entry including
  `body` and `dataJson`.

### Open5e importer (`modules/rules/open5e-importer.ts`)

Targets the **v2** API (`https://api.open5e.com/v2/`) — verified against the
**live** endpoints during development (2026-07-22), not assumed from docs,
because v1 and v2 disagree in ways that would silently break a mapper written
against stale documentation:

- There is **no `/v2/monsters/` route**. The monster/statblock list lives at
  `/v2/creatures/`; the importer fetches that path but still stores results
  as Campfire's `type: 'monster'` (our vocabulary, not Open5e's).
- Every list is paginated (`{count, next, previous, results}`); `next` is a
  full URL, so the importer just follows it rather than re-deriving page
  numbers.
- Display fields are nested in sub-objects, not flat strings — e.g. spell
  `school.name`, creature `type.name`/`size.name`, magic item
  `category.name`/`rarity.name`. The mapper reads `.name` with `?? ''`
  fallbacks throughout, since Open5e's community-maintained data isn't
  perfectly uniform entry-to-entry.
- Creature passives arrive in v2 as `traits[]`. Regular actions, reactions and
  legendary actions all arrive in one `actions[]` collection, distinguished by
  `action_type`; attack details are nested in `attacks[]`, and recharge/per-day
  limits in `usage_limits`. The importer partitions those into stable
  `specialAbilities`, `actions`, `reactions`, and `legendaryActions` arrays in
  `dataJson`. It adds camelCase attack bonus, damage, save, usage, and legendary
  cost fields where the source provides (or, for saves, states) them, while
  retaining the original `desc` and nested source fields unchanged.
- License isn't a per-entry field; it's read from each row's own
  `document.licenses[].name` (falls back to `'OGL/CC'` if a section returns
  entries with no license info at all — this has not been observed in
  practice but is handled rather than left to throw).

**Resilience & caps:**

- Each section fetch has a 30s timeout (`AbortController`); a timeout,
  non-2xx response, or unparseable JSON becomes a `BadRequestException`
  (clean 400) rather than an unhandled fetch error.
  A single malformed row within an otherwise-good page is skipped, not fatal
  to the whole import.
- **`MAX_ENTRIES_PER_SECTION = 2000`** — pagination stops once a section hits
  this cap, so one install can't pull unbounded data from a third-party API
  into the local DB. (Open5e's `spells`/`creatures`/`magicitems` sections
  each currently return low thousands of rows across all supported game
  systems — see "One pack per source" below re: why this matters less than
  it sounds.)
- **Pagination is same-origin only.** A page's `next` link is only followed if
  it resolves to the same origin (scheme+host+port) as the configured
  `baseUrl`/`url` — a misbehaving or malicious upstream returning a
  cross-origin `next` link can't redirect the importer into fetching from an
  arbitrary third party. Pagination just stops in that case (not an error);
  whatever was collected so far is kept.
- **Skips are counted and logged, not silent.** Both a malformed row (mapper
  throw) and a refused cross-origin `next` link increment a per-section
  skip counter; if any skips happened, `fetchOpen5eSection` logs a one-line
  `console.warn` summary for that section, and `RulesService.installFromOpen5e`
  logs a second summary across all requested sections plus records the total
  skip count in the `rulepack.install` audit log entry's `detail`.
- Sections are fetched **concurrently** (`Promise.all`) — one slow/failed
  section fails the whole install (still transactional — see below), rather
  than partially importing.

**Transactional write:** pack row + all entry rows are inserted inside one
`db.transaction()` (better-sqlite3's synchronous transaction API — same
pattern as `QuestsService.remove()`'s subquest-promotion fix), so a crash or
constraint violation mid-import never leaves a pack with a wrong
`entryCount` or partial entries.

### Search: FTS5 with a LIKE fallback

`db.module.ts` **probes** for the SQLite `fts5` extension at boot by
attempting the real `CREATE VIRTUAL TABLE ... USING fts5(...)` DDL from
`bootstrap.sql.ts`'s `RULE_ENTRIES_FTS_SQL` (content table `rule_entries`
itself, `content_rowid='id'`, kept in sync via `AFTER INSERT/UPDATE/DELETE`
triggers) — not by checking a version string, since availability depends on
how the specific `better-sqlite3` native build was compiled, which a version
number doesn't reliably tell you. The result is exposed as a DI token
(`RULE_ENTRIES_FTS_AVAILABLE` in `db.module.ts`) that `RulesService` injects.

- **FTS5 available** (the common case — better-sqlite3's bundled SQLite ships
  it): `search()` runs an `fts5 MATCH` query, tokenized with a trailing `*`
  per word for prefix matching (e.g. `fire` matches `Fireball`).
- **FTS5 unavailable**: falls back to a `LIKE '%q%'` scan across
  `name`/`summary`/`body`. Slower on a large corpus, but functionally
  correct, and the 2000/section cap keeps a LIKE scan cheap enough in
  practice for a self-hosted single-table-per-pack corpus. This path is
  covered by the same importer/mapper code — only the query strategy
  differs — so `type`/`pack` filtering behaves identically either way.

### `Campaign.ruleSystem` (additive schema field)

`Campaign` gained `ruleSystem: z.string().max(80).default('')` — the slug of
the installed rule pack a campaign is using, or `''` if unset. Purely
descriptive (no FK enforcement against `rule_packs.slug` — a campaign can
reference a slug for a pack that's since been uninstalled; the UI is expected
to handle that as "pack no longer installed" rather than the server
rejecting the PATCH). Existing DBs get the column via
`migrateCampaignsTableForRuleSystem` in `db.module.ts` — a plain
`ALTER TABLE campaigns ADD COLUMN rule_system TEXT NOT NULL DEFAULT ''`
(simpler than the OIDC `password_hash` migration above since this column has
no constraint that needs relaxing, just adding). `PATCH /campaigns/:id`
already applies `CampaignUpdate` generically (`{...input, updatedAt}`), so
`ruleSystem` passes through with no controller/service change beyond adding
it to the schema and the `create()` insert.

### `lookup_rule` MCP tool

Registered in `registerReadTools` (`modules/mcp/mcp-tools.ts`) — any
authenticated caller (no campaign-role check, since rule packs are
server-wide, not campaign-scoped, unlike every other MCP tool). Returns up to
5 matches; only the **first** (best) match includes its `body` — the rest are
summary-only, to keep the tool result compact for a model that's scanning
several candidates before deciding which one to cite.

### One pack per source (current simplification)

The importer always installs under a single fixed slug, `open5e-srd`,
regardless of which `sections` were requested — installing `sections:
['spells']` then later wanting to add `monsters` requires uninstalling and
reinstalling with both sections, not an incremental "add a section" call.
This matches the task scope (install/uninstall, not incremental pack
editing) and keeps the 409-on-duplicate-slug check simple; a future version
could support multiple named packs per source (e.g. per game system) by
deriving the slug from the request instead of hardcoding it.

## Validation approach

**nestjs-zod, chosen over a hand-rolled pipe.** Every request body schema is
wrapped with `createZodDto(SomeZodSchema)` from `@campfire/schema` (e.g.
`export class CampaignCreateDto extends createZodDto(CampaignCreate) {}`) and
used directly as the `@Body()` parameter type. A single global
`APP_PIPE` (`nestjs-zod`'s `ZodValidationPipe`) inspects each parameter's
resolved metatype for the `isZodDto` marker and validates/parses against it
— no per-route `@UsePipes()` needed. Validation failures come back as
`{statusCode: 400, message: "Validation failed", errors: [...zod issues]}`.

`patchNestJsSwagger()` is called once in `main.ts` before the Nest app is
created; it patches `@nestjs/swagger`'s schema generation so it can render
Zod-shaped DTOs (rather than only class-validator ones), so `/api/docs` shows
real request/response schemas without hand-written `@ApiBody()` decorators.

One schema needed a workaround: `HpPatch` is `z.union([{delta}, {set}])`.
TypeScript can't use a `class Foo extends createZodDto(unionSchema) {}`
because a class's instance type can't be a bare union. `characters.dto.ts`
works around this with a type/value declaration merge — `HpPatchDto` the
*type* is `z.infer<typeof HpPatch>` (the union, for `@Body()` typing);
`HpPatchDto` the *value* is a plain class carrying the `isZodDto`/`schema`
statics the pipe and Swagger patch look for. Runtime behavior (validation,
Swagger doc) is identical to any other `createZodDto` DTO.

**Strict validation on the highest-risk write bodies.** By default a plain
`z.object(...)` **silently strips unknown keys** rather than rejecting them —
`schema.safeParse()` (what `nestjs-zod`'s `ZodValidationPipe` calls under the
hood, see `node_modules/nestjs-zod/dist/index.js`'s `validate()`) just drops
anything not in the shape. That's a bad failure mode for API clients
(especially AI agents) sending a slightly-wrong field name: e.g. `PATCH
/encounters/:id/combatants/:cid` with `{hpCurrent: 5}` (the real column name
— `CombatantUpdate`'s actual field is `hpDelta`/`hpSet`) previously validated
fine and 200'd having done **nothing**, with no signal that the field was
ignored.

Fix: `CombatantCreate`/`CombatantUpdate`, `CharacterCreate`/`CharacterUpdate`,
`CampaignCreate`/`CampaignUpdate`, and `QuestCreate`/`QuestUpdate` are now
wrapped with `.strict()` **at the DTO layer only** —
e.g. `encounters.dto.ts`: `createZodDto(CombatantUpdate.strict())` — not on
the shared schema exports themselves in `@campfire/schema`. An unrecognized
key in one of these four entities' write bodies now 400s with a clear
`{errors: [{code: 'unrecognized_keys', keys: [...], message: "Unrecognized
key(s) in object: '...'"}]}` instead of silently no-op'ing.

**Why DTO-layer, not a global pipe flip or a change to the shared schema
package:** `CombatantCreate`/`CombatantUpdate`/`CharacterCreate`/etc. (the
un-`.strict()`'d originals) are reused **directly** via `.parse()` well
outside the DTO/pipe path — `modules/mcp/mcp-tools.ts` builds MCP tool
schemas straight from `...CombatantCreate.shape` /
`CombatantUpdate.parse(fields)`, and `modules/quests/quests.controller.ts`
(and the equivalent npcs/locations/sessions controllers) re-`.parse()` the
already-pipe-validated `body` a second time on the `?proposed=true` branch
before storing it as a `Proposal` payload. Mutating the shared exports to add
`.strict()` would ripple into both of those reuse sites (and — since the
same schemas double as OpenAPI *response* shapes — into Swagger schema
generation) well outside this task's scope. Wrapping only the `@Body()` DTO
class's schema with `.strict()` confines the change to exactly the pipe's
`transform()` call for that one route parameter; the redundant re-`.parse()`
calls above are unaffected (and unreachable with an unknown key anyway, since
the DTO layer already 400'd before the controller body runs), and MCP tool
input schemas (owned by a different scope) are untouched.

**Scope chosen, and why not broader:** only these four entities'
create/update bodies (the ones explicitly called out as highest-risk —
frequent agent-driven writes with several similarly-named numeric/enum
fields) were made strict, not every DTO server-wide. A global flip (patching
`ZodValidationPipe` itself, or `.strict()`-ing every `z.object` in
`@campfire/schema`) was judged too risky to land in the same change as
everything else here: some schemas are intentionally reused in non-DTO
contexts (see above), and auditing every one of the ~25 remaining request
schemas for a hidden reliance on lenient parsing was out of scope for this
pass. Extending `.strict()` to the remaining write DTOs (npcs, locations,
sessions, members, notes, settings, users) is a natural follow-up using the
exact same one-line-per-DTO pattern.

## SQLite / drizzle

- File: `${DATA_DIR:-apps/server/data}/campfire.db`, WAL journal mode.
- On boot, `db/bootstrap.sql.ts` runs idempotent `CREATE TABLE IF NOT EXISTS`
  + index statements directly via `better-sqlite3`'s `.exec()`. No
  drizzle-kit migrations for this milestone (per spec) — `db/schema.ts`'s
  drizzle table defs are hand-kept in sync with the bootstrap DDL.
- JSON-shaped domain fields (`Character.stats`, `Character.conditions`,
  `settings.value`) are stored as `TEXT` columns and (de)serialized in the
  service layer via `common/json.ts` (`toJsonText` / `fromJsonText`) or
  `JSON.parse`/`stringify` directly (`SettingsService`).
- `dmSecret` (quests/npcs/locations) is stored as plain `TEXT` — redaction is
  a response-shaping concern (`common/redact.ts`), not a storage concern.
- The domain `sessions` table (game sessions, `@campfire/schema`'s `Session`)
  predates auth; the new auth-session table is named `user_sessions` in SQL
  (`userSessions` in drizzle) to avoid a name collision.

### Data retention env vars

Per-campaign dice-roll history is retained under a *disclosed, configurable*
policy (issue #614). The shared log used to hard-prune to the newest 200 rolls
on every insert — silently, with no policy or recovery. It now defaults to a
much higher cap, prunes on a background sweep (off the player's insert path),
and discloses the ceiling in the dice-log UI and the
`X-Dice-Rolls-Retention` / `X-Dice-Rolls-Unbounded` response headers on
`GET /campaigns/:id/rolls`.

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `DICE_ROLLS_RETENTION` | no | `1000` | Max dice rolls kept per campaign before the oldest are pruned by the hourly background sweep. `0` or a negative value disables pruning entirely (keep all history — e.g. for tables that ship the DB off-box). The audit log has an analogous `AUDIT_RETENTION_DAYS`. The GET feed's page size (`?limit=`) is independent of this durable ceiling. |

## Prod hardening

`main.ts`'s `bootstrap()` applies (via the exported `configureApp()`, which
`test/main-hardening.e2e-spec.ts` also exercises directly against a
`Test.createTestingModule()`-built app — the only piece of `main.ts` any e2e
suite runs, since `test/test-app.ts`'s bootstraps deliberately skip the rest,
see "Tests" below):

- **`helmet()`** — standard security headers (`X-Content-Type-Options: nosniff`,
  no `X-Powered-By`, etc.), default config, no per-route tuning yet.
- **Body-size limit.** `NestFactory.create(AppModule, { bodyParser: false })`
  disables Nest's default (unbounded) body-parser registration, and
  `configureApp()` registers `express.json({ limit: '1mb' })` +
  `express.urlencoded({ extended: true, limit: '1mb' })` explicitly. Multipart
  uploads (`/attachments`) go through multer's own `FileInterceptor` size cap
  (8MB, see `attachments.service.ts`), not these parsers, so this limit doesn't
  affect them. A JSON body over 1MB gets a 413.
- **CORS, env-driven (`resolveCorsOrigin()` in `main.ts`).** `ORIGIN` env
  (comma-split, e.g. `ORIGIN=https://campfire.example.com,https://alt.example.com`)
  takes priority whenever set, in any environment. Otherwise, outside
  production (`NODE_ENV !== 'production'`), CORS defaults to the Vite dev
  server origin (`http://localhost:5173`) — matches every existing dev/e2e
  workflow unchanged. In production with no `ORIGIN` set, CORS is **not
  enabled at all** — the deployment plan is same-origin serving (the web build
  served by this same API process or a reverse proxy in front of both), so no
  cross-origin requests are expected unless an operator opts in via `ORIGIN`.
- **Swagger exposure, env-driven (`resolveDocsEnabled()` in `main.ts`).**
  `/api/docs` + `/api/openapi.json` are registered by `setupApiDocs()` only when
  enabled: `API_DOCS` env takes priority whenever set (`1`/`true` force-enables,
  `0`/`false` force-disables, in any environment); otherwise the docs are
  enabled outside production and **disabled in production** (the routes simply
  aren't registered, so they 404). The endpoints never leaked data — every real
  route still enforces auth — but the full API surface being browsable by
  anyone who can reach a production server was needless attack-surface
  disclosure. Operators who want public docs (e.g. for agent self-discovery
  against a trusted-network deployment) opt back in with `API_DOCS=1`.
- **`app.set('trust proxy', ...)`** — trusts the first hop's `X-Forwarded-For`
  by default (override with `TRUST_PROXY`, e.g. a hop count or `false`),
  needed for the rate limiter below (and `req.ip`/`req.secure` generally) to
  see the real client IP behind a reverse proxy (Traefik in the reference
  deployment) instead of bucketing every request under the proxy's own
  address.
- **Rate limiting (`@nestjs/throttler`, `ThrottlerGuard` as a global
  `APP_GUARD`, registered before `SessionAuthGuard`/`ServerRolesGuard` so a
  throttled request never reaches session/token resolution).** Two named
  throttlers (`common/throttle.constants.ts`):
  - `default` — loose ceiling (300 req/min/IP) applied to every route; normal
    API/MCP usage should never realistically hit it.
  - `auth` — same loose ceiling at the module level, but overridden per-route
    via `@Throttle({auth: {...}})` to a strict **10 req/min/IP** on the three
    `@Public` credential-checking routes: `POST /auth/login`, `/auth/token`,
    `/auth/setup`. These each run a full scrypt hash/verify (~30ms CPU) on
    unauthenticated input, so without a limit a flood of well-formed,
    wrong-password requests is a cheap CPU-exhaustion DoS. Over the limit ->
    `429`.
  - `THROTTLE_DISABLED=1` (env) fully disables the guard — set automatically
    by `test/test-app.ts`'s helpers so ordinary e2e suites (which legitimately
    fire many rapid auth calls that aren't testing throttling) don't flake;
    `test/throttle.e2e-spec.ts` is the one suite that unsets it to exercise
    the real 429 path end-to-end.

## OpenAPI

`SwaggerModule` mounts the UI at `/api/docs` and raw JSON at
`/api/openapi.json` (both excluded from the global `api/v1` prefix, along
with `/healthz`). Registration is gated by `resolveDocsEnabled()` — enabled
outside production, disabled in production, `API_DOCS` env overrides either
way (see "Prod hardening" above). Session-cookie auth is documented via `addCookieAuth`
(`campfire_session`); `x-dev-role`/`x-dev-user` are still documented as
API-key-style header parameters (`addApiKey`), noted as DEV_AUTH-only. PAT
bearer auth is documented via `addBearerAuth` (scheme id `bearer`,
`cf_pat_<48 hex>` format).

**Full decorator coverage, for agent self-discovery.** Every controller
carries `@ApiTags(...)`; every route carries `@ApiOperation({summary,
description})` plus `@ApiResponse({status, description})` for each status it
can actually return (success and the meaningful error cases — 400/403/404/
409 where applicable), so `/api/openapi.json` is self-describing without
reading source. Every list-filtering query param (`status`, `mine`,
`entityType`, `entityId`, `format`, `proposed`, `q`/`type`/`pack` on rule
search) is documented with `@ApiQuery`, including its accepted enum values
where the param is a closed set. `mcp.controller.ts` is `@ApiExcludeController()`
(MCP has its own protocol-level tool schemas — see "MCP server" above — and
was intentionally left out of the REST-facing OpenAPI doc). Request/response
bodies are the same `@campfire/schema` Zod DTOs used for runtime validation
(via `nestjs-zod`'s `patchNestJsSwagger()`), so the documented shape and the
enforced shape can't drift apart. See "Driving Campfire as an AI agent"
above for how this is meant to be consumed.

## Tests

`test/*.e2e-spec.ts` (jest + ts-jest + supertest) boot the real `AppModule`
via `Test.createTestingModule` with `DATA_DIR` pointed at a fresh
`fs.mkdtemp()` directory per suite (set before `.compile()` so the `DbModule`
provider factory picks it up), and clean the directory up in `afterAll`.
`test/test-app.ts` holds two bootstraps:

- `createTestApp()` — sets `DEV_AUTH=1` before boot, so all the pre-auth
  suites (campaigns/characters/quests/npcs/locations/notes/healthz) keep
  using `x-dev-role`/`x-dev-user` headers unchanged.
- `createTestAppNoDevAuth()` — unsets `DEV_AUTH`, for the new auth-flow
  suites (`auth.e2e-spec.ts`, `membership.e2e-spec.ts`, and the tokens/
  proposals/export suites below), which use a real `supertest.agent()` to
  persist the session cookie across requests. PATs need a real (non-`dev:*`)
  `users.id` to own the token against, so `tokens.e2e-spec.ts`,
  `proposals.e2e-spec.ts`, and `export.e2e-spec.ts` all use this bootstrap
  too, even where they don't directly exercise the Bearer path.

Both also register `cookie-parser` middleware, mirroring `main.ts`, since
`Test.createTestingModule` doesn't run `main.ts`'s bootstrap code.

`test/fake-open5e.ts` is an in-process Express server (same pattern as
`test/fake-idp.ts` for OIDC) serving 2-3 entries per section using the real
v2 response shape, bound to an ephemeral port — `rules.e2e-spec.ts` points
`RulePackInstall.url` at it, so the importer's actual field-mapping code runs
against realistic payloads with no network dependency in CI. It also backs
the `lookup_rule` smoke test in `mcp.e2e-spec.ts`.

Run with `npm run test -w apps/server` (repo root) or `npm test` from this
directory. Jest is configured `maxWorkers: 1` since every suite opens its own
SQLite file — safe to parallelize later if it becomes a bottleneck.

## Deviations from spec

- **Circular DI avoided by dropping cross-service injection for two narrow
  writes.** The spec's natural module graph has `CampaignsModule` depending
  on `LocationsModule`/`SessionsModule` (for the summary endpoint) while
  `LocationsService.discover()` and `SessionsService.create()` need to write
  back to `campaigns` (`currentLocationId`, `sessionCount`). Wiring that
  back-edge with `forwardRef()` compiled fine but blew the stack at runtime
  resolving `InstanceWrapper.getInstanceByContextId` (a real, reproducible
  crash with this Nest/Node version combo, not a typo). Fixed by having
  `LocationsService`/`SessionsService` update the `campaigns` table directly
  via the shared `DB` token instead of injecting `CampaignsService` — same
  DB, no new module edge, no cycle. `CampaignsService` no longer exposes
  `setCurrentLocation`/`bumpSessionCount`.
- **`RoleResolver`/`CampaignAccessService` live in a dependency-free leaf
  module (`membership/role-access.module.ts`), separate from
  `MembershipModule` (which adds `MembersService`/`MembersController` and
  needs `AuditModule`).** Every domain module — including `AuditModule`
  itself, which gates `GET /campaigns/:id/audit` on effective dm role — needs
  `CampaignAccessService`. If `AuditModule` depended on the full
  `MembershipModule` (which itself imports `AuditModule` for member-change
  audit logging), that's a cycle; splitting the leaf module out avoids it
  without `forwardRef()`.
- **`name` in `RequestUser` mirrors `x-dev-user`** for the DEV_AUTH path (no
  identity provider to source a display name from there); real sessions use
  `displayName || username`.
- **`dev:*` header users can't hold `campaign_members` rows** (their `id` is
  a non-numeric `dev:<name>` string, not a `users.id`). `RoleResolver` treats
  `devRole` as an unconditional short-circuit, and `CampaignsService.create`
  skips the auto-dm-membership insert for them. This matches the existing
  e2e suites, which never expect dev-header users to persist membership rows
  — they're treated as omniscient admins for test convenience.
- **`POST /campaigns` is no longer dm-gated** — the old
  `campaigns.e2e-spec.ts` test asserting `player` role got 403 was replaced
  with a test asserting any authenticated user gets 201 (see spec item 5:
  "any authenticated user; creator auto-inserted... as 'dm'"). This is a
  deliberate behavior change, not a regression.
- **Note `mine=true` and `entityId` query params are plain strings on the
  wire**, parsed manually in `notes.controller.ts` rather than through a Zod
  query DTO — the spec's `Note` schemas don't define a query-param shape, and
  a handful of ad hoc optional filters didn't seem worth a new schema in
  `@campfire/schema` (which this task is scoped to leave alone).
- **`tsconfig.tsbuildinfo` caching quirk (pre-existing, unrelated to this
  change):** with `incremental: true` + `nest build`'s `deleteOutDir: true`,
  a stale `.tsbuildinfo` from a previous run can cause `nest build` to delete
  `dist/` and then emit nothing (tsc believes there's nothing to do). It's
  gitignored and never committed, but if a local build produces an empty/
  missing `dist/`, `rm apps/server/tsconfig.tsbuildinfo` and rebuild.
- **`TokenContext` is carried on `RequestUser` itself, not only on the raw
  request.** The alternative (threading a second `tokenContext` parameter
  through every `CampaignAccessService`/`RoleResolver` call site across 9+
  controllers) would have been far more invasive and error-prone. Setting
  `req.user.tokenContext` in `SessionAuthGuard` means every existing
  `access.requireMember(user, campaignId)` / `access.requireRole(user,
  campaignId, min)` call automatically picks up the PAT scope cap with zero
  signature changes — the same reasoning that put `devRole` on `RequestUser`
  originally. `req.tokenContext` is also set (mirrored) for the
  `@CurrentTokenContext()` decorator, for the rare case a handler wants the
  raw token metadata without going through `RequestUser`.
- **`ProposalRecordsService`/`ProposalRecordsModule` split out from
  `ProposalsService`/`ProposalsModule`** for the same reason
  `RoleResolver`/`CampaignAccessService` live in a dependency-free leaf
  module (see above): `QuestsModule`/`NpcsModule`/`LocationsModule`/
  `SessionsModule` need to create proposal rows for `?proposed=true`, but
  `ProposalsModule`'s `approve()` needs to import all four of those modules
  (to apply an approved proposal via the real service). If the domain
  modules imported the full `ProposalsModule`, that's
  `ProposalsModule -> QuestsModule -> ProposalsModule`, a cycle;
  `ProposalRecordsModule` (plain CRUD on the `proposals` table, no domain
  dependency) breaks it.
- **`characters` is deliberately excluded from the `?proposed=true` write
  path** — the task spec's list is "quests, npcs, locations, sessions", and
  `characters` already has its own more permissive owner-or-dm write model
  (`CharactersService.assertCanWrite`), which doesn't map cleanly onto a
  dm-approval queue. `ProposalsService.approve()` still supports applying a
  `character` proposal (the entity-type union includes it, for forward
  compatibility / direct API use), it's just not reachable from the
  characters write endpoints.
- **Export writes the HTTP response manually (`@Res() res` without
  `passthrough`, calling `res.end()`/`res.send()` directly)** instead of
  returning a value for Nest to serialize. Discovered via a failing e2e test:
  returning a `Buffer` (or any value) through Nest's normal
  `@Res({passthrough: true})` path re-serializes it as JSON — a returned
  `Buffer` came back over the wire as `{"type":"Buffer","data":[...]}`
  instead of raw zip bytes, even with `Content-Type: application/zip` set via
  `res.set()`. Bypassing Nest's response handling entirely for this one
  route fixed it.
- **`GET /campaigns/:id/quests` deleting a quest promotes its subquests
  instead of leaving `parentId` pointing at a deleted row.** The spec only
  said "promote subquests to top level... in the same transaction"; the
  service now sets `parentId = NULL` on every direct child before deleting
  the parent, inside one `db.transaction()` alongside the objective/quest
  deletes. Grandchildren (a subquest of a subquest) are unaffected by a
  grandparent's deletion — only *direct* children of the deleted quest are
  promoted, which matches "promote subquests" read literally (one level, not
  a recursive re-parent of the whole subtree).
- **Rule packs are server-wide, gated by `@ServerRoles('admin')`, not by any
  campaign's `dm` role.** The design's "Server admin → Rule systems" screen
  (not a per-campaign settings screen) and the task's explicit "SERVER ADMIN
  only" both point the same way — a campaign's `dm` cannot install/uninstall
  packs for the whole server, only a server admin can. Reads (`GET
  /rules/packs`, `/rules/search`, `/rules/entries/:id`) are open to any
  authenticated user (including dev-header `player`/`viewer`, which — per
  `session-auth.guard.ts` — always carry `serverRole: 'admin'` in the
  DEV_AUTH path; the real server-admin-vs-user gate is only meaningfully
  exercised with real sessions, which `rules.e2e-spec.ts`'s second `describe`
  block does explicitly).
- **Open5e importer always installs under one fixed slug (`open5e-srd`)
  regardless of `sections` requested** — see "One pack per source" in the
  Rule packs section above. Installing another section adds its missing entries;
  reinstalling a previously selected section refreshes its imported content.
  There is no per-section uninstall; removing the pack removes every section.
- **`RuleEntryType` includes `class`/`race`/`section`/`other` even though the
  Open5e importer produces `spell`/`monster`/`item`/`condition`/`class`/`race`/
  `feat`.** `section` and `other` remain available to uploads and other systems.
- **MCP's `update_campaign_status` does not accept a `sessionNumber` field.**
  `campaigns.sessionCount` is a denormalized `COUNT(*)` that
  `SessionsService` recomputes on every session create/delete (see
  `recomputeSessionCount`); it was never part of `CampaignUpdate` and letting
  an agent set it directly would let it drift from the real session count.
  The tool instead documents this in its description; `status`,
  `currentLocationId`, and `dangerLevel` are all settable as intended.
- **Monster combatants added via `add_combatant`'s `ruleEntryId` now get a
  DEX-derived `initMod` instead of always defaulting to 0.** This was a real
  gap in `EncountersService.addCombatant` (in `modules/encounters/`, not
  `modules/mcp/`) found while wiring the MCP `add_combatant` tool: the
  `characterId` resolution path already derived `initMod` from
  `character.stats.DEX`, but the `ruleEntryId` (monster statblock) path left
  `initMod` at whatever the caller passed (default 0) even though
  `open5e-importer.ts`'s `mapCreature` stores the statblock's DEX at
  `dataJson.abilityScores.dexterity`. Fixed by mirroring the same
  `floor((DEX-10)/2)` derivation for that path when `initMod` isn't
  explicitly supplied — covered by a new MCP e2e assertion (fake-open5e's
  Goblin has DEX 14 -> initMod 2) and unaffected by the existing
  `encounters.e2e-spec.ts` initMod assertions (which don't cover the
  ruleEntryId path).
- **Headless PAT bootstrap (`POST /auth/token`) and admin provisioning
  (`POST /users/:id/tokens`) share `TokensService.create()`'s existing access
  check instead of adding a new one.** `TokensService.mintFor(owner, ownerId,
  input)` is a thin wrapper that maps `{tokenName, scope?, campaignId?}` ->
  the existing `{name, scope, campaignId}` shape (defaulting `scope` to
  `'viewer'`) and calls `create(ownerId, mapped, owner)` — the *same*
  `caller` parameter self-service `POST /tokens` already passes as itself.
  For the headless bootstrap, `owner` is the just-credential-verified user
  (so it behaves exactly like that user calling `POST /tokens` themselves).
  For admin provisioning, `owner` is deliberately the **target** user (not
  the admin) — this was the one place a naive implementation could easily
  get wrong (checking the admin's access instead of the target's), so it's
  called out explicitly in both the controller doc comment and a dedicated
  e2e test (`test/users-tokens.e2e-spec.ts`).
- **Strict validation (unknown-key rejection) landed on 4 of the ~16 write-body
  DTO modules (combatant, character, campaign, quest), not server-wide.** See
  "Validation approach" above for the full rationale — the shared
  `@campfire/schema` exports are reused verbatim by `modules/mcp/mcp-tools.ts`
  and by the `?proposed=true` re-`.parse()` branches in
  quests/npcs/locations/sessions controllers, so `.strict()` was applied at
  the DTO layer (`createZodDto(X.strict())`) rather than mutating the shared
  schema objects or flipping the global `ZodValidationPipe`. No existing test
  broke from this change (confirmed via 2 consecutive full green runs before
  and after) — nothing in the existing suite happened to rely on unknown keys
  being silently accepted on these four entities' write bodies.
- **`AuthService.login()` was refactored (not just added to) to extract
  `verifyCredentials(username, password)`** so `POST /auth/token` can share
  the *exact* same credential-check code path (same order of checks, same
  exception types) as `POST /auth/login`, rather than duplicating that logic.
  `login()`'s own behavior/tests are unchanged — it's a pure extract, verified
  by the full existing `auth.e2e-spec.ts` suite still passing unmodified.
- **`UsersModule` now imports `TokensModule`** (for `POST /users/:id/tokens`)
  and **`AuthModule` now imports `TokensModule`** (for `POST /auth/token`).
  Neither introduces a cycle: `TokensModule` (via `RoleAccessModule`) has no
  dependency back on `UsersModule` or `AuthModule`.
