import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Platform code never depends on business modules.
    files: ['src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/modules/**'], message: 'platform/ must not import business modules.' }] }],
    },
  },
  {
    // A module reaches another module only through its index.ts facade (no repositories, no services).
    files: ['src/modules/*/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^\\.\\./[^./][^/]*/(?!index\\.js$).+', message: 'Import other modules through their index.ts facade.' }] },
      ],
    },
  },
);
