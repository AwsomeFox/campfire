// Flat ESLint config (issue #561) — the lint gate was a permanent no-op with
// zero config in the repo; this is the web app's real gate. Not type-checked
// (no `project` parserOptions) so it stays fast; `tsc -b` (build) and
// `tsc -p e2e/tsconfig.json` (test:e2e:typecheck) are the type-checking gates.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, __APP_VERSION__: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Only the two classic, long-stable hooks rules — eslint-plugin-react-hooks
      // v7's `recommended` config also bundles the brand-new React Compiler
      // rule-set (set-state-in-effect, refs, purity, static-components, …) as
      // hard errors. Those flag *hundreds* of pre-existing, working patterns
      // across this codebase (which predates the Compiler and isn't opting
      // into it) and are out of scope for standing up this lint gate.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Vite's fast-refresh boundary rule — several files intentionally
      // export a small helper/constant alongside a component (translation
      // maps, context hooks). Warn rather than block the build on those.
      'react-refresh/only-export-components': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Playwright fixtures/mocks lean on `any` more than app code.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Plain Node scripts (the Playwright static file server, build-output
    // checks run via `node`) — not part of the browser app bundle.
    files: ['e2e/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
