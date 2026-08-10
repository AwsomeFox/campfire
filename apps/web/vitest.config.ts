import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { version as pkgVersion } from './package.json';
import { normalizeBasePrefix } from './src/lib/public-base';

/**
 * Component-render tier (issue #2025): jsdom + Testing Library, mounting a real
 * React component and asserting on its rendered DOM output. Deliberately
 * separate from `vite.config.ts` — the app build's PWA/Tailwind plugins have
 * nothing to do with a component-level render assertion, and pulling them in
 * here would only add cost and failure surface to this tier.
 *
 * Kept out of `e2e/tests` on purpose: that directory is the pure-logic /
 * source-scan Playwright tier (`playwright.unit.config.ts`,
 * `scripts/check-e2e-spec-coverage.mjs`) and browser Playwright tier
 * (`playwright.config.ts`); mixing a third runner's specs into it would put
 * `.spec.tsx` files in front of tooling that does not expect them.
 *
 * `define` mirrors the two build-time globals `vite.config.ts` stamps in
 * (review finding on PR #2033): without them, a component that reads
 * `__APP_VERSION__` directly (e.g. `MetricsCard`, the auth-page footers)
 * throws a `ReferenceError` under this separate config rather than under
 * `vite.config.ts`'s own `define`. `__PUBLIC_BASE__` is read only through a
 * `typeof` guard elsewhere (`src/lib/public-base.ts`) so it wouldn't throw
 * either way, but it's included for the same reason `vite.config.ts` defines
 * it — so a real deployment path and a test path never silently disagree on
 * what "the public base" is.
 * `appVersionDefine.spec.tsx` mounts `MetricsCard` (which reads
 * `__APP_VERSION__` directly in JSX) so this gap cannot reopen silently.
 */
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __PUBLIC_BASE__: JSON.stringify(normalizeBasePrefix(process.env.PUBLIC_BASE)),
  },
  test: {
    environment: 'jsdom',
    include: ['test/component/**/*.spec.tsx'],
    reporters: ['default'],
    // Same reasoning as `maxWorkers` in apps/server/jest.config.js: this pool
    // otherwise sizes itself against the whole machine, which is wrong when
    // several agent sessions share it. `scripts/with-test-lock.sh` sets the
    // variable for local runs; unset keeps vitest's own default.
    ...(process.env.VITEST_MAX_WORKERS
      ? { maxWorkers: Number(process.env.VITEST_MAX_WORKERS) }
      : {}),
  },
});
