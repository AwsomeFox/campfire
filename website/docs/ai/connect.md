# Connect an AI

Campfire has a built-in **MCP server**, so any [Model Context
Protocol](https://modelcontextprotocol.io) client — Claude Desktop, Claude Code,
or your own agent — can read and write your campaign. Ask it to write the recap,
prep the next session, or run initiative.

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

## Safety: the proposal queue

AI writes don't have to touch your canon directly. Player- and viewer-scoped
tokens (and DM tokens that opt in) create **proposals** instead of edits — a queue
the DM reviews and approves or rejects. Your story stays yours.

See [What an AI can do](capabilities.md) for the full picture of AI-run play.
