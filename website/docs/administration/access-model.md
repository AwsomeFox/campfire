# Admin vs DM — the access model

Campfire separates **running the server** from **running a game**. The person who
installs and operates Campfire does not have to be the person who runs a campaign,
and vice versa. This page explains the model and how to keep the two roles apart.

## Two independent axes

Campfire has **two kinds of role**, and they are deliberately independent:

| Axis | Roles | Scope | Answers |
|---|---|---|---|
| **Server role** | `admin`, `user` | The whole server | "Can this person manage accounts, settings, and rule packs?" |
| **Campaign role** | `dm`, `player`, `viewer` | One campaign (a membership) | "What can this person do *inside this campaign*?" |

A single account carries **one server role** and **any number of campaign
memberships**. They don't imply each other:

- A **server admin** who never runs a game is just the operator. They keep the
  lights on — create accounts, install rule packs, configure SSO — and needn't be
  a DM anywhere.
- A **DM** is anyone with the `dm` role in a campaign. Creating a campaign makes
  you its DM automatically. **You do not need to be a server admin to be a DM.**
- A **player** has the `player` role in the campaigns they've joined, and may be a
  DM in others. Roles are per-campaign.

!!! example "Typical home server"
    Alex installs Campfire and is the **server admin**. Alex also plays as a
    **player** in Bri's campaign, and runs their own campaign as **DM**. Bri is a
    plain **user** on the server but the **DM** of their table. Neither needs the
    other's powers.

## What each role can do

=== "Server admin"

    - Create, disable, and delete user accounts
    - Reset any user's password
    - Configure the server: local-login toggle, self-service signup, SSO/OIDC
    - Install and remove rule packs (the shared compendium)
    - **Does _not_** automatically see any campaign's DM secrets (see below)

=== "DM (per campaign)"

    - Everything inside their campaign: quests, NPCs, locations, sessions, the map
    - See and edit **DM-only secrets** on quests, NPCs, locations, characters, and sessions
    - Run encounters, manage the party, read the scribe inbox, approve AI proposals
    - **Invite players** to their campaign (see below) and assign roles
    - Export the campaign

=== "Player (per campaign)"

    - Read the campaign (minus DM secrets)
    - Own and edit their character; tick quest objectives
    - Keep private notes; share notes with the DM or the party
    - Leave notes in the DM's inbox; roll dice

=== "Viewer (per campaign)"

    - Read-only access (minus DM secrets)
    - May leave a quick note in the inbox

## Keeping admin and DM separate

Campfire is built so the operator and the storyteller stay distinct:

- **Admins are not automatic DMs.** A server admin manages the server but is
  **not** silently treated as the DM of every campaign — they do not see the DM
  secrets of campaigns they haven't been added to. Privilege to run the *server*
  is not privilege to read every *story*.
- **DMs are self-sufficient.** A DM can bring their own players in without asking
  the server admin to hand-create each account, using **invites** (below) or
  optional **self-service signup**.

### Getting players in — three ways

How players get accounts is the server admin's choice:

1. **Admin-created accounts** — the admin creates each account under
   *Admin → Users* and tells the DM the usernames. Simplest, fully controlled.
2. **DM invites _(recommended for most tables)_** — the DM generates an invite
   link or join code for their campaign and shares it. A player follows it,
   creates their account, and lands in the campaign with the role the DM chose —
   no admin involvement per player.
3. **Self-service signup** — the admin enables open registration as a server
   setting; anyone can create an account, then be added to campaigns.

!!! info "SSO deployments"
    When Campfire is behind an OIDC provider (e.g. Authentik), accounts are
    provisioned automatically on first login, and an Authentik group can grant
    the **server admin** role. Campaign roles are still assigned inside Campfire.
    See [Authentication](authentication.md).

## Under the hood

- Campaign membership lives in a `campaign_members` table (`campaignId`, `userId`,
  `role`, optional linked `characterId`). `userId` is foreign-keyed to a real
  account; missing users are cleaned safely during upgrade and rejected by REST,
  MCP, and SQLite thereafter.
- The effective role for a request is resolved per campaign; DM secrets and
  private notes are filtered **server-side**, so the separation is enforced by the
  API, not the UI.
- The **last enabled DM** of a campaign and the **last enabled admin** of the server
  are both protected — disabled/missing accounts do not count, and account
  disable/delete is guarded alongside membership demotion/removal. These checks
  are transactional under concurrent REST, MCP, and admin requests.
