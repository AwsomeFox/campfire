// Flat ESLint config (issue #561) — the lint gate was a permanent no-op with
// zero config in the repo; this is the server's real gate. Deliberately not
// type-checked (no `project` parserOptions) so it stays fast in CI and
// doesn't require every file to individually resolve under tsconfig's
// project references — `tsc --noEmit` (added alongside this in CI) is the
// type-checking gate; this is the syntax/pattern gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // NestJS providers/DTOs lean on `any` at a handful of deliberate
      // boundaries (dynamic MCP tool args, generic adapters) — warn, don't block.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Decorator-only classes and empty lifecycle-hook overrides are normal
      // NestJS shapes, not bugs.
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // A handful of modules deliberately use runtime `require()` (optional/
      // conditional CJS interop with better-sqlite3 native bindings, reading
      // package.json for version info, etc.) — long predates this lint gate
      // and isn't worth rewriting import-time.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Test doubles/mocks legitimately use `any` far more than production code.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Plain Node/CommonJS infra scripts (jest config, worker helpers spawned
    // via `node`) — not part of the TS app graph, so they get Node globals
    // instead of the app's default (browser-less, TS-checked) environment.
    files: ['jest.config.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
);
