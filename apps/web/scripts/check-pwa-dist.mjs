#!/usr/bin/env node
/**
 * Guards issue #91: the "Works offline between sessions" install banner must be
 * backed by a real PWA. Asserts that a production build emits a valid web app
 * manifest, a service worker that precaches the app shell, the install icons,
 * and that index.html wires them up. Run after `vite build` (see `test:pwa`).
 *
 * Issue #798: when PUBLIC_BASE is set, additionally asserts the prefix is
 * consistently applied to Vite's `base` (asset/chunk URLs in index.html), the
 * manifest's scope/start_url, and the service worker's navigate-fallback deny
 * patterns — the single setting must drive every browser-facing path.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Issue #798: the dist directory can be overridden (e.g. to check a subpath
// build at dist-subpath without clobbering the root build). Defaults to dist.
const dist = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  process.env.PWA_DIST_DIR || "dist",
);
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

if (!existsSync(dist)) {
  console.error(`dist/ not found at ${dist} — run \`vite build\` first.`);
  process.exit(1);
}

const read = (rel) => readFileSync(join(dist, rel), "utf8");

/**
 * Issue #798: derive the normalized public base from the build's env so the
 * checks below match what vite.config.ts actually baked in. Mirrors the
 * canonicalization in apps/web/src/lib/public-base.ts: leading slash, no
 * trailing slash (except bare root), host portion dropped from URLs.
 */
function normalizeBasePrefix(input) {
  const trimmed = (input ?? "").trim();
  if (trimmed === "") return "/";
  let pathname = trimmed;
  try {
    if (/^https?:\/\//i.test(pathname) || pathname.startsWith("//")) {
      pathname = new URL(pathname).pathname;
    }
  } catch {
    // leave as-is
  }
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/+/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  return pathname === "" ? "/" : pathname;
}
const PUBLIC_BASE = normalizeBasePrefix(process.env.PUBLIC_BASE);
const HAS_SUBPATH = PUBLIC_BASE !== "/";
// Vite's base always carries a trailing slash (it's joined to `assets/x.js`).
const viteBase = PUBLIC_BASE === "/" ? "/" : `${PUBLIC_BASE}/`;

// 1. Required install icons + apple-touch-icon are present.
for (const f of [
  "pwa-192x192.png",
  "pwa-512x512.png",
  "maskable-512x512.png",
  "apple-touch-icon.png",
]) {
  check(existsSync(join(dist, f)), `missing icon: ${f}`);
}

