# Server administration

What the **server admin** does to keep Campfire running — distinct from running a
game (see [Admin vs DM](access-model.md)). The **Admin** area is a set of **sidebar
pages**, visible only to server admins:

| Page | Path | What's there |
|---|---|---|
| **Overview** | `/admin` | A metrics snapshot — entity counts, on-disk DB size, uptime, running version, recent activity — and links to the pages below |
| **Users** | `/admin/users` | Create, reset, disable, delete accounts |
| **Rule packs** | `/admin/rules` | Install/remove shared compendium content |
| **AI** | `/admin/ai` | The AI Dungeon Master console (kill switch, token cap, provider health) |
| **Authentication** | `/admin/auth` | Local-login toggle, self-service signup, OIDC/SSO |
| **Storage** | `/admin/storage` | Upload usage, per-campaign quotas, orphan cleanup |
| **Audit** | `/admin/audit` | Server-wide admin-action audit trail |

## Accounts (Admin → Users)

- **Create** a user — username, display name, starting password, and server role
  (admin or user).
- **Reset** a user's password.
- **Disable** or **delete** an account. The **last enabled admin** is protected — you
  can't demote, disable, or delete your way into a locked-out server, and you can't
  delete a user who is the **sole DM** of a campaign without reassigning first.

_(Accounts also get created when someone accepts a DM **invite link**, or — if you
enable it — when someone signs themselves up. See [Admin vs DM](access-model.md).)_

## Sign-in & registration (Admin → Authentication)

- **Allow username/password sign-in** — toggle local login for non-admins. Admins can
  always sign in locally, so you can't lock yourself out.
- **Self-service signup** — toggle open registration. Off by default; when on, anyone
  who can reach the server can create their own account (which then has to be added to
  campaigns). Leave it off if you'd rather gate accounts behind admin-created logins or
  DM invite links.
- **OIDC / SSO** — configure single sign-on here too; see [Authentication](authentication.md).

## Rule packs (Admin → Rule packs)

Install and remove the shared compendium content, from a **per-source picker** (D&D 5e,
Pathfinder 2e, Open Legend live; Pathfinder 1e, Starfinder, 13th Age, OSR from a mirror
URL or upload) — see [The compendium](../guides/compendium.md).

## AI (Admin → AI)

The **AI Dungeon Master console**: a **kill switch** (the server-wide experimental
flag), a **server-wide token cap**, and a **provider health** check. The AI DM is
experimental and off until enabled here — see [What an AI can do](../ai/capabilities.md).

## Storage (Admin → Storage)

Total upload bytes, a per-campaign breakdown with **quotas** and over-quota flags, the
real on-disk total, and an orphan summary (rows-without-file, files-without-row) for
cleanup.

## Audit (Admin → Audit)

A server-wide trail of admin actions not tied to any one campaign (account creation,
settings changes, pack installs), alongside the existing per-campaign audit.

## API tokens & AI (per-user)

Any user can mint **API tokens** for connecting an AI or automation over the REST API
and MCP — see [Connect an AI](../ai/connect.md). Token scope caps what the holder can
do; treat a token like a password. An admin can list and revoke another user's tokens.

## Keeping admin and campaigns separate

Being the server admin does **not** make you the DM of every campaign — you manage
accounts, settings, and content, but you don't automatically see campaigns' DM
secrets. See [Admin vs DM](access-model.md) for the full model.
