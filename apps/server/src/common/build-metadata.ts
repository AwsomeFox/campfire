/**
 * Single source of truth for the running Campfire build identity (issue #432).
 *
 * Semver comes from apps/server/package.json — the same file Docker's
 * APP_VERSION stamp rewrites before `npm ci`, and the same value CI asserts is
 * equal across every workspace package.json, the login footer (__APP_VERSION__),
 * OpenAPI, MCP server-info, /healthz, /auth/status, and /admin/metrics.
 *
 * Optional commit/build metadata is injected at image build time via APP_COMMIT
 * (or GIT_COMMIT) so operators can tell two same-semver images apart.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PKG_VERSION: string = require('../../package.json').version;

export const APP_VERSION: string = PKG_VERSION;

/** Short git SHA (or other build id) when the image/build stamped one; otherwise null. */
export const APP_COMMIT: string | null = (() => {
  const raw = process.env.APP_COMMIT?.trim() || process.env.GIT_COMMIT?.trim() || '';
  return raw.length > 0 ? raw : null;
})();

export type BuildMetadata = {
  version: string;
  commit?: string;
};

/** Version (+ optional commit) for surfaces that can carry build provenance. */
export function buildMetadata(): BuildMetadata {
  return APP_COMMIT ? { version: APP_VERSION, commit: APP_COMMIT } : { version: APP_VERSION };
}
