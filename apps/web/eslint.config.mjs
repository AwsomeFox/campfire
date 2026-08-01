// Flat ESLint config (issue #561) — the lint gate was a permanent no-op with
// zero config in the repo; this is the web app's real gate. Not type-checked
// (no `project` parserOptions) so it stays fast; `tsc -b` (build) and
// `tsc -p e2e/tsconfig.json` (test:e2e:typecheck) are the type-checking gates.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

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

const noBareToLocaleString = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow .toLocaleString(), .toLocaleTimeString(), and .toLocaleDateString() calls in apps/web/src. Use formatters from src/lib/format.',
    },
    messages: {
      noBare:
        'Do not use .toLocaleString(), .toLocaleTimeString(), or .toLocaleDateString() directly. Use formatNumber, formatDateTime, formatDate, or formatTime from src/lib/format instead.',
    },
    schema: [],
  },
  create(context) {
    const BANNED_METHODS = new Set(['toLocaleString', 'toLocaleTimeString', 'toLocaleDateString']);
    return {
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          !node.callee.computed &&
          node.callee.property.type === 'Identifier' &&
          BANNED_METHODS.has(node.callee.property.name)
        ) {
          const filename = (context.filename || context.getFilename?.() || '').replace(/\\/g, '/');
          if (filename.includes('lib/format.ts') || filename.includes('/e2e/')) return;

          context.report({
            node,
            messageId: 'noBare',
          });
        }
      },
    };
  },
};

const noBareCardClass = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow bare ".card" CSS class in JSX className strings (issue #1712). Use <Card density="compact"> or <Card> component from components/ui instead.',
    },
    messages: {
      noBareCard:
        'Do not use bare ".card" class in className. Use <Card density="compact"> or <Card> component from components/ui instead.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? (typeof context.getFilename === 'function' ? context.getFilename() : '');
    if (filename.includes('features/auth') || filename.includes('CharacterPage')) return {};

    const BARE_CARD_REGEX = /(?<![a-zA-Z0-9_-])card(?![a-zA-Z0-9_-])/;

    function checkValue(node, value) {
      if (typeof value === 'string' && BARE_CARD_REGEX.test(value)) {
        context.report({
          node,
          messageId: 'noBareCard',
        });
      }
    }

    return {
      JSXAttribute(node) {
        if (node.name.name !== 'className') return;
        const val = node.value;
        if (!val) return;
        if (val.type === 'Literal') {
          checkValue(val, val.value);
        } else if (val.type === 'JSXExpressionContainer') {
          const expr = val.expression;
          if (expr.type === 'Literal') {
            checkValue(expr, expr.value);
          } else if (expr.type === 'TemplateLiteral') {
            for (const quasi of expr.quasis) {
              checkValue(quasi, quasi.value.raw);
            }
          } else if (expr.type === 'ConditionalExpression') {
            if (expr.consequent.type === 'Literal') checkValue(expr.consequent, expr.consequent.value);
            if (expr.alternate.type === 'Literal') checkValue(expr.alternate, expr.alternate.value);
          }
        }
      },
    };
  },
};

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
      campfire: {
        rules: {
          'no-duplicate-import-specifiers': noDuplicateImportSpecifiers,
          'no-bare-tolocalestring': noBareToLocaleString,
          'no-bare-card-class': noBareCardClass,
        },
      },
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
      // Issue #1703: identical-line merges into a shared `import type` block can
      // produce duplicate identifiers that only show up after merge.
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      // `no-duplicate-imports` compares whole declarations by source; it does not
      // see repeated specifiers inside one declaration. This catches the exact
      // TS2300 shape from issue #1702 before merge.
      'campfire/no-duplicate-import-specifiers': 'error',
      'campfire/no-bare-tolocalestring': 'error',
      'campfire/no-bare-card-class': 'error',
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
