// eslint.config.js
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  // Build output keeps source comments (eslint-disable lines for TS rules); never lint it.
  { ignores: ['dist/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tsParser },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'error',
    },
  },
];
