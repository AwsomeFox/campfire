import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

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
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/component/**/*.spec.tsx'],
    reporters: ['default'],
  },
});
