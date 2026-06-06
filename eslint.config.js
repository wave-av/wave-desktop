// eslint.config.js — flat config (ESLint 9)
// Non-type-checked for speed; ignores build output.
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = tseslint.config(
  // Global ignores
  {
    ignores: [
      'out/**',
      'release/**',
      'dist/**',
      'node_modules/**',
      '*.config.js',
      '*.config.ts',
    ],
  },

  // JS recommended base
  js.configs.recommended,

  // TypeScript recommended (non-type-checked — fast, low noise)
  ...tseslint.configs.recommended,

  // React Hooks
  {
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // Project-wide settings
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
    },
  },
);
