# @campfire/server

NestJS API for Campfire, the self-hosted D&D campaign tracker. SQLite storage
via drizzle-orm/better-sqlite3, domain contract imported from
`@campfire/schema` (Zod schemas + inferred types — no shapes redefined here).

## Module map

```
src/
  main.ts                 bootstrap: cookie-parser, CORS (credentials), global prefix, Swagger
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
    health/                  GET /healthz (no prefix, no auth)
    auth/                    AuthService (setup/login/logout/session resolution) + /auth/*, /me, /me/password
    users/                   admin user CRUD (/users) + /users/lookup (any authenticated user)
    settings/                server settings (/settings, admin) — allowLocalLogin, JSON key/value store
    membership/              RoleResolver + CampaignAccessService (effective-role resolution),
                              MembersService/-Controller (/campaigns/:id/members)
    campaigns/                campaigns CRUD (user-scoped list) + GET :id/summary (aggregate)
    characters/                campaign-scoped + /characters/:id, hp, conditions
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
`passwordHash`, `serverRole` admin|user, `disabled`), `user_sessions` (id ->
`tokenHash`, `userId`, `expiresAt`, `lastSeenAt`), `settings` (key/value JSON
store), `campaign_members` (campaignId, userId, role dm|player|viewer,
`characterId`, UNIQUE(campaignId, userId)).

Passwords: `node:crypto` `scryptSync` (N=16384, r=8, p=1, random 16-byte
salt), stored as `scrypt:N:r:p:saltHex:hashHex`; compared with
`timingSafeEqual`. No new native dependency. Sessions: 32 random bytes hex as
the bearer token, cookie `campfire_session` (httpOnly, `sameSite=lax`,
`path=/`, 30-day maxAge, `secure` only when `NODE_ENV=production`); the DB
stores only `sha256(token)`. `lastSeenAt` slides forward at most once/hour on
use (`AuthService.resolveSessionUser`).

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

### Invariants enforced server-side (409 on violation)

- Cannot demote (`serverRole` away from `admin`), disable, or delete the
  **last enabled admin** (`UsersService`).
- Cannot demote or remove the **last `dm` of a campaign**
  (`MembersService`).

Deleting a user cascades to their `user_sessions` and `campaign_members`
rows; their notes/characters are left as-is (`Character.ownerUserId` is a
free-text string, not a FK).

### Auth endpoints

- `GET /auth/status` (public) — `{setupRequired, localLoginEnabled,
  oidcEnabled: false, version}`.
- `POST /auth/setup` (public, only while zero users exist, else 409) —
  creates the first user as `serverRole: 'admin'`, starts a session.
- `POST /auth/login` (public) — 401 generic on bad credentials, 403 if
  disabled, 403 if `serverRole !== 'admin'` and `settings.allowLocalLogin ===
  false` (admins can **always** log in locally — lockout prevention).
- `POST /auth/logout` — deletes the session row, clears the cookie, 204.
- `GET /me` — `{user, memberships}`; `passwordHash` never included; 401 if
  unauthenticated. `dev:*` header users get a synthesized `id: 0` shape with
  no memberships (there's no DB row to read).
- `POST /me/password` — `currentPassword` is **required** here (unlike the
  admin reset endpoint); rehashes, kills every *other* session for that user.
- `GET /users`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id`,
  `POST /users/:id/password` — admin only.
- `GET /users/lookup?query=` — any authenticated user, 2+ chars, max 10
  results — member-picker autocomplete.
- `GET /settings`, `PATCH /settings` — admin only.
- `GET/POST/PATCH/DELETE /campaigns/:id/members[/:memberId]` — dm for
  writes, any member for read.

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
  `GET /members` already returns (no password/session data ever lived on
  `CampaignMember`). `audit` is capped at the latest 500 entries.
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

## OpenAPI

`SwaggerModule` mounts the UI at `/api/docs` and raw JSON at
`/api/openapi.json` (both excluded from the global `api/v1` prefix, along
with `/healthz`). Session-cookie auth is documented via `addCookieAuth`
(`campfire_session`); `x-dev-role`/`x-dev-user` are still documented as
API-key-style header parameters (`addApiKey`), noted as DEV_AUTH-only. PAT
bearer auth is documented via `addBearerAuth` (scheme id `bearer`,
`cf_pat_<48 hex>` format).

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
