# Web E2E (Playwright) — issue #81

A small, high-signal browser suite covering the role-gated flows that were
previously verified only by hand: **DM / player / viewer / admin**. It runs
against the **real** API server serving the **real** built SPA on a single
origin, with a deterministic, fully seeded backend.

Before the seeded role suite, `playwright.first-run.config.ts` runs one browser
journey against a separate pristine database. It creates the first admin through
the real setup form and verifies the in-app cache refresh, campaign-hub redirect,
history replacement, and configured-server auth-route guards. The primary
`playwright.config.ts` suite then starts another fresh backend and seeds the
campaign fixtures described below.

## What it covers

| Spec | Checks |
| --- | --- |
| `first-run/setup.spec.ts` | Pristine DB → setup form → authenticated campaign hub without reload; `/setup` and `/login` redirect safely after configuration and do not remain in browser history. |
| `dmsecret-visibility.spec.ts` | A DM sees an NPC's `dmSecret` panel; a player and a viewer never do (the secret string is absent from their DOM). |
| `combat-tracker.spec.ts` | DM sees exact initiative + HP math (`30 / 30`), running state / round, and the DM-only run controls (Next turn / End / Cast). Player & viewer get a monster's HP **redacted to a band** ("Healthy") and see **no** DM controls or edit inputs. |
| `role-navigation.spec.ts` | Login-per-role smoke + role-appropriate nav: DM gets the "Dungeon master" section (Members/Settings/…), player/viewer don't and read as Player/Viewer; the server-admin console (`/admin`) is reachable by admin and refused to a non-admin. |
| `ai-dialog-accessibility.spec.ts` | AI drafting modal and Co-DM disclosure keyboard flow, focus trap/restoration, inert background, persistent prompt/quantity names and announcements, request-in-flight dismissal, responsive positioning, and axe scans. |
| `notifications.spec.ts` | Shared polling/read behavior plus notification-dialog semantics, accurate item announcements, keyboard focus trap/restoration, Escape/outside-click dismissal, mobile bounds, empty state, and axe scans. |
| `oidc-recovery.spec.ts` | Every safe OIDC recovery category plus success, fresh-retry/local-login affordances, fixed-copy secrecy, heading focus, keyboard order, axe scan, and mobile overflow/touch targets. |

## How auth / seeding works

`global-setup.ts` drives the **public HTTP API** once before any test:

1. First-run `POST /auth/setup` → `admin` (server admin).
2. `admin` creates `dm`, `player`, `viewer` users.
3. `dm` creates a campaign (becomes its DM), adds player + viewer as members,
   creates an NPC with a `dmSecret`, and a **running** encounter with two
   monsters at fixed initiative/HP.
4. A real cookie-session `storageState` is captured per role into
   `e2e/.auth/{admin,dm,player,viewer}.json`; seed ids go to `e2e/.auth/seed.json`.

Specs then `test.use({ storageState })` (via `stateFor(role)`) and land
already-authenticated. `.auth/` is git-ignored.

The server itself is booted by `e2e/server.mjs` (Playwright `webServer`):
built server + `WEB_DIST` pointed at `apps/web/dist`, a fresh temp `DATA_DIR`,
`ALLOW_INSECURE_HTTP=1` (drops HSTS / `upgrade-insecure-requests` so plain-http
localhost works and the session cookie isn't `Secure`-dropped). `DEV_AUTH` is
deliberately **off** — the suite needs real memberships, which the dev-header
bypass can't model.

The suite is intentionally **serial** (`workers: 1`) because all specs share the
one seeded backend.

## Running

```bash
# one-time: fetch the browser
npm run e2e:install -w @campfire/web        # playwright install chromium

# from the repo root — builds schema+server+web, then runs the suite:
npm run test:e2e

# or, if the app is already built, just the suite (from apps/web):
npm run test:e2e -w @campfire/web
npm run test:e2e:ui -w @campfire/web        # headed / interactive
npm run test:e2e:report -w @campfire/web    # open the last HTML report
npm run test:e2e:typecheck -w @campfire/web # type-check the E2E sources
```

In CI the `e2e-web` job (`.github/workflows/ci.yml`) runs
`npx playwright install --with-deps chromium` then `npm run test:e2e --if-present`.
