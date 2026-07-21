# MCP tool & API reference

Campfire exposes the same domain through two machine interfaces, both authenticated
with an **API token** (a `cf_pat_…` bearer). See [Connect an AI](connect.md) to make
one.

## MCP server

- **Endpoint:** `https://<your-host>/mcp` (stateless streamable HTTP, JSON-RPC).
- **Auth:** `Authorization: Bearer cf_pat_…` (personal access token), **or** an
  OAuth access token from the connector flow below.
- **Tools:** 130+ covering campaigns, quests, objectives, story arcs/beats/branches,
  NPCs, locations, factions, characters, encounters and combatants, dice, sessions,
  notes, the inbox, proposals, the AI Dungeon Master seat, members, rule packs, the
  session-zero charter, audit, and export.
  Call `tools/list` for the live catalogue with full input schemas — every tool's
  arguments are strictly validated and described.
- **Resources & prompts:** read surfaces (campaigns, campaign summary, party, session
  recaps, the session-zero charter) are also exposed as MCP **resources**, and the
  server ships prep/recap **prompts** — call `resources/list` and `prompts/list` to
  discover them.
- **Errors** come back as structured JSON: `{ "error": { "status", "code", "message" } }`.
- **Discovery:** use the `list_*` tools to find ids before `get_*`/mutating tools.

Add it to a client:

```bash
claude mcp add --transport http campfire \
  https://<your-host>/mcp \
  --header "Authorization: Bearer cf_pat_…"
```

### OAuth connector flow (no copied token)

Campfire is also its own OAuth 2.1 authorization server, so `/mcp` can be added
as a Claude **custom connector** without a hand-copied token — see
[Connect an AI](connect.md#add-campfire-as-a-claude-connector-oauth-no-token-to-copy).
An unauthenticated `POST /mcp` returns `401` with a
`WWW-Authenticate: Bearer resource_metadata="…"` challenge, which kicks off
discovery. The relevant endpoints (all at the server root, outside `/api/v1`):

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 protected-resource metadata (advertises the authorization server). |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata (endpoints, PKCE, grants). |
| `POST /oauth/register` | RFC 7591 Dynamic Client Registration. |
| `GET`/`POST /oauth/authorize` | Login + consent; issues an authorization code (PKCE, `code_challenge_method=S256`). |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants. |
| `POST /oauth/revoke` | RFC 7009 token revocation. |

Issued tokens honour the same scope/role caps as PATs (DM/Player/Viewer,
optional single-campaign binding) and never carry server-admin power.

## REST API

- **Base:** `https://<your-host>/api/v1`.
- **Docs:** interactive Swagger UI at `/api/docs`; the OpenAPI spec at
  `/api/openapi.json` (annotated across every endpoint). Disabled in
  production by default — set the `API_DOCS=1` environment variable on the
  server to enable them (see
  [Installation → Configuration](../getting-started/installation.md#configuration)).
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
