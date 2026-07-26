# Server administration

What the **server admin** does to keep Campfire running — distinct from running a
game (see [Admin vs DM](access-model.md)). The **Admin** area is a set of **sidebar
pages**, visible only to server admins:

| Page | Path | What's there |
|---|---|---|
| **Overview** | `/admin` | A metrics snapshot — entity counts, on-disk DB size, uptime, running version, recent activity — and links to the pages below |
| **Users** | `/admin/users` | Create, reset, disable, delete accounts; diagnose/recover campaign DM authority |
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
  can't demote, disable, or delete your way into a locked-out server. An account also
  cannot be disabled/deleted while it is a campaign's last **enabled DM**; disabled or
  missing accounts never count as backup authority.
- **Campaign authority integrity** reports campaigns with no enabled DM, disabled DM
  seats, and any ghost rows cleaned during migration. It intentionally exposes only
  campaign id/name and authority/repair metadata — no campaign content or DM secrets.
  For a legacy orphan, choose an enabled account and assign it as recovery DM. Recovery
  is refused while any enabled DM already exists, so normal membership controls remain
  the path for healthy campaigns.

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

### Map derivatives — capacity behaviour

Campfire stores a small ladder of downscaled copies ("derivatives") next to every
uploaded image, so a world map or battle map is delivered at a size that fits the
viewer's screen instead of at full resolution every time. Three things are worth
knowing as an operator.

**Upload limits.** An uploaded image is validated from its header *before* anything
decodes it:

| Limit | Value | What it means |
| --- | --- | --- |
| Longest edge | 16,384 px | Larger is rejected (`400`). No mainstream browser can composite a longer edge. |
| Total pixels | 40,000,000 (~40 MP) | Larger is rejected (`413`). Full 8K (7680 × 4320 = 33.2 MP) sits comfortably inside it. |
| File size | 32 MB | Unchanged; enforced by the upload handler. |

The pixel cap is a decompression-bomb defence, not a file-size proxy: a highly
compressible PNG can declare gigapixels in a few hundred kilobytes. Because the
check reads only the container header, a rejected bomb never allocates memory for
its pixels. A DM who legitimately needs a larger map must downscale it before
uploading.

**Disk.** Three rungs are generated — 512 px, 1280 px and 2560 px on the longest
edge, always PNG. A rung is **skipped** when the source is already at or below it,
so a 400 px portrait costs nothing extra. As a rule of thumb, a large map's
derivatives add roughly **40–70% on top of the original** (the 2560 px rung
dominates; a JPEG source can even exceed its own original, because derivatives are
lossless PNG). Derivatives count toward the on-disk total reported in the storage
console but **not** toward a campaign's storage quota, which measures uploaded
originals only. Budget accordingly: a 10 GB library of large maps should be planned
as roughly 15–17 GB on disk.

**Backlog.** Generation runs in the background — one image at a time, in batches, on
a single worker. Peak memory is bounded by one decoded frame (40 MP × 4 bytes ≈
160 MB) plus encoder scratch, so a burst of uploads queues rather than piling up in
memory. While an image's rungs are still pending, a request for a smaller size is
answered with the **original**, and the response carries
`X-Campfire-Derivative: original-fallback`; the DM sees a "preparing faster map
sizes" note on the map itself. A restart does not lose queued work: the ladder lives
in the database, pending rungs resume on the next boot, and images that predate this
feature are adopted a few hundred per boot until the backlog clears.

**When generation fails.** A rung retries automatically three times, then parks as
`failed` with the underlying error — and the map keeps rendering from its original
throughout. The DM can re-run generation from the map surface ("Refresh sizes"),
which re-plans the ladder from the current source bytes; that is also the fix for a
derivative left **stale** by a restore that replaced an image in place. Nothing
about a failed ladder blocks viewing, uploading, exporting or backups.

## Audit (Admin → Audit)

A server-wide trail of admin actions not tied to any one campaign (account creation,
settings changes, pack installs), alongside the existing per-campaign audit.

Each entry is **attributed** to the role its actor was actually exercising when they
acted, so an incident reviewer can tell the two scopes apart:

- **Server-scoped entries** (`campaign` column empty) carry `actorRole: admin` when a
  server admin exercised server-wide power — creating/disabling/deleting accounts,
  resetting passwords, minting admin tokens, changing server settings, installing or
  removing rule packs, and changing the AI provider config or model allowlist. A
  campaign-DM performing one of the DM-allowed admin actions (e.g. installing a rule
  pack, which DMs may do) is attributed `dm` instead — the honest role at the time.
- **Campaign-scoped entries** (tied to a campaign) carry the actor's effective campaign
  role (`dm`/`player`/`viewer`) for that campaign. A server admin who is also a member
  of a campaign is recorded by their campaign role there, never as `admin` — server
  power is not story access (see [Admin vs DM](access-model.md)).

In the UI, server-admin-attributed entries show a **Server admin** badge, distinct
from a campaign **DM**, so a reviewer can scan for privileged operator actions.
Entries written before this attribution landed all read `dm`; they represent the older
lossy state and are not retroactively rewritten.

## API tokens & AI (per-user)

Any user can mint **API tokens** for connecting an AI or automation over the REST API
and MCP — see [Connect an AI](../ai/connect.md). Token scope caps what the holder can
do; treat a token like a password. An admin can list and revoke another user's tokens.

## Keeping admin and campaigns separate

Being the server admin does **not** make you the DM of every campaign — you manage
accounts, settings, and content, but you don't automatically see campaigns' DM
secrets. Authority diagnostics do not change that: only an explicit recovery
assignment creates a membership for the selected target account. See
[Admin vs DM](access-model.md) for the full model.