// 2. Manifest exists and declares an installable standalone app.
check(existsSync(join(dist, "manifest.webmanifest")), "missing manifest.webmanifest");
if (existsSync(join(dist, "manifest.webmanifest"))) {
  const m = JSON.parse(read("manifest.webmanifest"));
  check(m.name === "Campfire", "manifest.name should be Campfire");
  check(!!m.short_name, "manifest.short_name missing");
  check(m.display === "standalone", "manifest.display should be standalone");
  // Issue #797: orientation locks blocked free rotation for maps / AI table / player
  // display. Allow omitting orientation or setting it exactly to "any"; reject every
  // other value (including landscape* locks).
  const orientation = m.orientation;
  check(
    orientation == null || orientation === "any",
    `manifest.orientation must be omitted or "any" (got ${JSON.stringify(orientation)})`,
  );
  check(/^#/.test(m.theme_color || ""), "manifest.theme_color missing");
  check(/^#/.test(m.background_color || ""), "manifest.background_color missing");
  check(Array.isArray(m.icons) && m.icons.length >= 2, "manifest needs >=2 icons");
  check(
    m.icons?.some((i) => i.purpose === "maskable"),
    "manifest needs a maskable icon",
  );
  check(
    m.icons?.some((i) => (i.sizes || "").includes("512")),
    "manifest needs a 512px icon",
  );
}

// 3. Service worker is emitted and precaches the offline app shell.
check(existsSync(join(dist, "sw.js")), "missing sw.js (service worker not emitted)");
if (existsSync(join(dist, "sw.js"))) {
  const sw = read("sw.js");
  check(sw.includes("index.html"), "sw.js should precache the app shell (index.html)");
  check(
    /precache/i.test(sw) || /workbox/i.test(sw),
    "sw.js should use workbox precaching",
  );
  // Issue #879: streams / exports / backups stay NetworkOnly; JSON and image
  // thumbs use separate bounded buckets (never the legacy single campfire-api).
  check(
    /NetworkOnly/i.test(sw) || /networkOnly/i.test(sw),
    "sw.js should register NetworkOnly for SSE/export/backup exclusions",
  );
  check(
    sw.includes("campfire-api-json"),
    "sw.js should use the bounded campfire-api-json cache",
  );
  // The 3D dice roller is fetched on first roll, not pushed to every table on
  // install: precaching it would hand ~517KB of three.js to tables that never
  // roll, which is the download its dynamic import exists to avoid. Asserted on
  // the BUILT worker because the vite config and the runtime matcher can drift
  // apart without either looking wrong on its own.
  const precacheManifest = sw.slice(0, sw.indexOf("registerRoute"));
  check(
    !/vendor-three-[^"]*\.js/.test(precacheManifest),
    "sw.js should not precache the three.js chunk (it is fetched on demand)",
  );
  check(
    !/dice3d-[^"]*\.js/.test(precacheManifest),
    "sw.js should not precache the dice roller chunk (it is fetched on demand)",
  );
  check(
    sw.includes("campfire-dice-roller"),
    "sw.js should runtime-cache the dice roller chunks so a table that has rolled keeps them offline",
  );
  check(
    sw.includes("campfire-api-images"),
    "sw.js should use the bounded campfire-api-images cache",
  );
  check(
    sw.includes("text/event-stream"),
    "sw.js should exclude text/event-stream from runtime caching",
  );
  // Prefer path-aware markers over bare "export"/"backup" substrings (bundlers
  // often emit `exports` / unrelated backup text that would false-positive).
  check(
    sw.includes("/export"),
    "sw.js should exclude /export path downloads from runtime caching",
  );
  check(
    sw.includes("/api/v1/backup"),
    "sw.js should exclude /api/v1/backup from runtime caching",
  );
  // Issue #730: activate purge script + no-store / allowlist markers.
  check(
    existsSync(join(dist, "sw-sensitive-purge.js")),
    "missing sw-sensitive-purge.js (activate purge for sensitive caches)",
  );
  check(
    sw.includes("sw-sensitive-purge.js") || /importScripts/i.test(sw),
    "sw.js should importScripts sw-sensitive-purge.js for activate hygiene",
  );
  check(
    sw.includes("no-store") || sw.includes("bno-store"),
    "sw.js should reject Cache-Control: no-store in cacheWillUpdate",
  );
  check(
    sw.includes("/api/v1/shared/") || sw.includes("shared/"),
    "sw.js should NetworkOnly-exclude capability shared/ recap URLs",
  );
}

// 4. index.html wires up the manifest, theme-color and apple-touch-icon.
const html = read("index.html");
check(/rel="manifest"/.test(html), "index.html missing <link rel=manifest>");
check(/name="theme-color"/.test(html), "index.html missing theme-color meta");
check(/rel="apple-touch-icon"/.test(html), "index.html missing apple-touch-icon link");

// 5. Issue #798 — reverse-proxy subpath consistency. When PUBLIC_BASE is set,
//    every browser-facing path must carry the prefix: Vite's base (asset URLs
//    in index.html), the manifest's scope/start_url, and the SW's navigate-
//    fallback deny patterns. Root deployments skip this section entirely.
if (HAS_SUBPATH) {
  // 5a. Vite rewrote every asset URL in index.html to start with the prefix.
  //     The script tag's src is the clearest signal — under /campfire it is
  //     `/campfire/assets/index-<hash>.js`, never `/assets/...`.
  const assetSrcPattern = new RegExp(
    `src="${PUBLIC_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/assets/`,
  );
  check(
    assetSrcPattern.test(html),
    `index.html asset URLs should be prefixed with ${PUBLIC_BASE}/ (issue #798)`,
  );
  // And there should be NO un-prefixed /assets/ references left behind.
  check(
    !/src="\/assets\//.test(html) && !/href="\/assets\//.test(html),
    "index.html should not contain any un-prefixed /assets/ references (issue #798)",
  );

  // 5b. Manifest scope/start_url live UNDER the prefix so the install only
  //     controls the subpath (a root scope would capture unrelated routes or
  //     fail to install under the proxy).
  if (existsSync(join(dist, "manifest.webmanifest"))) {
    const m = JSON.parse(read("manifest.webmanifest"));
    check(
      m.scope === viteBase,
      `manifest.scope should be ${viteBase} under PUBLIC_BASE=${PUBLIC_BASE} (issue #798)`,
    );
    check(
      m.start_url === viteBase,
      `manifest.start_url should be ${viteBase} under PUBLIC_BASE=${PUBLIC_BASE} (issue #798)`,
    );
  }

  // 5c. SW navigate-fallback deny list must be anchored to the prefix so that,
  //      e.g. /campfire/api/... is excluded from the SPA shell fallback. The
  //      patterns are regex source; under /campfire the deny list contains a
  //      pattern starting with \/campfire\/api.
  if (existsSync(join(dist, "sw.js"))) {
    const sw = read("sw.js");
    const escapedPrefix = PUBLIC_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const apiDenyPattern = new RegExp(`${escapedPrefix}\\\\/api`);
    check(
      apiDenyPattern.test(sw),
      `sw.js navigate-fallback deny list should be prefixed with ${PUBLIC_BASE} (issue #798)`,
    );
  }
} else {
  // Root deployment sanity: index.html asset URLs must NOT carry a prefix.
  check(
    /src="\/assets\//.test(html) || /href="\/assets\//.test(html),
    "root deployment: index.html should reference /assets/ without a prefix (issue #798)",
  );
}

if (failures.length) {
  console.error("PWA dist check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  HAS_SUBPATH
    ? `PWA dist check passed (PUBLIC_BASE=${PUBLIC_BASE}): manifest, service worker, icons, HTML links, and subpath prefixing all present.`
    : "PWA dist check passed: manifest, service worker, icons and HTML links all present.",
);
