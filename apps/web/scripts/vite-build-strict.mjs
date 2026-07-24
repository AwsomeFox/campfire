#!/usr/bin/env node
/**
 * Issue #433: run `vite build` and fail CI when the CSS optimizer reports
 * unexpected warnings (e.g. nested `@import` after generated rules). Also
 * asserts the production bundle self-hosts Inter instead of Google Fonts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(webRoot, "dist");

const result = spawnSync("npx", ["vite", "build"], {
  cwd: webRoot,
  encoding: "utf8",
  env: process.env,
  shell: false,
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const failures = [];

if (/warning while optimizing generated CSS/i.test(output)) {
  failures.push("Vite reported CSS optimizer warning(s) during build.");
}
if (/@import rules must precede/i.test(output)) {
  failures.push("Build emitted an `@import must precede other statements` warning.");
}
if (/fonts\.googleapis\.com/i.test(output)) {
  failures.push("Build output referenced fonts.googleapis.com (fonts must be self-hosted).");
}

const cssFiles = existsSync(join(dist, "assets"))
  ? readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".css"))
  : [];
if (cssFiles.length === 0) {
  failures.push("No CSS assets found in dist/assets after build.");
}

let bundledCss = "";
for (const file of cssFiles) {
  bundledCss += readFileSync(join(dist, "assets", file), "utf8");
}

if (/fonts\.googleapis\.com/i.test(bundledCss)) {
  failures.push("Bundled CSS still references fonts.googleapis.com.");
}
if (/@import\s+url\s*\(\s*['"]?https?:/i.test(bundledCss)) {
  failures.push("Bundled CSS contains an external `@import url(...)`.");
}
if (!/@font-face/i.test(bundledCss) || !/font-family:\s*['"]?Inter['"]?/i.test(bundledCss)) {
  failures.push("Bundled CSS is missing self-hosted Inter `@font-face` rules.");
}

const assetFiles = existsSync(join(dist, "assets")) ? readdirSync(join(dist, "assets")) : [];
const hasWoff2 = assetFiles.some((f) => f.endsWith(".woff2"));
if (!hasWoff2) {
  failures.push("No .woff2 font assets were emitted (Inter should be bundled for offline use).");
}

// Source guard: keep Google Fonts @import out of the web CSS entrypoints.
for (const rel of ["src/index.css", "src/nocturne.css"]) {
  const src = readFileSync(join(webRoot, rel), "utf8");
  if (/fonts\.googleapis\.com/i.test(src) || /@import\s+url\s*\(\s*['"]?https?:\/\//i.test(src)) {
    failures.push(`${rel} must not @import remote fonts (use @fontsource/inter in main.tsx).`);
  }
}

if (failures.length) {
  console.error("CSS/font build check FAILED (issue #433):");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  "CSS/font build check passed: no CSS optimizer warnings, Inter self-hosted, no remote @import.",
);
