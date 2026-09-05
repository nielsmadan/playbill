import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      '.spike-runs/**',
      '.test-runs-*/**',
      'docs/spikes/**',
      'docs/plans/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
