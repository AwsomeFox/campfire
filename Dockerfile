# syntax=docker/dockerfile:1

# Campfire — single-image production build.
#
# Layout produced in the final stage mirrors the npm-workspaces layout on disk
# (root package.json + node_modules, packages/schema, apps/server) so Node's normal
# CommonJS resolution finds `@campfire/schema` via the node_modules/@campfire/schema
# symlink npm itself creates during `npm ci` — nothing is hand-assembled.
#
# better-sqlite3 (native addon) needs python3/make/g++ to compile from source when no
# prebuilt binary matches the image's libc/arch. Those tools are only ever installed in
# the `deps`/`prod-deps` build stages — the final `runtime` stage stays slim.

ARG NODE_IMAGE=node:24-slim

# ---------------------------------------------------------------------------
# deps: full install (incl. devDependencies) used to build all three workspaces.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/schema/package.json packages/schema/package.json

RUN npm ci

# ---------------------------------------------------------------------------
# build: compile packages/schema, apps/server, apps/web (in that dependency order,
# same as the root `npm run build` script).
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/schema packages/schema
COPY apps/server apps/server
COPY apps/web apps/web

RUN npm run build

# ---------------------------------------------------------------------------
# prod-deps: install-only production dependencies, compiled in an image that still
# has build tools available (better-sqlite3 must be built/fetched for THIS image's
# libc+arch, not copied over from the `deps` stage's dev install).
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/schema/package.json packages/schema/package.json

RUN npm ci --omit=dev --workspace apps/server --workspace packages/schema --include-workspace-root=false

# ---------------------------------------------------------------------------
# runtime: slim final image — no compilers, no dev dependencies, no web/server source.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    WEB_DIST=/app/web-dist \
    DATA_DIR=/data \
    PORT=8080

# Workspace metadata (npm needs these present for node_modules/@campfire/* symlinks
# to resolve correctly, even though we never run `npm install` in this stage).
COPY package.json package-lock.json ./
COPY packages/schema/package.json packages/schema/package.json
COPY apps/server/package.json apps/server/package.json

# Production node_modules (includes the compiled better-sqlite3 native addon and the
# npm-workspaces symlink node_modules/@campfire/schema -> ../packages/schema).
COPY --from=prod-deps /app/node_modules ./node_modules

# Compiled output only — no TypeScript sources ship in the final image.
COPY --from=build /app/packages/schema/dist packages/schema/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist web-dist

RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/main.js"]
