import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { version as pkgVersion } from "./package.json";

export default defineConfig({
  // Single-source the app version from package.json so signed-out surfaces
  // (e.g. the login footer) report the real build version without an authed
  // /admin/metrics call, and can never drift from the published version.
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
        orientation: "portrait",
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
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith("/api/") && request.method === "GET",
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
            // lib/icons/index.ts#resolveIcon for any non-curated icon. These are
            // static/content-addressed by build (regenerated wholesale, not
            // patched), so cache-as-you-go (CacheFirst) is correct: once a shard
            // is fetched, every icon in it renders offline from then on, with no
            // repeat network cost. Deliberately NOT in globPatterns above, so a
            // fresh install/update never downloads the ~6 MB of shards up front —
            // only icons a user actually views ever get fetched.
            urlPattern: ({ url }) => url.pathname.startsWith("/icons/shards/"),
            handler: "CacheFirst",
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
