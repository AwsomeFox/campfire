// Flat ESLint config (issue #561) — the lint gate was a permanent no-op with
// zero config in the repo; this is the server's real gate. Deliberately not
// type-checked (no `project` parserOptions) so it stays fast in CI and
// doesn't require every file to individually resolve under tsconfig's
// project references — `tsc --noEmit` (added alongside this in CI) is the
// type-checking gate; this is the syntax/pattern gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Issue #1703: two PRs can add the same name to a shared `import type` block
// and merge into a single declaration like `import type { A, A }` that tsc
// rejects with TS2300. ESLint's `no-duplicate-imports` only compares separate
// import declarations by source, so we add a local rule for duplicate
// specifiers inside one declaration.
const noDuplicateImportSpecifiers = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow duplicate local identifiers within a single import declaration.',
    },
    messages: {
      duplicate: "Duplicate import specifier '{{name}}' in the same import declaration.",
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const seen = new Map();
        for (const specifier of node.specifiers) {
          const name = specifier.local.name;
          if (seen.has(name)) {
            context.report({
              node: specifier,
              messageId: 'duplicate',
              data: { name },
            });
          } else {
            seen.set(name, specifier);
          }
        }
      },
    };
  },
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      campfire: {
        rules: {
          'no-duplicate-import-specifiers': noDuplicateImportSpecifiers,
        },
      },
    },
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
      // Conflicts with the common `let x = 0; try { x = ... } catch { continue; }`
      // pattern (safe default + skip-on-failure). Prefer keeping the default.
      'no-useless-assignment': 'off',
      // Issue #1703: identical-line merges into a shared `import type` block can
      // produce duplicate identifiers that only show up after merge. Catch them in
      // the lint gate rather than `tsc` / `nest build`.
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      // `no-duplicate-imports` compares whole declarations by source; it does not
      // see repeated specifiers inside one declaration (e.g. `import type { A, A }`).
      // This catches the exact TS2300 shape from issue #1702 before merge.
      'campfire/no-duplicate-import-specifiers': 'error',
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
    files: ['jest*.config.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
);
