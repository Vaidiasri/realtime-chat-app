import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', '**/node_modules/', 'coverage/', '.playwright-mcp/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Type aware rules only where a tsconfig covers the file.
    files: ['{shared,server,client}/src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Express 5 forwards rejected async handlers, so async callbacks there are fine.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
      // Empty interfaces are placeholders (Database, socket event maps) filled per feature.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  { files: ['server/**', 'shared/**', '*.js'], languageOptions: { globals: globals.node } },
  {
    files: ['client/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
  },
  prettier,
);
