# Server administration

What the **server admin** does to keep Campfire running — distinct from running a
game (see [Admin vs DM](access-model.md)). All of this lives under **Admin** in the
top bar and is visible only to server admins.

## Accounts (Admin → Users)

- **Create** a user — username, display name, starting password, and server role
  (admin or user).
- **Reset** a user's password.
- **Disable** or **delete** an account. The **last enabled admin** is protected — you
  can't demote, disable, or delete your way into a locked-out server, and you can't
  delete a user who is the **sole DM** of a campaign without reassigning first.

_(A DM-driven invite flow and optional self-service signup are on the
[roadmap](../reference/roadmap.md); today accounts are admin-created.)_

## Server settings (Admin → Settings)

- **Allow username/password sign-in** — toggle local login for non-admins. Admins can
  always sign in locally, so you can't lock yourself out.

## Rule systems (Admin → Rule systems)

Install and remove the shared compendium content — see
[The compendium](../guides/compendium.md).

## API tokens & AI (Admin, and per-user)

Any user can mint **API tokens** for connecting an AI or automation over the REST API
and MCP — see [Connect an AI](../ai/connect.md). Token scope caps what the holder can
do; treat a token like a password.

## Authentication

Local accounts work out of the box. To put Campfire behind your own single-sign-on,
see [Authentication](authentication.md).

## Keeping admin and campaigns separate

Being the server admin does **not** make you the DM of every campaign — you manage
accounts, settings, and content, but you don't automatically see campaigns' DM
secrets. See [Admin vs DM](access-model.md) for the full model.
