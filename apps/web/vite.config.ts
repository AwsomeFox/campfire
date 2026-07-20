import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
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
            // Read-only GETs (e.g. campaign summary) stay available offline
            // by serving the last successful response from cache.
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith("/api/") && request.method === "GET",
            handler: "NetworkFirst",
            options: {
              cacheName: "campfire-api",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
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
