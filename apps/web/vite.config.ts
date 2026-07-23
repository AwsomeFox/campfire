import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { version as pkgVersion } from "./package.json";

export default defineConfig({
  // Single-source the app version from apps/web/package.json (kept equal to the
  // root/server package.json by scripts/check-version-sync.mjs + the Docker
  // APP_VERSION stamp) so signed-out surfaces (e.g. the login footer) report
  // the real build version without an authed /admin/metrics call (issue #432).
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      // We register the SW ourselves from main.tsx via `virtual:pwa-register`.
      injectRegister: false,
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "Campfire",
        short_name: "Campfire",
        description:
          "Campfire — run your tabletop games: sessions, notes, world, combat and compendium.",
        theme_color: "#9184d9",
        background_color: "#161826",
        display: "standalone",
        // Issue #797: do not lock the installed PWA to portrait — encounter maps,
        // AI table, and player display need landscape on tablets/phones. `"any"`
        // lets the OS/user rotate freely; there is no route-local Screen Orientation
        // lock (any future lock must be user-initiated, reversible, and failure-tolerant).
        orientation: "any",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Precache the app shell so it opens offline between sessions.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
        // Offline navigations fall back to the cached SPA shell...
        navigateFallback: "index.html",
        // ...except backend routes, which must never resolve to the shell.
        navigateFallbackDenylist: [/^\/api/, /^\/healthz/, /^\/readyz/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Read-only GETs (e.g. campaign summary) stay available offline by
            // serving the last successful response from cache — but ONLY as a
            // fallback. NetworkFirst here means: whenever the network can be
            // reached the live response wins and the render reflects the API;
            // the cache is consulted solely when the fetch genuinely fails
            // (offline). We deliberately do NOT set `networkTimeoutSeconds`: a
            // timeout would let a slow-but-online backend (e.g. a cold server
            // right after a login/seed) fall back to a stale cached body and
            // render it as truth for a full page view (issue #268). Waiting for
            // the real response is the correct trade — fresh data over fast-but-wrong.
            // The `campfire-api` bucket is global across sign-ins, so it is
            // purged at every auth-identity change (see lib/swCache.ts) to keep
            // one account's data from ever bleeding into another's.
            //
            // PROVEN-LIVE EXCLUSION (issue #579): `/me` and `/auth/*` are the
            // identity channel and MUST NOT be served from this cache. The
            // browser's `navigator.onLine` only reflects the network interface,
            // not whether a response actually reached the server — so when the
            // router is up but Campfire is down, NetworkFirst would silently
            // fall back to a cached `/me` and AuthProvider would mistake that
            // stale identity for a live one, wiping the offline cache. By keeping
            // `/me` out of the SW cache entirely, a successful `/me` is
            // guaranteed to be proven-live (and a failure is a real failure).
            // The last-known identity is persisted separately by lib/swCache.ts
            // so an offline reload can still render the authed UI, clearly marked
            // as stale, without ever confusing a cached body with a live one.
            //
            // Attachment bytes and role/fog-specific VTT renders must never enter
            // the shared offline API cache. A previously revealed map served while
            // offline after the DM re-hid it would be a secrecy leak (#463).
            urlPattern: ({ url, request }) => {
              if (request.method !== "GET") return false;
              if (!url.pathname.startsWith("/api/")) return false;
              if (
                url.pathname === "/api/v1/me"
                || url.pathname.startsWith("/api/v1/auth/")
              ) {
                return false;
              }
              if (/^\/api\/v1\/attachments\/\d+\/file$/.test(url.pathname)) return false;
              if (/^\/api\/v1\/encounters\/\d+\/map$/.test(url.pathname)) return false;
              return true;
            },
            handler: "NetworkFirst",
            options: {
              cacheName: "campfire-api",
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Full game-icons.net catalog body shards (issue #349) —
            // apps/web/public/icons/shards/shard-NNN.json, fetched on demand by
            // lib/icons/index.ts#resolveIcon for any non-curated icon. The shard
            // URLs are NOT content-addressed: a shard's contents are position-in-
            // sorted-slug-list ÷ 100, so regenerating the icon set reshuffles which
            // icons land in shard-NNN.json while the URL stays the same. Under
            // CacheFirst + a 365-day TTL an installed PWA would then serve a stale
            // shard forever and silently show wrong/missing icons (issue #354).
            // StaleWhileRevalidate keeps the offline-first, no-repeat-cost behaviour
            // (cached shard served instantly) but revalidates in the background, so
            // any future icon-set regeneration self-heals on the next view.
            // Deliberately NOT in globPatterns above, so a fresh install/update
            // never downloads the ~6 MB of shards up front — only icons a user
            // actually views ever get fetched.
            urlPattern: ({ url }) => url.pathname.startsWith("/icons/shards/"),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "campfire-icon-shards",
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Keep the SW out of `vite dev` to avoid caching surprises while coding.
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/healthz": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/readyz": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
