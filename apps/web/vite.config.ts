import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { version as pkgVersion } from "./package.json";
import {
  API_CACHE_MAX_AGE_SECONDS,
  API_IMAGE_CACHE_NAME,
  API_IMAGE_MAX_ENTRIES,
  API_JSON_CACHE_NAME,
  API_JSON_MAX_ENTRIES,
  API_NETWORK_TIMEOUT_SECONDS,
  cacheWillUpdateImage,
  cacheWillUpdateJson,
  matchApiImageCache,
  matchApiJsonCache,
  matchIconShardCache,
  matchNetworkOnlyApi,
} from "./src/lib/pwaCachePolicy";
import { normalizeBasePrefix } from "./src/lib/public-base";

/**
 * Reverse-proxy subpath (issue #798).
 *
 * `PUBLIC_BASE` is the single setting that drives every path the SPA emits.
 * The operator sets it once in their environment; the Docker build stamps it
 * into the image via `ARG PUBLIC_BASE` (see Dockerfile), and `vite build`
 * picks it up from `process.env` here. Root deployments (the default) leave
 * it `/` — every path is then identical to the pre-#798 behavior.
 *
 * The proxy contract is "strip prefix, then forward": the reverse proxy
 * terminates `https://host/campfire/...` and forwards to this origin AFTER
 * stripping `/campfire`. So the SERVER's routing never sees the prefix; only
 * the browser-facing assets/manifest/SW/router/API client need to know about
 * it. See apps/web/src/lib/public-base.ts for the full contract.
 */
const PUBLIC_BASE = normalizeBasePrefix(process.env.PUBLIC_BASE);
const HAS_SUBPATH = PUBLIC_BASE !== "/";
// Vite's `base` must end with `/` (it's joined to asset paths like `assets/x.js`).
// Our canonical prefix never ends with `/` (except the bare root), so append one.
const viteBase = PUBLIC_BASE === "/" ? "/" : `${PUBLIC_BASE}/`;

/**
 * Build a regex that matches a path PREFIXED with the public base — used by
 * the service-worker navigate-fallback deny list and runtime-caching guards so
 * that, e.g. `/campfire/api/...` is correctly excluded from the SPA shell even
 * though the SW itself is scoped to `/campfire/`. The patterns are anchored to
 * the START of the pathname so a trailing path segment can't accidentally match
 * (e.g. `/api` must not deny `/foo/api`).
 *
 * Root deployments get the historical `/^\/api/` style patterns unchanged.
 */
function denyPath(suffix: string): RegExp {
  if (PUBLIC_BASE === "/") {
    return new RegExp(`^${suffix}`);
  }
  const escaped = PUBLIC_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = suffix.replace(/^\//, "");
  return new RegExp(`^${escaped}/${tail}`);
}

/** Strip the public base from a dev-proxy path without regex metachar surprises. */
function stripPublicBase(path: string): string {
  if (path.startsWith(PUBLIC_BASE)) return path.slice(PUBLIC_BASE.length) || "/";
  return path;
}

export default defineConfig({
  // Single-source the app version from apps/web/package.json (kept equal to the
  // root/server package.json by scripts/check-version-sync.mjs + the Docker
  // APP_VERSION stamp) so signed-out surfaces (e.g. the login footer) report
  // the real build version without an authed /admin/metrics call (issue #432).
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    // Stamp the normalized public base into the bundle as a string literal so
    // the runtime API client / router / SW can read it without re-parsing env.
    __PUBLIC_BASE__: JSON.stringify(PUBLIC_BASE),
  },
  // Issue #798: deploy under a reverse-proxy subpath. Vite rewrites every
  // emitted asset/chunk URL to `${base}assets/...` and rewrites index.html's
  // script/style/link hrefs to the same prefix, so the browser fetches
  // `/campfire/assets/...` instead of `/assets/...`. Root: base is `/`.
  base: viteBase,
  // Issue #462: split the ~1MB main chunk into vendor + app chunks for better
  // caching and faster initial load on low-end mobile. The main chunk drops
  // below 500KB and vendors (react, router, etc.) cache separately.
  build: {
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/react-router-dom/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/marked/') || id.includes('node_modules/dompurify/')) {
            return 'vendor-markdown';
          }
          if (id.includes('node_modules/@dnd-kit/')) {
            return 'vendor-dnd';
          }
          // three is only reached through the dice overlay's dynamic import, so
          // it never lands in the entry chunk — pinning it to its own vendor
          // chunk keeps it out of the lazy route chunks too, and lets the
          // service worker keep one cached copy across releases that don't
          // bump three itself.
          if (id.includes('node_modules/three/')) {
            return 'vendor-three';
          }
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
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
        // AI table, and player display need landscape on tablets/phones.
        orientation: "any",
        // Issue #798: scope/start_url must be prefixed so the install lives
        // UNDER the public base — otherwise a subpath deployment's PWA scope
        // would escape to the origin root. Root: unchanged (`/`).
        scope: viteBase,
        start_url: viteBase,
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
        // Local terser minification of the generated SW can fail intermittently
        // (workbox-build renderChunk); development mode skips minify. Production
        // CI images omit this env var so the SW ships minified.
        ...(process.env.VITE_PWA_DEV_SW === "1" ? { mode: "development" as const } : {}),
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [
          denyPath("/api"),
          denyPath("/healthz"),
          denyPath("/readyz"),
        ],
        cleanupOutdatedCaches: true,
        importScripts: ["sw-sensitive-purge.js"],
        runtimeCaching: [
          {
            urlPattern: matchNetworkOnlyApi,
            handler: "NetworkOnly",
          },
          {
            urlPattern: matchApiImageCache,
            handler: "NetworkFirst",
            options: {
              cacheName: API_IMAGE_CACHE_NAME,
              networkTimeoutSeconds: API_NETWORK_TIMEOUT_SECONDS,
              expiration: {
                maxEntries: API_IMAGE_MAX_ENTRIES,
                maxAgeSeconds: API_CACHE_MAX_AGE_SECONDS,
              },
              cacheableResponse: { statuses: [0, 200] },
              plugins: [{ cacheWillUpdate: cacheWillUpdateImage }],
            },
          },
          {
            urlPattern: matchApiJsonCache,
            handler: "NetworkFirst",
            options: {
              cacheName: API_JSON_CACHE_NAME,
              networkTimeoutSeconds: API_NETWORK_TIMEOUT_SECONDS,
              expiration: {
                maxEntries: API_JSON_MAX_ENTRIES,
                maxAgeSeconds: API_CACHE_MAX_AGE_SECONDS,
              },
              cacheableResponse: { statuses: [0, 200] },
              plugins: [{ cacheWillUpdate: cacheWillUpdateJson }],
            },
          },
          {
            urlPattern: matchIconShardCache,
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
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      [HAS_SUBPATH ? `${PUBLIC_BASE}/api` : "/api"]: {
        target: "http://localhost:8080",
        changeOrigin: true,
        rewrite: HAS_SUBPATH ? stripPublicBase : undefined,
      },
      [HAS_SUBPATH ? `${PUBLIC_BASE}/healthz` : "/healthz"]: {
        target: "http://localhost:8080",
        changeOrigin: true,
        rewrite: HAS_SUBPATH ? stripPublicBase : undefined,
      },
      [HAS_SUBPATH ? `${PUBLIC_BASE}/readyz` : "/readyz"]: {
        target: "http://localhost:8080",
        changeOrigin: true,
        rewrite: HAS_SUBPATH ? stripPublicBase : undefined,
      },
    },
  },
});
