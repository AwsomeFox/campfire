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
  // Issue #797: portrait lock blocked landscape for maps / AI table / player display.
  // Allow omitting orientation or setting it to "any"; reject any portrait* lock.
  const orientation = m.orientation;
  check(
    orientation == null
      || orientation === "any"
      || (typeof orientation === "string" && !orientation.includes("portrait")),
    `manifest.orientation must not lock portrait (got ${JSON.stringify(orientation)})`,
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
