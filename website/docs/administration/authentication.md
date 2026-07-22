# Authentication (local & SSO)

Campfire supports **local accounts** out of the box and optional **OIDC single
sign-on** (built for Authentik, works with any OIDC provider).

## Local accounts

Nothing to configure. The first visit creates the admin; that admin creates other
accounts under **Admin → Users**. Users sign in with username and password and can
change their own password from the user menu.

## OIDC / SSO (optional)

OIDC can be configured two ways — from the **admin UI** or via **environment
variables** — and you can mix them.

### In the admin UI

Go to **Admin → OIDC single sign-on**. Fill in the issuer, client id and secret
(and optionally a provider display name and the admin/allowed groups), press **Test connection** to validate
that the discovery endpoint is reachable, then **Save**. Changes take effect on
the next sign-in — no restart needed. The client secret is write-only: once
saved it is never shown again (the form shows only whether one is set).

### Via environment variables

| Variable | Purpose |
|---|---|
| `OIDC_ISSUER` | Your provider's issuer/discovery URL |
| `OIDC_CLIENT_ID` | The OAuth client id |
| `OIDC_CLIENT_SECRET` | The OAuth client secret |
| `OIDC_REDIRECT_URI` | `https://<your-host>/api/v1/auth/oidc/callback` |
| `OIDC_PROVIDER_NAME` | *(optional)* public login-button name, e.g. `Keycloak`; unset uses neutral `SSO` branding |
| `OIDC_ADMIN_GROUP` | *(optional)* members of this group become **server admins** |
| `OIDC_ALLOWED_GROUP` | *(optional)* when set, only members of this group (or the admin group) may sign in |
| `OIDC_GROUPS_CLAIM` | *(optional)* claim to read groups from (default `groups`) |
| `OIDC_SCOPE` | *(optional)* requested scopes (default `openid profile email`) |

### Precedence

For each field, an environment variable — **when set** — takes precedence over
the value stored via the admin UI; otherwise the stored value (or a built-in
default) is used. This keeps existing env-var deployments working unchanged. The
admin screen marks any field that is currently pinned by the environment with an
**env** badge, so it's clear which values are in force.

OIDC is considered **enabled** only once the effective issuer, client id, and
client secret all resolve to non-empty values.

When enabled, the login page offers **Sign in with &lt;provider&gt;**, using the
configured provider display name or neutral **Sign in with SSO** branding. On
first login, SSO provisions a Campfire account from the token's claims;
membership in the admin group grants the independent server-admin role.
Campaign access and DM/player/viewer roles are assigned inside Campfire, never
from OIDC groups. A user who reaches an empty campaign hub should follow a
campaign invite or ask a DM or server admin to add their account.

!!! warning "Admin membership is re-synced on every login"
    When `OIDC_ADMIN_GROUP` is set, the server-admin role is applied **both
    directions on every login**: a user added to the group is promoted, and a
    user removed from the group is **demoted** back to a plain user the next time
    they sign in. Managing admin membership at your IdP is therefore enough to
    grant or revoke server-admin — you don't also have to change it in Campfire.
    The one exception: the **last enabled admin** is never demoted this way (a
    warning is logged and the role is left in place), so an IdP misconfiguration
    can't lock you out of the server.

By default **any** user who can authenticate at your IdP gets a Campfire account
on first login. On a shared corporate or family IdP that's usually too broad —
set `OIDC_ALLOWED_GROUP` to an IdP group (e.g. `campfire-users`) and Campfire
will refuse sign-in (and skip account provisioning) for anyone outside it. The
check runs on every login, so removing someone from the group locks them out the
next time they sign in. Members of `OIDC_ADMIN_GROUP` can always sign in.

### Sign-in recovery and support references

Expected SSO failures do not leave users on a raw API response. Campfire sends
the browser back to a dedicated same-origin recovery page for cancellation,
expired or missing flows, state/PKCE verification failure, provider outage,
client/token failure, missing claims, sign-in-group denial, and disabled
accounts.

The page offers **Try SSO again**, which creates a new state/PKCE flow. It only
offers username/password sign-in when public auth status says local login is
available. Each failure also shows a random support reference an operator can
match to the server's `OIDC_RECOVERY` diagnostic.

Recovery URLs and UI contain only a fixed safe category and that reference.
Provider error descriptions and payloads, authorization codes, state, PKCE
values, tokens, claims, client secrets, issuer details, and group names are not
copied into the redirect, rendered to the user, or written to the redacted
diagnostic. If a user reports a failure, ask for the support reference rather
than a screenshot of the provider callback URL.

### Authentik quick setup

1. Create an **OAuth2/OpenID Provider** and an **Application** named `campfire`.
2. Set the redirect URI to `https://<your-host>/api/v1/auth/oidc/callback`.
3. Add a **groups** scope/property mapping so group claims are sent; create an
   `admin` group for whoever should administer Campfire.
4. Put the issuer, client id/secret, and `OIDC_ADMIN_GROUP=admin` into Campfire's
   environment.

!!! note "Resilient by design"
    If the IdP is unreachable at boot, Campfire still starts, serves the app, and
    retries discovery on the next login attempt — it won't crash-loop. A failed
    attempt reaches the recovery page with a support reference.

Local first-run setup also works **before** OIDC is configured, so you can stand the
server up, create the admin, then layer SSO on later.

## Rate limiting

Public authentication endpoints (login, invite acceptance, and similar) are
**rate-limited per client IP** to blunt credential-stuffing and brute-force
attempts. Behind a reverse proxy you must set `TRUST_PROXY` (default: trust one
hop) so the limiter sees the real client address instead of the proxy's — see
[Installation → Configuration](../getting-started/installation.md#configuration).
The limiter can be turned off with `THROTTLE_DISABLED=1`, which is intended for
tests only; leave it on in production.
