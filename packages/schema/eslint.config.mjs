// Flat ESLint config (issue #561) — the lint gate was a permanent no-op with
// zero config in the repo; this is the schema package's real gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Issue #1702/#1703: two PRs can add the same name to a shared `import type`
// block and merge into a single declaration that tsc rejects with TS2300.
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
          const kind = specifier.importKind || 'value';
          const key = `${name}:${kind}`;
          if (seen.has(key)) {
            context.report({
              node: specifier,
              messageId: 'duplicate',
              data: { name },
            });
          } else {
            seen.set(key, specifier);
          }
        }
      },
    };
  },
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
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
      // Zod schema builders intentionally use broad shapes in a few spots
      // (dynamic tool payloads, generic helpers) — keep this a warning rather
      // than blocking the build on pre-existing, deliberate uses.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Issue #1703: identical-line merges into a shared `import type` block can
      // produce duplicate identifiers that only show up after merge.
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      // `no-duplicate-imports` compares whole declarations by source; it does not
      // see repeated specifiers inside one declaration. This catches the exact
      // TS2300 shape from issue #1702 before merge.
      'campfire/no-duplicate-import-specifiers': 'error',
    },
  },
);
