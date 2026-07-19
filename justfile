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

# All tests
test:
    npm run test

# API e2e tests only, watch mode
test-watch:
    npm run test:watch -w apps/server

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
