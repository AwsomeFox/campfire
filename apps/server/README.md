# @campfire/server

NestJS API for Campfire, the self-hosted D&D campaign tracker. SQLite storage
via drizzle-orm/better-sqlite3, domain contract imported from
`@campfire/schema` (Zod schemas + inferred types — no shapes redefined here).

## Module map

```
src/
  main.ts                 bootstrap: CORS, global prefix, Swagger
  app.module.ts            wires DbModule + all domain modules + global guards/pipe
  db/
    schema.ts               drizzle table defs mirroring @campfire/schema entities
    bootstrap.sql.ts         CREATE TABLE IF NOT EXISTS DDL, run on boot
    db.module.ts             opens better-sqlite3 (WAL), runs bootstrap SQL, exports DB token
  common/
    user.types.ts            RequestUser, role hierarchy (dm > player > viewer)
    guards/dev-auth.guard.ts DevAuthGuard — reads x-dev-role/x-dev-user headers
    guards/roles.guard.ts    RolesGuard — enforces @Roles(minRole)
    decorators/              @Roles(), @CurrentUser(), @Public()
    redact.ts                strips dmSecret for non-dm
    json.ts                  TEXT<->JSON (de)serialization for stats/conditions
    time.ts                  nowIso()
  modules/
    health/                  GET /healthz (no prefix, no auth)
    campaigns/                campaigns CRUD + GET :id/summary (aggregate)
    characters/                campaign-scoped + /characters/:id, hp, conditions
    quests/                    campaign-scoped + /quests/:id, status, objectives
    npcs/                      campaign-scoped + /npcs/:id
    locations/                 campaign-scoped + /locations/:id, discover
    sessions/                  campaign-scoped + /sessions/:id
    notes/                     campaign-scoped notes + inbox + /notes/:id, resolve
    audit/                     AuditService.log() + GET /campaigns/:id/audit (dm)
```

Each domain module (except health) follows the same shape: a
`<domain>.dto.ts` (Zod DTOs via `createZodDto`), `<domain>.service.ts`
(drizzle queries + domain mapping + audit logging), and one or two
controllers — one mounted at `campaigns/:campaignId/<domain>` for
list/create, one at `/<domain>` for id-scoped routes — per the spec's URL
shape.

## Dev auth (no OIDC yet)

`DevAuthGuard` is a global guard (`APP_GUARD`) that reads two headers on
every request:

- `x-dev-role`: one of `dm | player | viewer`, defaults to `dm` if absent or
  invalid.
- `x-dev-user`: any string, defaults to `dev-user`.

It attaches `req.user = { id, name, role }` (`name` mirrors `id` in dev mode
— there's no identity provider yet to source a display name from). A second
global guard, `RolesGuard`, reads `@Roles(minRole)` metadata set on
controllers/handlers and enforces the hierarchy `dm > player > viewer` (see
`common/user.types.ts::roleAtLeast`). Routes with no `@Roles()` are open to
any authenticated (i.e. any) request. `@Public()` exempts a route from both
guards entirely (used for `/healthz`).

This is intentionally swappable: once real auth (OIDC) lands, `DevAuthGuard`
is replaced by a guard that verifies a token and populates the same
`RequestUser` shape; `RolesGuard` and every `@Roles()` annotation are
unchanged.

Beyond role-gating, two authorization rules are enforced in the **service**
layer (not guards), because they depend on entity state, not just role:

- Characters: `PATCH /characters/:id`, `POST /characters/:id/hp`,
  `POST /characters/:id/conditions` require `role === 'dm'` OR
  `req.user.id === character.ownerUserId` (`CharactersService.assertCanWrite`).
- Notes: visibility filtering (`private` / `dm_shared` / `party_shared`) and
  the "author-only edit, even DM can't edit others' notes" rule live in
  `NotesService` (`canSee` helper). `GET /notes/:id` on a note the caller
  can't see returns 404, not 403, so visibility is not leaked by status code.

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
- JSON-shaped domain fields (`Character.stats`, `Character.conditions`) are
  stored as `TEXT` columns and (de)serialized in the service layer via
  `common/json.ts` (`toJsonText` / `fromJsonText`).
- `dmSecret` (quests/npcs/locations) is stored as plain `TEXT` — redaction is
  a response-shaping concern (`common/redact.ts`), not a storage concern.

## OpenAPI

`SwaggerModule` mounts the UI at `/api/docs` and raw JSON at
`/api/openapi.json` (both excluded from the global `api/v1` prefix, along
with `/healthz`). `x-dev-role` / `x-dev-user` are documented as API-key-style
header parameters (`addApiKey`) on the `DocumentBuilder` config so they show
up in the "Authorize" dialog in Swagger UI.

## Tests

`test/*.e2e-spec.ts` (jest + ts-jest + supertest) boot the real `AppModule`
via `Test.createTestingModule` with `DATA_DIR` pointed at a fresh
`fs.mkdtemp()` directory per suite (set before `.compile()` so the `DbModule`
provider factory picks it up), and clean the directory up in `afterAll`.
`test/test-app.ts` holds the shared setup/teardown and — importantly — also
calls `app.setGlobalPrefix('api/v1', {...})`, mirroring `main.ts`, since
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
- **`name` in `RequestUser` mirrors `x-dev-user`.** The spec doesn't define a
  display-name source for dev auth, so `req.user.name === req.user.id`. Real
  auth will source a proper display name from the identity provider.
- **Note `mine=true` and `entityId` query params are plain strings on the
  wire**, parsed manually in `notes.controller.ts` rather than through a Zod
  query DTO — the spec's `Note` schemas don't define a query-param shape, and
  a handful of ad hoc optional filters didn't seem worth a new schema in
  `@campfire/schema` (which this task is scoped to leave alone).
