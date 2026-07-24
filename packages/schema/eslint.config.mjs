// Flat ESLint config (issue #561) — the lint gate was a permanent no-op with
// zero config in the repo; this is the schema package's real gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Zod schema builders intentionally use broad shapes in a few spots
      // (dynamic tool payloads, generic helpers) — keep this a warning rather
      // than blocking the build on pre-existing, deliberate uses.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
