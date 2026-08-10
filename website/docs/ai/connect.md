# Connect an AI

Campfire has a built-in **MCP server**, so any [Model Context
Protocol](https://modelcontextprotocol.io) client — Claude Desktop, Claude Code,
or your own agent — can read and write your campaign. Ask it to write the recap,
prep the next session, or run initiative.

!!! note "MCP is separate from the built-in Driver"
    This guide connects an **external MCP agent**. It can use Campfire's REST/MCP
    tools under the token you give it, but it does **not** power Campfire's built-in
    Driver transcript or composer. For the built-in live-play AI, configure a
    server-side provider, choose **Driver** in campaign settings, then open the
    running encounter in **Encounters**. **Co-DM** is a third path: it drafts
    proposals for a human DM and never runs the live session.

## 1. Create an API token

In Campfire, open **API tokens** (in the sidebar or your user menu) and create a
token. Choose a **scope** — this is the safety control:

| Scope | What an AI with this token can do |
|---|---|
| **DM** | Full control of the campaign, including writing directly and approving proposals. Give this to your own trusted assistant. |
| **Player** | Scoped to one character. Writes become **proposals** the DM approves — safe for a player's helper. |
| **Viewer** | Read-only. |

The token is shown **once** — copy it now.

## 2. Point your client at Campfire

Campfire shows the exact command on the token screen. It looks like:

```bash
claude mcp add --transport http campfire \
  https://your-campfire-host/mcp \
  --header "Authorization: Bearer cf_pat_xxxxxxxx"
```

That's it — your client will list Campfire's tools and can start helping.

## Add Campfire as a Claude connector (OAuth — no token to copy)

Claude's **connectors** UI (and any MCP client that speaks remote-server OAuth)
can connect without a hand-copied token. Campfire acts as its own OAuth 2.1
authorization server, so you click **Connect**, log in to Campfire, approve, and
you're linked.

1. In Claude, choose **Add custom connector** and paste your Campfire MCP URL:

    ```
    https://your-campfire-host/mcp
    ```

2. Claude discovers the authorization server automatically (via
   `/.well-known/oauth-protected-resource`), registers itself, and opens a
   **Campfire login + consent** page.
3. Sign in — with your Campfire username/password, or, if you're already logged
   into Campfire in that browser, just approve. If your server uses SSO (OIDC),
   log into Campfire the usual way first, then approve.
4. On the consent screen you can optionally lower the **role cap** (DM → Player →
   Viewer) or **restrict the connection to a single campaign** — the same safety
   controls as an API token. The default grant can never exceed your own role in
   each campaign.

The connection uses short-lived access tokens that refresh transparently, so it
keeps working without re-copying anything. Revoke it any time from your OAuth
client, or an admin can revoke server-side. Refresh tokens rotate after every
use; if an already-rotated token is replayed, Campfire revokes that connection's
whole token family and the client must reconnect.

!!! note "What this needs"
    Nothing to configure — the OAuth endpoints are always available. The flow
    works on local-auth servers and OIDC/SSO servers alike (the login step reuses
    whichever login your Campfire already uses). Connector tokens are always
    scoped to a normal user and **never carry server-admin power**, even for an
    admin account — mint a PAT if you need that.

!!! tip "Headless / unattended agents"
    An agent can also bootstrap without a browser: exchange credentials for a
    token in one call (`POST /api/v1/auth/token`), then use it as the bearer for
    both the REST API and MCP. A server admin can even mint a token *on behalf of*
    a player, so one assistant can provision a whole table. See
    [MCP tool & API reference](reference.md).

## 3. Ask it to do something

Once connected, natural requests just work — the client picks the right tools:

> *"Summarise what happened in our last session as a recap."*

> *"Add a goblin ambush encounter with three goblins from the compendium and roll
> initiative."*

> *"Sweep the scribe inbox — turn the players' notes into quest and NPC updates,
> and leave them as proposals for me to approve."*

!!! note "How this actually runs"
    Sweeping the inbox is not something the agent has to figure out step by step —
    it's a single dedicated `sweep_inbox` tool that reads every open item and files
    each result as a create/update proposal or a skip with a stated reason, using
    the exact same orchestration the web UI's own **Sweep inbox** button calls.
    The `sweep_inbox` tool requires a direct-write DM token (the campaign DM role). So
    there are two equivalent ways to trigger it: ask a connected AI with a direct-write
    DM token in plain language (above), or open **Scribe inbox** in Campfire and click
    **Sweep inbox** directly — no AI client or token required for that path, only an AI
    provider configured for the campaign. See [MCP tool & API
    reference](reference.md) for the tool's full signature.

## Safety: the proposal queue

AI writes don't have to touch your canon directly. Player- and viewer-scoped
tokens (and DM tokens that opt in) create **proposals** instead of edits — a queue
the DM reviews and approves or rejects. Your story stays yours.

See [What an AI can do](capabilities.md) for the full picture of AI-run play.
