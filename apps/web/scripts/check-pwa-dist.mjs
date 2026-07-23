#!/usr/bin/env node
/**
 * Guards issue #91: the "Works offline between sessions" install banner must be
 * backed by a real PWA. Asserts that a production build emits a valid web app
 * manifest, a service worker that precaches the app shell, the install icons,
 * and that index.html wires them up. Run after `vite build` (see `test:pwa`).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

if (!existsSync(dist)) {
  console.error(`dist/ not found at ${dist} — run \`vite build\` first.`);
  process.exit(1);
}

const read = (rel) => readFileSync(join(dist, rel), "utf8");

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
  check(
    sw.includes("campfire-api-images"),
    "sw.js should use the bounded campfire-api-images cache",
  );
  check(
    sw.includes("text/event-stream"),
    "sw.js should exclude text/event-stream from runtime caching",
  );
  check(
    sw.includes("/export") || sw.includes("export"),
    "sw.js should exclude export downloads from runtime caching",
  );
  check(
    sw.includes("/backup") || sw.includes("backup"),
    "sw.js should exclude backup downloads from runtime caching",
  );
}

// 4. index.html wires up the manifest, theme-color and apple-touch-icon.
const html = read("index.html");
check(/rel="manifest"/.test(html), "index.html missing <link rel=manifest>");
check(/name="theme-color"/.test(html), "index.html missing theme-color meta");
check(/rel="apple-touch-icon"/.test(html), "index.html missing apple-touch-icon link");

if (failures.length) {
  console.error("PWA dist check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("PWA dist check passed: manifest, service worker, icons and HTML links all present.");
