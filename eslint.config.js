// Flat ESLint config. Two tiers:
//   · syntactic rules (typescript-eslint `recommended`) over every TS source
//   · type-aware promise rules (headline: no-floating-promises) over the code
//     that lives in a tsconfig — lib/server/bin (tsconfig.cli.json) and the
//     web app src/ (tsconfig.json)
// Plus react-hooks for the browser components. We deliberately skip the full
// `recommendedTypeChecked` set: the CLI uses `any` at JSON/subprocess
// boundaries on purpose (each one carries an eslint-disable), so the
// no-unsafe-* family would be pure noise here.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    // Generated CLI output (gitignored), build artifacts, and deps.
    ignores: [
      'dist/**',
      'node_modules/**',
      'lib/**/*.js',
      'server/**/*.js',
      'bin/**/*.js',
      '**/*.d.ts',
    ],
  },

  // Base syntactic rules for all TypeScript.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Type-aware promise safety for everything that sits in a tsconfig.
  {
    files: ['lib/**/*.ts', 'server/**/*.ts', 'bin/**/*.ts', 'src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        // lib/server/bin live in tsconfig.cli.json; the web app in tsconfig.json.
        project: ['./tsconfig.cli.json', './tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // Allow `const { drop, ...rest } = obj` to omit a key by destructuring.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },

  // Node CLI: long-lived process globals.
  {
    files: ['lib/**/*.ts', 'server/**/*.ts', 'bin/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Browser app + React hooks.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
);
