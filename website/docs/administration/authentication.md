# Authentication (local & SSO)

Campfire supports **local accounts** out of the box and optional **OIDC single
sign-on** (built for Authentik, works with any OIDC provider).

## Local accounts

Nothing to configure. The first visit creates the admin; that admin creates other
accounts under **Admin → Users**. Users sign in with username and password and can
change their own password from the user menu.

## OIDC / SSO (optional)

Set these environment variables and restart:

| Variable | Purpose |
|---|---|
| `OIDC_ISSUER` | Your provider's issuer/discovery URL |
| `OIDC_CLIENT_ID` | The OAuth client id |
| `OIDC_CLIENT_SECRET` | The OAuth client secret |
| `OIDC_REDIRECT_URI` | `https://<your-host>/api/v1/auth/oidc/callback` |
| `OIDC_ADMIN_GROUP` | *(optional)* members of this group become **server admins** |
| `OIDC_ALLOWED_GROUP` | *(optional)* only members of this group may **sign in at all** |

When these are set, the login page offers **Sign in with <provider>**. On first
login a Campfire account is provisioned automatically from the token's claims;
membership in `OIDC_ADMIN_GROUP` grants the server-admin role. Campaign roles
(dm/player/viewer) are still assigned inside Campfire.

By default **any** user who can authenticate at your IdP gets a Campfire account
on first login. On a shared corporate or family IdP that's usually too broad —
set `OIDC_ALLOWED_GROUP` to an IdP group (e.g. `campfire-users`) and Campfire
will refuse sign-in (and skip account provisioning) for anyone outside it. The
check runs on every login, so removing someone from the group locks them out the
next time they sign in. Members of `OIDC_ADMIN_GROUP` can always sign in.

### Authentik quick setup

1. Create an **OAuth2/OpenID Provider** and an **Application** named `campfire`.
2. Set the redirect URI to `https://<your-host>/api/v1/auth/oidc/callback`.
3. Add a **groups** scope/property mapping so group claims are sent; create an
   `admin` group for whoever should administer Campfire.
4. Put the issuer, client id/secret, and `OIDC_ADMIN_GROUP=admin` into Campfire's
   environment.

!!! note "Resilient by design"
    If the IdP is unreachable at boot, Campfire still starts, serves the app, and
    retries discovery on the next login attempt — it won't crash-loop.

Local first-run setup also works **before** OIDC is configured, so you can stand the
server up, create the admin, then layer SSO on later.
