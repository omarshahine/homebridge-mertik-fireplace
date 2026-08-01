import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

// Flat config (ESLint 10). Ported from the old .eslintrc — ESLint removed the
// core formatting rules, so those now come from @stylistic under its own prefix.
export default tseslint.config(
  {
    ignores: ['dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {
      '@stylistic': stylistic,
    },
    languageOptions: {
      ecmaVersion: 2018,
      sourceType: 'module',
    },
    rules: {
      '@stylistic/quotes': ['warn', 'single'],
      '@stylistic/indent': ['warn', 2, { SwitchCase: 1 }],
      '@stylistic/semi': ['warn'],
      '@stylistic/member-delimiter-style': ['warn'],
      '@stylistic/comma-dangle': ['warn', 'always-multiline'],
      '@stylistic/brace-style': ['warn'],
      '@stylistic/comma-spacing': ['error'],
      '@stylistic/no-multi-spaces': ['warn', { ignoreEOLComments: true }],
      '@stylistic/no-trailing-spaces': ['warn'],
      '@stylistic/lines-between-class-members': ['warn', 'always', { exceptAfterSingleLine: true }],
      '@stylistic/max-len': ['warn', 140],
      'dot-notation': 'off',
      'eqeqeq': 'warn',
      'curly': ['warn', 'all'],
      'prefer-arrow-callback': ['warn'],
      'no-console': ['warn'], // use the provided Homebridge log method instead
      // Params kept for signature symmetry are opted out with a leading underscore.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
);
