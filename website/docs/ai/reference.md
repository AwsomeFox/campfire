# MCP tool & API reference

Campfire exposes the same domain through two machine interfaces, both authenticated
with an **API token** (a `cf_pat_…` bearer). See [Connect an AI](connect.md) to make
one.

## MCP server

- **Endpoint:** `https://<your-host>/mcp` (stateless streamable HTTP, JSON-RPC).
- **Auth:** `Authorization: Bearer cf_pat_…`.
- **Tools:** 64 covering campaigns, quests, objectives, NPCs, locations, characters,
  encounters and combatants, dice, sessions, notes, the inbox, proposals, members,
  rule packs, audit, and export. Call `tools/list` for the live catalogue with full
  input schemas — every tool's arguments are strictly validated and described.
- **Errors** come back as structured JSON: `{ "error": { "status", "code", "message" } }`.
- **Discovery:** use the `list_*` tools to find ids before `get_*`/mutating tools.

Add it to a client:

```bash
claude mcp add --transport http campfire \
  https://<your-host>/mcp \
  --header "Authorization: Bearer cf_pat_…"
```

## REST API

- **Base:** `https://<your-host>/api/v1`.
- **Docs:** interactive Swagger UI at `/api/docs`; the OpenAPI spec at
  `/api/openapi.json` (annotated across every endpoint).
- **Auth:** the same bearer token, or a session cookie for the web app.

### Headless bootstrap

An agent can get a token without a browser by exchanging credentials:

```bash
curl -X POST https://<your-host>/api/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"username":"...","password":"...","tokenName":"agent","scope":"dm"}'
```

A **server admin** can also mint a token *on behalf of* another user
(`POST /api/v1/users/:id/tokens`) — so one assistant can provision a whole table.

Token **scope** (`dm` / `player` / `viewer`) and optional campaign binding cap what
the token can do, enforced identically on REST and MCP.
