# Campfire — one-command recipes. Run `just` to list.

set shell := ["bash", "-uc"]

default:
    @just --list

# Install all workspace dependencies
setup:
    npm install

# Run backend (:8080) + frontend (:5173) together, hot-reload.
# Kills port squatters first — a half-dead watcher on 8080 serves stale code
# while migrations silently don't run (learned the hard way).
dev:
    -lsof -ti :8080 | xargs kill -9 2>/dev/null
    -lsof -ti :5173 | xargs kill -9 2>/dev/null
    npm run dev

# Backend only
dev-server:
    npm run dev -w apps/server

# Frontend only
dev-web:
    npm run dev -w apps/web

# Server suite: unit (test/unit) + API e2e (test/*.e2e-spec)
test:
    npm run test

# Server suite, watch mode
test-watch:
    npm run test:watch -w apps/server

# Browser E2E across roles (Playwright — builds the app, needs chromium: just e2e-install)
test-e2e:
    npm run test:e2e

# Whole regression safety net: lint + server unit/e2e + web build + Playwright
test-all:
    npm run test:all

# One-time: fetch the Playwright chromium browser
e2e-install:
    npm run e2e:install -w apps/web

# Type-check + production build of every workspace
build:
    npm run build

# Lint everything that defines a linter
lint:
    npm run lint

# Wipe the local SQLite database (server recreates + remigrates on next start)
db-reset:
    rm -f apps/server/data/campfire.db* && echo "db reset — restart the server"

# Open the interactive API docs (server must be running)
api-docs:
    open http://localhost:8080/api/docs

# Serve the design mockups on :8378
design:
    cd design && python3 -m http.server 8378

# Build the production single-image (server + built web SPA, single container)
docker-build:
    docker build -t campfire:local .

# Run the production image locally on :8081 (host) -> :8080 (container), so it
# doesn't collide with the :8080 dev server. Data persists in the named volume
# `campfire-data` across restarts; `docker volume rm campfire-data` to reset it.
docker-run:
    docker run --rm -it \
        --name campfire-local \
        -p 8081:8080 \
        -v campfire-data:/data \
        campfire:local
